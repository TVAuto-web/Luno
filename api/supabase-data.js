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

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  const fr = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (fr) return `${fr[3]}-${fr[2]}-${fr[1]}`;
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : new Date().toISOString().slice(0, 10);
}

function cleanStatus(value, fallback) {
  return String(value || fallback || '').trim();
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
    delai: safeNum(client?.delai, 30),
    notes: client?.notes || null,
  };
}

function supplierToRow(supplier, companyId, index) {
  return {
    company_id: companyId,
    legacy_index: index,
    nom: String(supplier?.nom || supplier?.name || '').trim() || 'Fournisseur sans nom',
    contact: supplier?.contact || null,
    email: supplier?.email || null,
    tel: supplier?.tel || null,
    siret: supplier?.siret || null,
    tva_num: supplier?.tva_num || supplier?.tvaNum || null,
    adresse: supplier?.adr || supplier?.adresse || null,
    cp: supplier?.cp || null,
    ville: supplier?.ville || null,
    delai: safeNum(supplier?.delai, 30),
    notes: supplier?.notes || null,
  };
}

function quoteToRow(devis, companyId, clientIdByIndex, index) {
  return {
    company_id: companyId,
    legacy_index: index,
    client_index: Number.isFinite(Number(devis?.ci)) ? Number(devis.ci) : null,
    client_id: clientIdByIndex.get(Number(devis?.ci)) || null,
    num: String(devis?.num || `D-${index + 1}`).trim(),
    date: normalizeDate(devis?.date),
    valid_until: devis?.val ? normalizeDate(devis.val) : null,
    ht: safeNum(devis?.ht),
    tva: safeNum(devis?.tva),
    ttc: safeNum(devis?.ttc),
    st: cleanStatus(devis?.st, 'en attente'),
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
    date: normalizeDate(facture?.date),
    due_date: facture?.due || facture?.due_date ? normalizeDate(facture?.due || facture?.due_date) : null,
    ht: safeNum(facture?.ht),
    tva: safeNum(facture?.tva),
    tva_amount: safeNum(facture?.tvaA || facture?.tva_amount),
    ttc: safeNum(facture?.ttc),
    st: cleanStatus(facture?.st, 'en attente'),
    description: facture?.desc || facture?.description || null,
  };
}

function purchaseToRow(achat, companyId, supplierIdByIndex, index) {
  return {
    company_id: companyId,
    legacy_index: index,
    fournisseur_index: Number.isFinite(Number(achat?.fi)) ? Number(achat.fi) : null,
    fournisseur_id: supplierIdByIndex.get(Number(achat?.fi)) || null,
    num: achat?.num || achat?.ref || `A-${index + 1}`,
    date: normalizeDate(achat?.date),
    due_date: achat?.due ? normalizeDate(achat.due) : null,
    ht: safeNum(achat?.ht),
    tva: safeNum(achat?.tva),
    tva_amount: safeNum(achat?.tvaA || achat?.tva_amount),
    ttc: safeNum(achat?.ttc),
    st: cleanStatus(achat?.st, 'en attente'),
    description: achat?.desc || achat?.description || achat?.fourn || null,
    raw: achat || {},
  };
}

function entryToRow(entry, companyId, index) {
  const amount = safeNum(entry?.mnt || entry?.montant || entry?.debit || entry?.credit);
  return {
    company_id: companyId,
    legacy_index: index,
    date: normalizeDate(entry?.date),
    journal: entry?.jnl || entry?.journal || null,
    journal_code: entry?.jnl || entry?.journal || null,
    libelle: entry?.lib || entry?.libelle || null,
    compte: entry?.cpd || entry?.compte || null,
    compte_debit: entry?.cpd || entry?.compte_debit || null,
    compte_credit: entry?.cpc || entry?.compte_credit || null,
    debit: safeNum(entry?.deb || entry?.debit || (entry?.cpd ? amount : 0)),
    credit: safeNum(entry?.cre || entry?.credit || 0),
    montant: amount,
    reference: entry?.pj || entry?.reference || null,
    piece_jointe: entry?.pj || entry?.piece_jointe || null,
    raw: entry || {},
  };
}

function tvaToRow(item, companyId, index) {
  return {
    company_id: companyId,
    legacy_index: index,
    period: String(item?.period || `TVA-${index + 1}`),
    collected: safeNum(item?.col || item?.collected),
    deductible: safeNum(item?.ded || item?.deductible),
    net: safeNum(item?.net),
    status: cleanStatus(item?.status, 'en cours'),
    raw: item || {},
  };
}

