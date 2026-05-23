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
    headers: {
      apikey: ANON_KEY || SERVICE_KEY || '',
      Authorization: `Bearer ${token}`,
    },
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
    body: JSON.stringify([{
      id: user.id,
      email: user.email,
      prenom: meta.prenom || '',
      nom: meta.nom || '',
      societe,
      siren: meta.siren || null,
      profile_type: meta.profile_type || 'entreprise',
      ui_mode: 'simple',
    }]),
  });

  const companies = await supabaseFetch('/rest/v1/companies', {
    method: 'POST',
    body: JSON.stringify([{
      owner_id: user.id,
      nom: societe,
      siren: meta.siren || null,
      siret: meta.siret || null,
      email: user.email,
      exercice: String(new Date().getFullYear()),
    }]),
  });
  const companyId = companies?.[0]?.id;
  if (!companyId) throw new Error('Entreprise Supabase impossible a creer');

  await supabaseFetch('/rest/v1/memberships?on_conflict=company_id,user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ company_id: companyId, user_id: user.id, role: 'owner' }]),
  });
  await supabaseFetch('/rest/v1/subscriptions?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ user_id: user.id, plan: 'gratuit', status: 'active' }]),
  }).catch(() => null);
  return companyId;
}

function clientToRow(client, companyId, index) {
  return {
    company_id: companyId,
    legacy_index: index,
    nom: String(client?.nom || '').trim() || 'Client sans nom',
    contact: client?.contact || null,
    email: client?.email || null,
    tel: client?.tel || null,
    siret: client?.siret || null,
    tva_num: client?.tva_num || client?.tvaNum || null,
    adresse: client?.adr || client?.adresse || null,
    cp: client?.cp || null,
    ville: client?.ville || null,
    delai: Number.isFinite(Number(client?.delai)) ? Number(client.delai) : 30,
    notes: client?.notes || null,
  };
}

function quoteToRow(devis, companyId, clientIdByIndex, index) {
  return {
    company_id: companyId,
    legacy_index: index,
    client_index: Number.isFinite(Number(devis?.ci)) ? Number(devis.ci) : null,
    client_id: clientIdByIndex.get(Number(devis?.ci)) || null,
    num: String(devis?.num || `D-${index + 1}`).trim(),
    date: devis?.date || new Date().toISOString().slice(0, 10),
    valid_until: devis?.val || devis?.valid_until || null,
    ht: Number(devis?.ht || 0),
    tva: Number(devis?.tva || 0),
    ttc: Number(devis?.ttc || 0),
    st: devis?.st || 'en attente',
    description: devis?.desc || devis?.description || null,
  };
}

function invoiceToRow(facture, companyId, clientIdByIndex, index) {
  return {
    company_id: companyId,
    legacy_index: index,
    client_index: Number.isFinite(Number(facture?.ci)) ? Number(facture.ci) : null,
    client_id: clientIdByIndex.get(Number(facture?.ci)) || null,
    num: String(facture?.num || `F-${index + 1}`).trim(),
    date: facture?.date || new Date().toISOString().slice(0, 10),
    due_date: facture?.due || facture?.due_date || null,
    ht: Number(facture?.ht || 0),
    tva: Number(facture?.tva || 0),
    tva_amount: Number(facture?.tvaA || facture?.tva_amount || 0),
    ttc: Number(facture?.ttc || 0),
    st: facture?.st || 'en attente',
    description: facture?.desc || facture?.description || null,
  };
}

function rowToClient(row) {
  return {
    _sbid: row.id,
    nom: row.nom || '',
    contact: row.contact || '',
    email: row.email || '',
    tel: row.tel || '',
    siret: row.siret || '',
    tva_num: row.tva_num || '',
    adr: row.adresse || '',
    cp: row.cp || '',
    ville: row.ville || '',
    delai: row.delai || 30,
    notes: row.notes || '',
  };
}

function rowToQuote(row, clientIndexById) {
  return {
    _sbid: row.id,
    num: row.num,
    ci: Number.isFinite(Number(row.client_index)) ? Number(row.client_index) : (clientIndexById.get(row.client_id) || 0),
    date: row.date,
    val: row.valid_until || row.date,
    ht: Number(row.ht || 0),
    tva: Number(row.tva || 0),
    ttc: Number(row.ttc || 0),
    desc: row.description || '',
    st: row.st || 'en attente',
  };
}

