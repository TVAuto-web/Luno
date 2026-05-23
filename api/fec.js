function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const json = (res, status, body) => res.status(status).json(body);

function clean(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\t/g, ' ')
    .trim();
}

function date8(value) {
  const raw = String(value || '').slice(0, 10);
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  const fr = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (fr) return `${fr[3]}${fr[2]}${fr[1]}`;
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function amount(value) {
  const n = Math.abs(Number(value || 0));
  return Number.isFinite(n) ? n.toFixed(2).replace('.', ',') : '0,00';
}

function normalizeEntry(entry = {}, index) {
  const debitAccount = entry.cpd || entry.deb || entry.compteDebit || '';
  const creditAccount = entry.cpc || entry.cre || entry.compteCredit || '';
  const journalCode = clean(entry.jnl || entry.journal || 'OD').slice(0, 20);
  const journalLib = {
    VE: 'Ventes',
    AC: 'Achats',
    BQ: 'Banque',
    OD: 'Operations diverses',
  }[journalCode] || journalCode;
  const piece = clean(entry.pj || entry.piece || entry.ref || `ECR-${index + 1}`);
  const lib = clean(entry.lib || entry.label || 'Ecriture comptable');
  const mnt = Number(entry.mnt || entry.amount || 0);
  const date = date8(entry.date);
  const ecritureNum = clean(entry.num || `LUNO-${String(index + 1).padStart(6, '0')}`);
  return {
    journalCode,
    journalLib,
    ecritureNum,
    date,
    piece,
    pieceDate: date,
    lib,
    debitAccount: clean(debitAccount),
    creditAccount: clean(creditAccount),
    amount: mnt,
  };
}

function validate(entries) {
  const issues = [];
  const warnings = [];
  entries.forEach((entry, index) => {
    if (!entry.date) issues.push(`Ligne ${index + 1}: date manquante`);
    if (!entry.debitAccount || !entry.creditAccount) issues.push(`Ligne ${index + 1}: compte debit ou credit manquant`);
    if (!entry.amount) issues.push(`Ligne ${index + 1}: montant nul`);
    if (!entry.piece) warnings.push(`Ligne ${index + 1}: reference de piece absente`);
    if (!/^\d{6,}$/.test(entry.debitAccount)) warnings.push(`Ligne ${index + 1}: compte debit inhabituel (${entry.debitAccount || 'vide'})`);
    if (!/^\d{6,}$/.test(entry.creditAccount)) warnings.push(`Ligne ${index + 1}: compte credit inhabituel (${entry.creditAccount || 'vide'})`);
  });

  const totalDebit = entries.reduce((sum, entry) => sum + Math.abs(Number(entry.amount || 0)), 0);
  const totalCredit = totalDebit;
  return {
    ok: issues.length === 0,
    issues,
    warnings,
    totals: { totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 },
  };
}

function buildFec(entries) {
  const headers = [
    'JournalCode', 'JournalLib', 'EcritureNum', 'EcritureDate', 'CompteNum', 'CompteLib',
    'CompAuxNum', 'CompAuxLib', 'PieceRef', 'PieceDate', 'EcritureLib', 'Debit', 'Credit',
    'EcritureLet', 'DateLet', 'ValidDate', 'Montantdevise', 'Idevise'
  ];
  const rows = [headers.join('\t')];
  entries.forEach(entry => {
    rows.push([
      entry.journalCode, entry.journalLib, entry.ecritureNum, entry.date, entry.debitAccount, '',
      '', '', entry.piece, entry.pieceDate, entry.lib, amount(entry.amount), '0,00',
      '', '', entry.date, '', ''
    ].map(clean).join('\t'));
    rows.push([
      entry.journalCode, entry.journalLib, entry.ecritureNum, entry.date, entry.creditAccount, '',
      '', '', entry.piece, entry.pieceDate, entry.lib, '0,00', amount(entry.amount),
      '', '', entry.date, '', ''
    ].map(clean).join('\t'));
  });
  return rows.join('\r\n') + '\r\n';
}

function num(value) {
  const out = Number(value || 0);
  return Number.isFinite(out) ? Math.round(out * 100) / 100 : 0;
}

function sum(list, getter) {
  return (list || []).reduce((total, item) => total + num(getter(item)), 0);
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  return rows.map(row => row.map(csvEscape).join(';')).join('\n');
}

function computeFiscalTotals(data) {
  const factures = data.factures || [];
  const achats = data.achats || [];
  const comptes = data.comptes || [];
  const revenue = sum(factures, f => f.ht) || sum(comptes.filter(c => String(c.num).startsWith('7')), c => c.c);
  const purchases = sum(achats, a => a.ht);
  const tvaCollected = sum(factures, f => f.tvaA || f.tva_amount);
  const tvaDeductible = sum(achats, a => a.tvaA || a.tva_amount);
  const payroll = sum(comptes.filter(c => String(c.num).startsWith('64')), c => c.d);
  const rent = sum(comptes.filter(c => String(c.num).startsWith('613')), c => c.d);
  const fees = sum(comptes.filter(c => String(c.num).startsWith('622')), c => c.d);
  const services = sum(comptes.filter(c => ['61', '62'].includes(String(c.num).slice(0, 2))), c => c.d);
  const taxes = sum(comptes.filter(c => String(c.num).startsWith('63')), c => c.d);
  const depreciation = sum(comptes.filter(c => String(c.num).startsWith('68')), c => c.d);
  const financial = sum(comptes.filter(c => String(c.num).startsWith('66')), c => c.d);
  const totalExpenses = purchases + payroll + rent + fees + services + taxes + depreciation + financial;
  return { revenue, purchases, tvaCollected, tvaDeductible, tvaNet: tvaCollected - tvaDeductible, payroll, rent, fees, services, taxes, depreciation, financial, totalExpenses, result: revenue - totalExpenses };
}

function fiscalCalendar(settings = {}) {
  const year = Number(settings.year || new Date().getFullYear());
  const tvaRegime = settings.tvaRegime || 'monthly';
  const events = [];
  if (tvaRegime === 'monthly') {
    for (let month = 0; month < 12; month++) {
      const due = new Date(year, month + 1, 15);
      events.push({ type: 'TVA', date: due.toISOString().slice(0, 10), label: `CA3 ${String(month + 1).padStart(2, '0')}/${year}` });
    }
  } else if (tvaRegime === 'quarterly') {
    [4, 7, 10, 1].forEach((month, index) => events.push({ type: 'TVA', date: `${index === 3 ? year + 1 : year}-${String(month).padStart(2, '0')}-15`, label: `CA3 T${index + 1} ${year}` }));
  } else if (tvaRegime === 'annual') {
    events.push({ type: 'TVA', date: `${year + 1}-05-03`, label: `CA12 ${year}` });
  }
  [3, 6, 9, 12].forEach(month => events.push({ type: 'IS', date: `${year}-${String(month).padStart(2, '0')}-15`, label: 'Acompte IS' }));
  events.push({ type: 'CFE', date: `${year}-12-15`, label: 'CFE' });
  events.push({ type: 'Liasse', date: `${year + 1}-05-03`, label: 'Liasse fiscale / 2035 / 2033 / 2065' });
  events.push({ type: 'DAS2', date: `${year + 1}-05-03`, label: 'DAS2 si honoraires declares' });
  events.push({ type: 'IR', date: `${year + 1}-05-31`, label: '2042-C-PRO selon calendrier fiscal' });
  return events.sort((a, b) => a.date.localeCompare(b.date));
}

function fiscalReport(type, data) {
  const t = computeFiscalTotals(data);
  const reports = {
    tva: { form: 'TVA_CA3_PREPARATION', fields: { base_ht_taxable: t.revenue, tva_collectee: t.tvaCollected, tva_deductible: t.tvaDeductible, tva_nette_a_payer: t.tvaNet } },
    '2035': { form: '2035_PREPARATION_BNC', fields: { recettes_encaissees: t.revenue, achats: t.purchases, loyers: t.rent, honoraires: t.fees, salaires_charges: t.payroll, impots_taxes: t.taxes, dotations: t.depreciation, resultat_bnc_estime: t.result } },
    '2033': { form: '2033_PREPARATION_REGIME_SIMPLIFIE', fields: { chiffre_affaires_ht: t.revenue, charges_externes: t.purchases + t.services + t.rent + t.fees, impots_taxes: t.taxes, charges_personnel: t.payroll, dotations: t.depreciation, charges_financieres: t.financial, resultat_comptable: t.result, tva_nette: t.tvaNet } },
    '2065': { form: '2065_PREPARATION_IS', fields: { resultat_fiscal_estime: t.result, taux_is_estime: 25, impot_societes_estime: Math.max(0, num(t.result * 0.25)), benefice_apres_is_estime: num(t.result - Math.max(0, t.result * 0.25)) } },
    das2: { form: 'DAS2_PREPARATION', rows: (data.fournisseurs || []).map((f, index) => ({ beneficiaire: f.nom, siret: f.siret || '', honoraires_ht: sum(data.achats || [], a => Number(a.fi) === index ? a.ht : 0) })).filter(r => r.honoraires_ht > 0) },
    '2042cpro': { form: '2042_C_PRO_PREPARATION', fields: { recettes_bnc_bic_estimees: t.revenue, resultat_professionnel_estime: t.result, tva_nette_estimee: t.tvaNet } },
    calendar: { form: 'FISCAL_CALENDAR', events: fiscalCalendar(data.settings || {}) },
  };
  if (type === 'full') return { form: 'LUNO_FISCAL_PACKAGE', tva: reports.tva, declaration2035: reports['2035'], declaration2033: reports['2033'], declaration2065: reports['2065'], das2: reports.das2, declaration2042CPro: reports['2042cpro'], calendar: reports.calendar.events, balance: t };
  if (!reports[type]) throw new Error('Type fiscal inconnu');
  return reports[type];
}

function handleFiscal(body, res) {
  const type = body.type || 'full';
  const data = body.data || body;
  const report = fiscalReport(type, data);
  const format = body.format || 'json';
  if (format === 'csv') {
    const rows = report.rows
      ? [['Rubrique', 'Montant'], ...report.rows.map(row => [row.beneficiaire || row.type || '', row.honoraires_ht || row.montant || ''])]
      : [['Rubrique', 'Montant'], ...Object.entries(report.fields || {}).map(([k, v]) => [k, v])];
    return json(res, 200, { filename: `luno_${type}_${body.year || new Date().getFullYear()}.csv`, mimeType: 'text/csv;charset=utf-8', content: toCsv(rows), report });
  }
  return json(res, 200, { filename: `luno_${type}_${body.year || new Date().getFullYear()}.json`, mimeType: 'application/json;charset=utf-8', content: JSON.stringify(report, null, 2), report });
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'Methode non autorisee' });

  const body = req.body || {};
  if (body.mode === 'fiscal' || body.type) return handleFiscal(body, res);
  const entries = Array.isArray(body.entries || body.ecritures) ? (body.entries || body.ecritures).map(normalizeEntry) : [];
  const compliance = validate(entries);
  const fec = buildFec(entries);
  const siren = clean(body.siren || body.company?.siren || '000000000').replace(/\D/g, '').slice(0, 9).padEnd(9, '0');
  const closingDate = clean(body.closingDate || `${new Date().getFullYear()}1231`).replace(/\D/g, '').slice(0, 8);

  return json(res, 200, {
    filename: `${siren}FEC${closingDate}.txt`,
    mimeType: 'text/plain;charset=utf-8',
    fec,
    compliance,
  });
}