function ocrToRow(item, companyId, userId) {
  return {
    company_id: companyId,
    user_id: userId,
    file_name: item?.file || item?.fileName || null,
    mime_type: item?.mime || item?.mimeType || null,
    provider: item?.provider || 'openai',
    status: item?.status || 'processed',
    extracted: item?.extracted || item || {},
    amount_ht: safeNum(item?.montantHT || item?.ht),
    amount_tva: safeNum(item?.tvaAmt || item?.tvaA),
    amount_ttc: safeNum(item?.montant || item?.montantTTC || item?.ttc),
    supplier_name: item?.fournisseur || item?.supplier || null,
    document_date: item?.documentDate || item?.date ? normalizeDate(item?.documentDate || item?.date) : null,
  };
}

function signatureToRow(item, companyId, userId, quoteIdByIndex) {
  const quoteIndex = Number(item?.devisIndex ?? item?.di);
  return {
    company_id: companyId,
    user_id: userId,
    devis_id: quoteIdByIndex.get(quoteIndex) || null,
    provider: item?.provider || 'yousign',
    provider_request_id: item?.signatureRequestId || item?.provider_request_id || item?.id || null,
    provider_document_id: item?.documentId || item?.provider_document_id || null,
    signer_email: item?.email || item?.signer_email || 'signature@unknown.local',
    signer_name: item?.client || item?.signer_name || null,
    status: item?.status || 'pending',
    signing_url: item?.signingUrl || item?.signing_url || null,
    sent_at: item?.sentAt || item?.date || new Date().toISOString(),
    signed_at: item?.signedAt || null,
    raw: item || {},
  };
}

function relanceToRow(item, companyId) {
  return {
    company_id: companyId,
    legacy_id: String(item?.id || item?.nom || Date.now()),
    nom: String(item?.nom || 'Regle de relance'),
    delai: safeNum(item?.delai, 10),
    type: item?.type || 'email',
    objet: item?.objet || null,
    message: item?.msg || item?.message || null,
    active: item?.active !== false,
    raw: item || {},
  };
}

function rowToClient(row) {
  return { _sbid: row.id, nom: row.nom || '', contact: row.contact || '', email: row.email || '', tel: row.tel || '', siret: row.siret || '', tva_num: row.tva_num || '', adr: row.adresse || '', cp: row.cp || '', ville: row.ville || '', delai: row.delai || 30, notes: row.notes || '' };
}

function rowToSupplier(row) {
  return { _sbid: row.id, nom: row.nom || '', contact: row.contact || '', email: row.email || '', tel: row.tel || '', siret: row.siret || '', tva_num: row.tva_num || '', adr: row.adresse || '', cp: row.cp || '', ville: row.ville || '', delai: row.delai || 30, notes: row.notes || '' };
}

function rowToQuote(row, clientIndexById) {
  return { _sbid: row.id, num: row.num, ci: Number.isFinite(Number(row.client_index)) ? Number(row.client_index) : (clientIndexById.get(row.client_id) || 0), date: row.date, val: row.valid_until || row.date, ht: safeNum(row.ht), tva: safeNum(row.tva), ttc: safeNum(row.ttc), desc: row.description || '', st: row.st || 'en attente' };
}

function rowToInvoice(row, clientIndexById) {
  return { _sbid: row.id, num: row.num, ci: Number.isFinite(Number(row.client_index)) ? Number(row.client_index) : (clientIndexById.get(row.client_id) || 0), date: row.date, due: row.due_date || row.date, ht: safeNum(row.ht), tva: safeNum(row.tva), tvaA: safeNum(row.tva_amount), ttc: safeNum(row.ttc), st: row.st || 'en attente', desc: row.description || '' };
}

function rowToPurchase(row, supplierIndexById) {
  return { _sbid: row.id, num: row.num || '', fi: Number.isFinite(Number(row.fournisseur_index)) ? Number(row.fournisseur_index) : (supplierIndexById.get(row.fournisseur_id) || 0), date: row.date, due: row.due_date || row.date, ht: safeNum(row.ht), tva: safeNum(row.tva), tvaA: safeNum(row.tva_amount), ttc: safeNum(row.ttc), st: row.st || 'en attente', desc: row.description || '' };
}

function rowToEntry(row) {
  return { _sbid: row.id, date: row.date, jnl: row.journal_code || row.journal || '', cpd: row.compte_debit || row.compte || '', cpc: row.compte_credit || '', lib: row.libelle || '', mnt: safeNum(row.montant || row.debit || row.credit), pj: row.piece_jointe || row.reference || '' };
}

