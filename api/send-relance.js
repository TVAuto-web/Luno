export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' });
  const { to, subject, html } = req.body || {};
  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'Champs requis manquants : to, subject, html' });
  }
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    return res.status(500).json({ error: 'RESEND_API_KEY non configuree' });
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'ComptaPME Pro <onboarding@resend.dev>',
        to: [to],
        subject,
        html,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('Resend error:', data);
      return res.status(500).json({ error: data.message || 'Erreur Resend' });
    }
    return res.status(200).json({ id: data.id, message: 'Email envoye' });
  } catch (err) {
    console.error('Exception send-relance:', err);
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
}
