const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hysznhfowtzfsbdntsyd.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function enc(value) {
  return encodeURIComponent(String(value));
}

async function supabaseFetch(path, options = {}) {
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY non configuree dans Vercel');
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || data?.error || `Erreur Supabase ${response.status}`);
  return data;
}

async function currentUser(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('Session Supabase requise');
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY || SERVICE_KEY || '', Authorization: `Bearer ${token}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) throw new Error('Session Supabase invalide');
  return data;
}

async function firstCompanyId(userId) {
  const rows = await supabaseFetch(`/rest/v1/memberships?user_id=eq.${enc(userId)}&select=company_id&limit=1`);
  return rows?.[0]?.company_id || null;
}

async function ensureCompanyId(user) {
  const existing = await firstCompanyId(user.id);
  if (existing) return existing;
  const meta = user.user_metadata || {};
  const societe = meta.societe || meta.org_name || 'Mon entreprise';
  await supabaseFetch('/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ id: user.id, email: user.email, prenom: meta.prenom || '', nom: meta.nom || '', societe, profile_type: meta.profile_type || 'entreprise', ui_mode: 'simple' }]),
  });
  const companies = await supabaseFetch('/rest/v1/companies', {
    method: 'POST',
    body: JSON.stringify([{ owner_id: user.id, nom: societe, email: user.email, exercice: String(new Date().getFullYear()) }]),
  });
  const companyId = companies?.[0]?.id;
  if (!companyId) throw new Error('Entreprise Supabase impossible a creer');
  await supabaseFetch('/rest/v1/memberships?on_conflict=company_id,user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ company_id: companyId, user_id: user.id, role: 'owner' }]),
  });
  return companyId;
}

function normalizeDate(value) {
  const raw = String(value || '').slice(0, 10);
  const fr = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (fr) return `${fr[3]}-${fr[2]}-${fr[1]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : new Date().toISOString().slice(0, 10);
}

function accountRow(account, companyId) {
  return {
    company_id: companyId,
    provider: account.provider || 'manual',
    provider_account_id: String(account.providerId || account.provider_account_id || account.id || ''),
    bank_name: account.bank || account.bank_name || 'Compte bancaire',
    iban_masked: account.iban || account.iban_masked || 'IBAN masque',
    currency: account.currency || 'EUR',
    balance: Number(account.solde || account.balance || 0),
    last_sync_at: account.lastSync || account.last_sync_at || new Date().toISOString(),
    raw: account,
  };
}

function transactionRow(tx, account, companyId, accountDbId) {
  const category = tx.manual || tx.category || tx.catData?.cat || tx.categoryLabel || '';
  return {
    company_id: companyId,
    bank_account_id: accountDbId,
    provider: account.provider || tx.provider || 'manual',
    provider_transaction_id: String(tx.providerId || tx.provider_transaction_id || tx.id || `${account.id}-${tx.date}-${tx.mnt}-${tx.lib}`),
    booked_at: normalizeDate(tx.date),
    label: tx.lib || tx.label || 'Transaction bancaire',
    amount: Number(tx.mnt || tx.amount || 0),
    category,
    confidence: Number(tx.catData?.confidence || tx.confidence || 0),
    tva_rate: Number(tx.tvaRate || tx.tva_rate || 0),
    tva_amount: Number(tx.tvaAmount || tx.tva_amount || 0),
    status: tx.matchedWith ? 'matched' : (category && category !== 'A classer' && category !== 'Autre' ? 'classified' : 'to_review'),
    matched_kind: tx.matchedKind || tx.matched_kind || null,
    matched_id: tx.matchedId || tx.matched_id || null,
    raw: tx,
  };
}

function rowToAccount(row, transactions) {
  return {
    id: `BA_${String(row.provider_account_id || row.id).replace(/[^a-z0-9_-]/gi, '_')}`,
    providerId: row.provider_account_id || row.id,
    provider: row.provider,
    bank: row.bank_name,
    iban: row.iban_masked,
    solde: Number(row.balance || 0),
    currency: row.currency || 'EUR',
    lastSync: row.last_sync_at || row.updated_at,
    color: '#1D9E75',
    emoji: 'BK',
    transactions,
  };
}

async function readBankData(companyId) {
  const accounts = await supabaseFetch(`/rest/v1/bank_accounts?company_id=eq.${enc(companyId)}&select=*&order=updated_at.desc`);
  const txns = await supabaseFetch(`/rest/v1/bank_transactions?company_id=eq.${enc(companyId)}&select=*&order=booked_at.desc&limit=500`);
  return accounts.map(account => rowToAccount(account, txns.filter(tx => tx.bank_account_id === account.id).map(tx => ({
    id: tx.provider_transaction_id || tx.id,
    date: tx.booked_at,
    lib: tx.label,
    mnt: Number(tx.amount || 0),
    category: tx.category || '',
    catData: { cat: tx.category || 'A classer', confidence: Number(tx.confidence || 0) },
    tvaRate: Number(tx.tva_rate || 0),
    tvaAmount: Number(tx.tva_amount || 0),
    status: tx.status || 'to_review',
    matchedWith: tx.matched_id || null,
  }))));
}

async function writeBankData(companyId, accounts, userId) {
  const savedAccounts = [];
  for (const account of accounts) {
    const rows = await supabaseFetch('/rest/v1/bank_accounts?on_conflict=company_id,provider,provider_account_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([accountRow(account, companyId)]),
    });
    const dbAccount = rows?.[0];
    if (!dbAccount) continue;
    savedAccounts.push(dbAccount);
    const txRows = (account.transactions || []).map(tx => transactionRow(tx, account, companyId, dbAccount.id));
    if (txRows.length) {
      await supabaseFetch('/rest/v1/bank_transactions?on_conflict=company_id,provider,provider_transaction_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(txRows),
      });
    }
  }
  await supabaseFetch('/rest/v1/audit_logs', {
    method: 'POST',
    body: JSON.stringify([{ company_id: companyId, user_id: userId, action: 'bank_data_synced', entity: 'bank_transactions', metadata: { accounts: accounts.length } }]),
  }).catch(() => null);
  return savedAccounts;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Methode non autorisee' });
  try {
    const user = await currentUser(req);
    const companyId = req.method === 'GET'
      ? (req.query?.companyId || await ensureCompanyId(user))
      : (req.body?.companyId || await ensureCompanyId(user));
    if (req.method === 'GET') return res.status(200).json({ ok: true, companyId, accounts: await readBankData(companyId) });
    await writeBankData(companyId, Array.isArray(req.body?.accounts) ? req.body.accounts : [], user.id);
    return res.status(200).json({ ok: true, companyId, accounts: await readBankData(companyId) });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Erreur banque Supabase' });
  }
}