async function readBusinessData(companyId) {
  const [clientRows, supplierRows, quoteRows, invoiceRows, purchaseRows, entryRows, tvaRows, ocrRows, signatureRows, relanceRows] = await Promise.all([
    supabaseFetch(`/rest/v1/clients?company_id=eq.${enc(companyId)}&select=*&order=legacy_index.asc.nullslast,created_at.asc`),
    supabaseFetch(`/rest/v1/fournisseurs?company_id=eq.${enc(companyId)}&select=*&order=legacy_index.asc.nullslast,created_at.asc`),
    supabaseFetch(`/rest/v1/devis?company_id=eq.${enc(companyId)}&select=*&order=legacy_index.asc.nullslast,created_at.asc`),
    supabaseFetch(`/rest/v1/factures?company_id=eq.${enc(companyId)}&select=*&order=legacy_index.asc.nullslast,created_at.asc`),
    supabaseFetch(`/rest/v1/achats?company_id=eq.${enc(companyId)}&select=*&order=legacy_index.asc.nullslast,created_at.asc`),
    supabaseFetch(`/rest/v1/ecritures?company_id=eq.${enc(companyId)}&select=*&order=legacy_index.asc.nullslast,created_at.asc`),
    supabaseFetch(`/rest/v1/tva_periods?company_id=eq.${enc(companyId)}&select=*&order=legacy_index.asc.nullslast,created_at.asc`).catch(() => []),
    supabaseFetch(`/rest/v1/ocr_documents?company_id=eq.${enc(companyId)}&select=*&order=created_at.desc&limit=200`).catch(() => []),
    supabaseFetch(`/rest/v1/signature_requests?company_id=eq.${enc(companyId)}&select=*&order=created_at.desc&limit=200`).catch(() => []),
    supabaseFetch(`/rest/v1/relance_rules?company_id=eq.${enc(companyId)}&select=*&order=created_at.asc`).catch(() => []),
  ]);
  const clientIndexById = new Map();
  const supplierIndexById = new Map();
  clientRows.forEach((row, index) => clientIndexById.set(row.id, index));
  supplierRows.forEach((row, index) => supplierIndexById.set(row.id, index));
  return {
    clients: clientRows.map(rowToClient),
    fournisseurs: supplierRows.map(rowToSupplier),
    devis: quoteRows.map(row => rowToQuote(row, clientIndexById)),
    factures: invoiceRows.map(row => rowToInvoice(row, clientIndexById)),
    achats: purchaseRows.map(row => rowToPurchase(row, supplierIndexById)),
    ecritures: entryRows.map(rowToEntry),
    tvaHist: tvaRows.map(row => ({ _sbid: row.id, period: row.period, col: safeNum(row.collected), ded: safeNum(row.deductible), net: safeNum(row.net), status: row.status || 'en cours' })),
    ocrHistory: ocrRows.map(row => ({ _sbid: row.id, file: row.file_name || '', date: row.document_date || row.created_at?.slice(0, 10), type: row.extracted?.type || 'document', montant: safeNum(row.amount_ttc), fournisseur: row.supplier_name || '', status: row.status || 'processed', extracted: row.extracted || {} })),
    signatureRequests: signatureRows.map(row => ({ _sbid: row.id, id: row.provider_request_id || row.id, email: row.signer_email, client: row.signer_name || '', status: row.status || 'pending', signingUrl: row.signing_url || '', sentAt: row.sent_at, signedAt: row.signed_at, provider: row.provider })),
    relanceRules: relanceRows.map(row => ({ _sbid: row.id, id: row.legacy_id || row.id, nom: row.nom, delai: row.delai, type: row.type, objet: row.objet || '', msg: row.message || '', active: row.active !== false })),
  };
}

