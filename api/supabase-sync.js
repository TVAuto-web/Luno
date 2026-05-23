const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hysznhfowtzfsbdntsyd.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
// Server-side persistence bridge for the legacy single-page app.

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
  const rows = await supabaseFetch(`/rest/v1/memberships?user_id=eq.${encodeURIComponent(userId)}&select=company_id&limit=1`);
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
      const rows = await supabaseFetch(`/rest/v1/app_snapshots?user_id=eq.${encodeURIComponent(user.id)}&company_id=eq.${encodeURIComponent(companyId)}&source=eq.web-app&select=*&limit=1`);
      return res.status(200).json({ snapshot: rows?.[0] || null });
    }

    const data = req.body?.data || {};
    const payload = [{
      user_id: user.id,
      company_id: companyId,
      source: 'web-app',
      version: req.body?.version || '1',
      data,
      updated_at: new Date().toISOString(),
    }];
    const rows = await supabaseFetch('/rest/v1/app_snapshots?on_conflict=user_id,company_id,source', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(payload),
    });

    await supabaseFetch('/rest/v1/audit_logs', {
      method: 'POST',
      body: JSON.stringify([{
        company_id: companyId,
        user_id: user.id,
        action: 'app_snapshot_synced',
        entity: 'app_snapshots',
        entity_id: rows?.[0]?.id || null,
        metadata: { keys: Object.keys(data || {}) },
      }]),
    }).catch(() => null);

    return res.status(200).json({ ok: true, snapshot: rows?.[0] || null });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Erreur sync Supabase' });
  }
}
