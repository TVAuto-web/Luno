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

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'Methode non autorisee' });

  const body = req.body || {};
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