async function replaceTable(table, companyId, rows) {
  await supabaseFetch(`/rest/v1/${table}?company_id=eq.${enc(companyId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (!rows.length) return [];
  return supabaseFetch(`/rest/v1/${table}`, { method: 'POST', body: JSON.stringify(rows) });
}

async function replaceBusinessData(companyId, data, userId) {
  const clients = Array.isArray(data?.clients) ? data.clients : [];
  const fournisseurs = Array.isArray(data?.fournisseurs) ? data.fournisseurs : [];
  const devis = Array.isArray(data?.devis) ? data.devis : [];
  const factures = Array.isArray(data?.factures) ? data.factures : [];
  const achats = Array.isArray(data?.achats) ? data.achats : [];
  const ecritures = Array.isArray(data?.ecritures) ? data.ecritures : [];
  const tvaHist = Array.isArray(data?.tvaHist) ? data.tvaHist : [];
  const ocrHistory = Array.isArray(data?.ocrHistory) ? data.ocrHistory : [];
  const signatureRequests = Array.isArray(data?.signatureRequests) ? data.signatureRequests : [];
  const relanceRules = Array.isArray(data?.relanceRules) ? data.relanceRules : [];

  await Promise.all([
    supabaseFetch(`/rest/v1/signature_requests?company_id=eq.${enc(companyId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => null),
    supabaseFetch(`/rest/v1/ocr_documents?company_id=eq.${enc(companyId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => null),
    supabaseFetch(`/rest/v1/relance_rules?company_id=eq.${enc(companyId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => null),
    supabaseFetch(`/rest/v1/tva_periods?company_id=eq.${enc(companyId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => null),
  ]);
  await supabaseFetch(`/rest/v1/ecritures?company_id=eq.${enc(companyId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  await supabaseFetch(`/rest/v1/achats?company_id=eq.${enc(companyId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  await supabaseFetch(`/rest/v1/factures?company_id=eq.${enc(companyId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  await supabaseFetch(`/rest/v1/devis?company_id=eq.${enc(companyId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  await supabaseFetch(`/rest/v1/fournisseurs?company_id=eq.${enc(companyId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  await supabaseFetch(`/rest/v1/clients?company_id=eq.${enc(companyId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });

  const insertedClients = clients.length ? await supabaseFetch('/rest/v1/clients', { method: 'POST', body: JSON.stringify(clients.map((client, index) => clientToRow(client, companyId, index))) }) : [];
  const insertedSuppliers = fournisseurs.length ? await supabaseFetch('/rest/v1/fournisseurs', { method: 'POST', body: JSON.stringify(fournisseurs.map((supplier, index) => supplierToRow(supplier, companyId, index))) }) : [];
  const clientIdByIndex = new Map();
  const supplierIdByIndex = new Map();
  insertedClients.forEach(row => clientIdByIndex.set(Number(row.legacy_index), row.id));
  insertedSuppliers.forEach(row => supplierIdByIndex.set(Number(row.legacy_index), row.id));

  const insertedQuotes = devis.length ? await supabaseFetch('/rest/v1/devis', { method: 'POST', body: JSON.stringify(devis.map((item, index) => quoteToRow(item, companyId, clientIdByIndex, index))) }) : [];
  if (factures.length) await supabaseFetch('/rest/v1/factures', { method: 'POST', body: JSON.stringify(factures.map((item, index) => invoiceToRow(item, companyId, clientIdByIndex, index))) });
  if (achats.length) await supabaseFetch('/rest/v1/achats', { method: 'POST', body: JSON.stringify(achats.map((item, index) => purchaseToRow(item, companyId, supplierIdByIndex, index))) });
  if (ecritures.length) await supabaseFetch('/rest/v1/ecritures', { method: 'POST', body: JSON.stringify(ecritures.map((item, index) => entryToRow(item, companyId, index))) });

  await replaceTable('tva_periods', companyId, tvaHist.map((item, index) => tvaToRow(item, companyId, index))).catch(() => null);
  await replaceTable('ocr_documents', companyId, ocrHistory.map(item => ocrToRow(item, companyId, userId))).catch(() => null);
  const quoteIdByIndex = new Map();
  insertedQuotes.forEach(row => quoteIdByIndex.set(Number(row.legacy_index), row.id));
  await replaceTable('signature_requests', companyId, signatureRequests.map(item => signatureToRow(item, companyId, userId, quoteIdByIndex))).catch(() => null);
  await replaceTable('relance_rules', companyId, relanceRules.map(item => relanceToRow(item, companyId))).catch(() => null);

  await supabaseFetch('/rest/v1/audit_logs', {
    method: 'POST',
    body: JSON.stringify([{
      company_id: companyId,
      user_id: userId,
      action: 'business_data_synced',
      entity: 'business_data',
      metadata: { clients: clients.length, fournisseurs: fournisseurs.length, devis: devis.length, factures: factures.length, achats: achats.length, ecritures: ecritures.length, tva: tvaHist.length, ocr: ocrHistory.length, signatures: signatureRequests.length, relances: relanceRules.length },
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