function rowToInvoice(row, clientIndexById) {
  return {
    _sbid: row.id,
    num: row.num,
    ci: Number.isFinite(Number(row.client_index)) ? Number(row.client_index) : (clientIndexById.get(row.client_id) || 0),
    date: row.date,
    due: row.due_date || row.date,
    ht: Number(row.ht || 0),
    tva: Number(row.tva || 0),
    tvaA: Number(row.tva_amount || 0),
    ttc: Number(row.ttc || 0),
    st: row.st || 'en attente',
    desc: row.description || '',
  };
}

async function readBusinessData(companyId) {
  const [clientRows, quoteRows, invoiceRows] = await Promise.all([
    supabaseFetch(`/rest/v1/clients?company_id=eq.${enc(companyId)}&select=*&order=legacy_index.asc.nullslast,created_at.asc`),
    supabaseFetch(`/rest/v1/devis?company_id=eq.${enc(companyId)}&select=*&order=legacy_index.asc.nullslast,created_at.asc`),
    supabaseFetch(`/rest/v1/factures?company_id=eq.${enc(companyId)}&select=*&order=legacy_index.asc.nullslast,created_at.asc`),
  ]);
  const clientIndexById = new Map();
  clientRows.forEach((row, index) => clientIndexById.set(row.id, index));
  return {
    clients: clientRows.map(rowToClient),
    devis: quoteRows.map(row => rowToQuote(row, clientIndexById)),
    factures: invoiceRows.map(row => rowToInvoice(row, clientIndexById)),
  };
}

async function replaceBusinessData(companyId, data, userId) {
  const clients = Array.isArray(data?.clients) ? data.clients : [];
  const devis = Array.isArray(data?.devis) ? data.devis : [];
  const factures = Array.isArray(data?.factures) ? data.factures : [];

  await supabaseFetch(`/rest/v1/factures?company_id=eq.${enc(companyId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  await supabaseFetch(`/rest/v1/devis?company_id=eq.${enc(companyId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  await supabaseFetch(`/rest/v1/clients?company_id=eq.${enc(companyId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });

  const insertedClients = clients.length
    ? await supabaseFetch('/rest/v1/clients', { method: 'POST', body: JSON.stringify(clients.map((client, index) => clientToRow(client, companyId, index))) })
    : [];

  const clientIdByIndex = new Map();
  insertedClients.forEach(row => clientIdByIndex.set(Number(row.legacy_index), row.id));

  if (devis.length) {
    await supabaseFetch('/rest/v1/devis', { method: 'POST', body: JSON.stringify(devis.map((item, index) => quoteToRow(item, companyId, clientIdByIndex, index))) });
  }
  if (factures.length) {
    await supabaseFetch('/rest/v1/factures', { method: 'POST', body: JSON.stringify(factures.map((item, index) => invoiceToRow(item, companyId, clientIdByIndex, index))) });
  }

  await supabaseFetch('/rest/v1/audit_logs', {
    method: 'POST',
    body: JSON.stringify([{
      company_id: companyId,
      user_id: userId,
      action: 'business_data_synced',
      entity: 'clients_devis_factures',
      metadata: { clients: clients.length, devis: devis.length, factures: factures.length },
    }]),
  }).catch(() => null);

  return readBusinessData(companyId);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['POST', 'GET'].includes(req.method)) return res.status(405).json({ error: 'Methode non autorisee' });

  try {
    const user = await currentUser(req);
    const companyId = req.method === 'GET'
      ? (req.query?.companyId || await ensureCompanyId(user))
      : (req.body?.companyId || await ensureCompanyId(user));
    if (!companyId) return res.status(404).json({ error: 'Aucune entreprise Supabase rattachee a cet utilisateur' });

    if (req.method === 'GET') {
      const data = await readBusinessData(companyId);
      return res.status(200).json({ ok: true, companyId, data });
    }

    const data = await replaceBusinessData(companyId, req.body?.data || {}, user.id);
    return res.status(200).json({ ok: true, companyId, data });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Erreur donnees Supabase' });
  }
}
