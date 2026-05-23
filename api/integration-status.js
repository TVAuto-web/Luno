function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const enabled = (value) => Boolean(value && String(value).trim());

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Methode non autorisee' });

  const bridge = enabled(process.env.BRIDGE_CLIENT_ID) && enabled(process.env.BRIDGE_CLIENT_SECRET) && enabled(process.env.BRIDGE_ACCESS_TOKEN);
  const powens = enabled(process.env.POWENS_DOMAIN) && enabled(process.env.POWENS_CLIENT_ID);
  const yousign = enabled(process.env.YOUSIGN_API_KEY);
  const openai = enabled(process.env.OPENAI_API_KEY);
  const accountPro = enabled(process.env.ACCOUNT_PRO_PARTNER_URL) || enabled(process.env.ACCOUNT_PRO_PARTNER_NAME);

  res.status(200).json({
    openai: { configured: openai, label: openai ? 'OCR IA actif' : 'OPENAI_API_KEY manquante ou quota a activer' },
    signature: { configured: yousign, label: yousign ? 'YouSign actif' : 'YOUSIGN_API_KEY a ajouter dans Vercel' },
    bankSync: {
      configured: bridge || powens,
      provider: bridge ? 'bridge' : (powens ? 'powens' : null),
      label: bridge || powens ? 'Synchronisation bancaire active' : 'Bridge ou Powens a configurer'
    },
    accountPro: {
      configured: accountPro,
      partner: process.env.ACCOUNT_PRO_PARTNER_NAME || null,
      url: process.env.ACCOUNT_PRO_PARTNER_URL || null,
      label: accountPro ? 'Partenaire compte pro configure' : 'Partenaire compte pro a choisir'
    }
  });
}
