function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const json = (res, status, body) => res.status(status).json(body);

function n(value) {
  const out = Number(value || 0);
  return Number.isFinite(out) ? Math.round(out * 100) / 100 : 0;
}

function sum(list, getter) {
  return (list || []).reduce((total, item) => total + n(getter(item)), 0);
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  return rows.map(row => row.map(csvEscape).join(';')).join('\n');
}

function account(entries, prefix) {
  return sum(entries, e => {
    const debit = String(e.cpd || e.deb || e.compteDebit || '');
    const credit = String(e.cpc || e.cre || e.compteCredit || '');
    const amount = n(e.mnt || e.amount);
    if (debit.startsWith(prefix)) return amount;
    if (credit.startsWith(prefix)) return -amount;
    return 0;
  });
}

function computeTotals(data) {
  const factures = data.factures || [];
  const achats = data.achats || [];
  const ecritures = data.ecritures || [];
  const comptes = data.comptes || [];
  const revenue = sum(factures, f => f.ht) || sum(comptes.filter(c => String(c.num).startsWith('7')), c => c.c);
  const revenueTtc = sum(factures, f => f.ttc);
  const purchases = sum(achats, a => a.ht);
  const purchaseTtc = sum(achats, a => a.ttc);
  const tvaCollected = sum(factures, f => f.tvaA || f.tva_amount);
  const tvaDeductible = sum(achats, a => a.tvaA || a.tva_amount);
  const payroll = Math.max(account(ecritures, '64'), sum(comptes.filter(c => String(c.num).startsWith('64')), c => c.d));
  const rent = Math.max(account(ecritures, '613'), sum(comptes.filter(c => String(c.num).startsWith('613')), c => c.d));
  const fees = Math.max(account(ecritures, '622'), sum(comptes.filter(c => String(c.num).startsWith('622')), c => c.d));
  const services = Math.max(account(ecritures, '61'), account(ecritures, '62'), sum(comptes.filter(c => ['61', '62'].includes(String(c.num).slice(0, 2))), c => c.d));
  const taxes = Math.max(account(ecritures, '63'), sum(comptes.filter(c => String(c.num).startsWith('63')), c => c.d));
  const depreciation = Math.max(account(ecritures, '68'), sum(comptes.filter(c => String(c.num).startsWith('68')), c => c.d));
  const financial = Math.max(account(ecritures, '66'), sum(comptes.filter(c => String(c.num).startsWith('66')), c => c.d));
  const totalExpenses = purchases + payroll + rent + fees + services + taxes + depreciation + financial;
  const result = revenue - totalExpenses;
  const cash = sum(data.treso || [], t => t.type === 'enc' ? t.mnt : -n(t.mnt));
  return {
    revenue, revenueTtc, purchases, purchaseTtc, tvaCollected, tvaDeductible,
    tvaNet: tvaCollected - tvaDeductible, payroll, rent, fees, services, taxes,
    depreciation, financial, totalExpenses, result, cash,
  };
}

function byTvaRate(data) {
  const rates = {};
  (data.factures || []).forEach(f => {
    const rate = String(f.tva || 0);
    rates[rate] ||= { ventesHt: 0, tvaCollectee: 0, achatsHt: 0, tvaDeductible: 0 };
    rates[rate].ventesHt += n(f.ht);
    rates[rate].tvaCollectee += n(f.tvaA || f.tva_amount);
  });
  (data.achats || []).forEach(a => {
    const rate = String(a.tva || 0);
    rates[rate] ||= { ventesHt: 0, tvaCollectee: 0, achatsHt: 0, tvaDeductible: 0 };
    rates[rate].achatsHt += n(a.ht);
    rates[rate].tvaDeductible += n(a.tvaA || a.tva_amount);
  });
  return rates;
}

function buildVat(data) {
  const totals = computeTotals(data);
  return {
    form: 'TVA_CA3_PREPARATION',
    totals,
    rates: byTvaRate(data),
    rows: [
      ['Rubrique', 'Montant'],
      ['Base HT taxable', totals.revenue],
      ['TVA collectee', totals.tvaCollected],
      ['TVA deductible', totals.tvaDeductible],
      ['TVA nette a payer', totals.tvaNet],
    ],
  };
}

