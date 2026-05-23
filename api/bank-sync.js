function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const json = (res, status, body) => res.status(status).json(body);

function bridgeHeaders() {
  const clientId = process.env.BRIDGE_CLIENT_ID;
  const clientSecret = process.env.BRIDGE_CLIENT_SECRET;
  const accessToken = process.env.BRIDGE_ACCESS_TOKEN;
  if (!clientId || !clientSecret || !accessToken) {
    throw new Error('Variables BRIDGE_CLIENT_ID, BRIDGE_CLIENT_SECRET et BRIDGE_ACCESS_TOKEN requises');
  }
  return {
    'Client-Id': clientId,
    'Client-Secret': clientSecret,
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
}

function normalizeBridgeAccount(account = {}) {
  return {
    id: String(account.id || account.account_id || ''),
    provider: 'bridge',
    bank: account.bank?.name || account.item?.bank?.name || account.name || 'Compte bancaire',
    iban: account.iban || account.number || 'IBAN masque',
    solde: Number(account.balance || account.balance_info?.current || 0),
    currency: account.currency_code || account.currency || 'EUR',
    lastSync: new Date().toISOString(),
  };
}

function normalizeBridgeTransaction(txn = {}) {
  const amount = Number(txn.amount || 0);
  return {
    id: String(txn.id || txn.transaction_id || ''),
    date: (txn.date || txn.booking_date || txn.transaction_date || new Date().toISOString()).slice(0, 10),
    lib: txn.clean_description || txn.description || txn.wording || 'Transaction bancaire',
    mnt: amount,
    category: txn.category?.name || txn.category_name || '',
    provider: 'bridge',
  };
}

async function bridgeSync(body) {
  const accountId = body.accountId || body.account_id;
  const headers = bridgeHeaders();
  const accountsUrl = accountId
    ? `https://api.bridgeapi.io/v2/accounts/${encodeURIComponent(accountId)}`
    : 'https://api.bridgeapi.io/v2/accounts';
  const accountsResponse = await fetch(accountsUrl, { headers });
  const accountsData = await accountsResponse.json().catch(() => ({}));
  if (!accountsResponse.ok) {
    return { status: accountsResponse.status, body: { error: accountsData.message || 'Erreur recuperation comptes Bridge', provider: 'bridge', details: accountsData } };
  }

  const rawAccounts = Array.isArray(accountsData.resources) ? accountsData.resources : (accountsData.id ? [accountsData] : []);
  const accounts = rawAccounts.map(normalizeBridgeAccount);
  const targetAccounts = accountId ? accounts : accounts.slice(0, Number(body.limitAccounts || 10));
  const transactions = [];

  for (const account of targetAccounts) {
    const txUrl = `https://api.bridgeapi.io/v2/accounts/${encodeURIComponent(account.id)}/transactions?limit=${Number(body.limit || 50)}`;
    const txResponse = await fetch(txUrl, { headers });
    const txData = await txResponse.json().catch(() => ({}));
    if (!txResponse.ok) continue;
    const rawTxns = Array.isArray(txData.resources) ? txData.resources : [];
    rawTxns.forEach(txn => transactions.push({ ...normalizeBridgeTransaction(txn), accountId: account.id, bankName: account.bank }));
  }

  return { status: 200, body: { provider: 'bridge', accounts, transactions } };
}

function powensBaseUrl() {
  const domain = process.env.POWENS_DOMAIN;
  if (!domain) throw new Error('Variable POWENS_DOMAIN requise');
  if (/^https?:\/\//i.test(domain)) return domain.replace(/\/$/, '');
  return `https://${domain.replace(/\/$/, '')}`;
}

async function powensSync(body) {
  const token = body.accessToken || process.env.POWENS_ACCESS_TOKEN || process.env.POWENS_USER_TOKEN;
  if (!token) throw new Error('Token Powens utilisateur requis');
  const base = powensBaseUrl();
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  const accountsResponse = await fetch(`${base}/2.0/users/me/accounts`, { headers });
  const accountsData = await accountsResponse.json().catch(() => ({}));
  if (!accountsResponse.ok) {
    return { status: accountsResponse.status, body: { error: accountsData.error_description || accountsData.message || 'Erreur recuperation comptes Powens', provider: 'powens', details: accountsData } };
  }

  const rawAccounts = accountsData.accounts || accountsData.results || [];
  const accounts = rawAccounts.map(account => ({
    id: String(account.id || ''),
    provider: 'powens',
    bank: account.name || account.bank?.name || 'Compte bancaire',
    iban: account.iban || account.number || 'IBAN masque',
    solde: Number(account.balance || 0),
    currency: account.currency?.id || account.currency || 'EUR',
    lastSync: new Date().toISOString(),
  }));

  const transactions = [];
  for (const account of accounts.slice(0, Number(body.limitAccounts || 10))) {
    const txResponse = await fetch(`${base}/2.0/users/me/accounts/${encodeURIComponent(account.id)}/transactions?limit=${Number(body.limit || 50)}`, { headers });
    const txData = await txResponse.json().catch(() => ({}));
    if (!txResponse.ok) continue;
    const rawTxns = txData.transactions || txData.results || [];
    rawTxns.forEach(txn => transactions.push({
      id: String(txn.id || ''),
      date: (txn.date || txn.rdate || new Date().toISOString()).slice(0, 10),
      lib: txn.wording || txn.original_wording || 'Transaction bancaire',
      mnt: Number(txn.value || txn.amount || 0),
      category: txn.category || '',
      accountId: account.id,
      bankName: account.bank,
      provider: 'powens',
    }));
  }

  return { status: 200, body: { provider: 'powens', accounts, transactions } };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'Methode non autorisee' });

  const body = req.body || {};
  const provider = body.provider || process.env.BANK_PROVIDER || (process.env.BRIDGE_CLIENT_ID ? 'bridge' : 'powens');
  try {
    const result = provider === 'bridge' ? await bridgeSync(body) : await powensSync(body);
    return json(res, result.status, result.body);
  } catch (err) {
    return json(res, 501, { error: err.message || 'Configuration bancaire requise', provider });
  }
}
