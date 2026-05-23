function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

  const partnerUrl = process.env.ACCOUNT_PRO_PARTNER_URL || null;
  return res.status(200).json({
    ok: true,
    lead,
    partnerConfigured: Boolean(partnerUrl),
    redirectUrl: partnerUrl,
    message: partnerUrl
      ? 'Redirection vers le partenaire compte pro disponible'
      : 'Demande enregistree cote LUNO. Configurez ACCOUNT_PRO_PARTNER_URL pour activer le parcours partenaire.'
  });
}