function build2035(data) {
  const t = computeTotals(data);
  return {
    form: '2035_PREPARATION_BNC',
    fields: {
      recettes_encaissees: t.revenue,
      achats: t.purchases,
      loyers: t.rent,
      honoraires: t.fees,
      salaires_charges: t.payroll,
      impots_taxes: t.taxes,
      dotations: t.depreciation,
      resultat_bnc_estime: t.result,
    },
  };
}

function build2033(data) {
  const t = computeTotals(data);
  return {
    form: '2033_PREPARATION_REGIME_SIMPLIFIE',
    fields: {
      chiffre_affaires_ht: t.revenue,
      achats_charges_externes: t.purchases + t.services + t.rent + t.fees,
      impots_taxes: t.taxes,
      charges_personnel: t.payroll,
      dotations: t.depreciation,
      charges_financieres: t.financial,
      resultat_comptable: t.result,
      tva_nette: t.tvaNet,
    },
  };
}

function build2065(data) {
  const t = computeTotals(data);
  const taxRate = n(data.settings?.isRate || 25);
  const estimatedIs = Math.max(0, t.result * taxRate / 100);
  return {
    form: '2065_PREPARATION_IS',
    fields: {
      resultat_fiscal_estime: t.result,
      taux_is_estime: taxRate,
      impot_societes_estime: n(estimatedIs),
      benefice_apres_is_estime: n(t.result - estimatedIs),
    },
  };
}

function buildDas2(data) {
  const suppliers = data.fournisseurs || [];
  const rows = suppliers.map((f, index) => {
    const amount = sum(data.achats || [], a => Number(a.fi) === index ? a.ht : 0);
    return { beneficiaire: f.nom, siret: f.siret || '', honoraires_ht: amount, a_declarer: amount >= 1200 };
  }).filter(row => row.honoraires_ht > 0);
  return { form: 'DAS2_PREPARATION', rows };
}

function build2042CPro(data) {
  const t = computeTotals(data);
  return {
    form: '2042_C_PRO_PREPARATION',
    fields: {
      recettes_bnc_bic_estimees: t.revenue,
      resultat_professionnel_estime: t.result,
      tva_nette_estimee: t.tvaNet,
    },
  };
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

function makeReport(type, data) {
  if (type === 'tva') return buildVat(data);
  if (type === '2035') return build2035(data);
  if (type === '2033') return build2033(data);
  if (type === '2065') return build2065(data);
  if (type === 'das2') return buildDas2(data);
  if (type === '2042cpro') return build2042CPro(data);
  if (type === 'calendar') return { form: 'FISCAL_CALENDAR', events: fiscalCalendar(data.settings || {}) };
  if (type === 'full') {
    return {
      form: 'LUNO_FISCAL_PACKAGE',
      tva: buildVat(data),
      declaration2035: build2035(data),
      declaration2033: build2033(data),
      declaration2065: build2065(data),
      das2: buildDas2(data),
      declaration2042CPro: build2042CPro(data),
      calendar: fiscalCalendar(data.settings || {}),
      balance: computeTotals(data),
    };
  }
  throw new Error('Type fiscal inconnu');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'Methode non autorisee' });
  try {
    const body = req.body || {};
    const type = body.type || 'full';
    const report = makeReport(type, body.data || body);
    const format = body.format || 'json';
    if (format === 'csv') {
      const rows = report.rows || Object.entries(report.fields || {}).map(([k, v]) => [k, v]);
      return json(res, 200, {
        filename: `luno_${type}_${body.year || new Date().getFullYear()}.csv`,
        mimeType: 'text/csv;charset=utf-8',
        content: toCsv(rows[0]?.[0] === 'Rubrique' ? rows : [['Rubrique', 'Montant'], ...rows]),
        report,
      });
    }
    return json(res, 200, {
      filename: `luno_${type}_${body.year || new Date().getFullYear()}.json`,
      mimeType: 'application/json;charset=utf-8',
      content: JSON.stringify(report, null, 2),
      report,
    });
  } catch (err) {
    return json(res, 500, { error: err.message || 'Erreur preparation fiscale' });
  }
}
