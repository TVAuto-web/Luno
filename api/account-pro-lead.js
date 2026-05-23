function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hysznhfowtzfsbdntsyd.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function saveLead(lead) {
  if (!SERVICE_KEY) return null;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/account_pro_leads`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify([{
      email: lead.email,
      company_name: lead.company,
      siren: lead.siren,
      need: lead.need,
      raw: lead,
    }]),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message || 'Enregistrement Supabase impossible');
  return data?.[0] || null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' });

  const body = req.body || {};
  const lead = {
    email: body.email || '',
    company: body.company || body.societe || '',
    siren: body.siren || '',
    need: body.need || 'compte-pro',
    createdAt: new Date().toISOString()
  };

  if (!lead.email) return res.status(400).json({ error: 'Email requis' });

  const saved = await saveLead(lead).catch((err) => ({ error: err.message }));
  const partnerUrl = process.env.ACCOUNT_PRO_PARTNER_URL || null;
  return res.status(200).json({
    ok: true,
    lead,
    saved,
    partnerConfigured: Boolean(partnerUrl),
    redirectUrl: partnerUrl,
    message: partnerUrl
      ? 'Redirection vers le partenaire compte pro disponible'
      : 'Demande enregistree cote LUNO. Configurez ACCOUNT_PRO_PARTNER_URL pour activer le parcours partenaire.'
  });
}
