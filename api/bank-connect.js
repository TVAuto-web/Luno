function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const json = (res, status, body) => res.status(status).json(body);

function originFromReq(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'useluno.fr';
  return `${proto}://${host}`;
}

async function bridgeConnect(req, res, body) {
  const clientId = process.env.BRIDGE_CLIENT_ID;
  const clientSecret = process.env.BRIDGE_CLIENT_SECRET;
  const accessToken = process.env.BRIDGE_ACCESS_TOKEN;
  if (!clientId || !clientSecret || !accessToken) {
    return json(res, 501, {
      error: 'Variables BRIDGE_CLIENT_ID, BRIDGE_CLIENT_SECRET et BRIDGE_ACCESS_TOKEN requises',
      provider: 'bridge',
    });
  }

  const redirectUrl = body.redirectUrl || `${originFromReq(req)}/app?bank=bridge`;
  const response = await fetch('https://api.bridgeapi.io/v2/connect/items/add', {
    method: 'POST',
    headers: {
      'Client-Id': clientId,
      'Client-Secret': clientSecret,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      country: body.country || 'fr',
      prefill_email: body.email,
      redirect_url: redirectUrl,
      context: String(body.context || 'luno').replace(/[^a-zA-Z0-9]/g, '').slice(0, 100),
      capabilities: ['ais'],
    }),
  });
  const data = await response.json();
  if (!response.ok) return json(res, response.status, { error: data.message || 'Erreur Bridge', provider: 'bridge', details: data });
  return json(res, 200, { provider: 'bridge', redirectUrl: data.redirect_url || data.url, data });
}

function powensConnect(req, res, body) {
  const domain = process.env.POWENS_DOMAIN;
  const clientId = process.env.POWENS_CLIENT_ID;
  if (!domain || !clientId) {
    return json(res, 501, { error: 'Variables POWENS_DOMAIN et POWENS_CLIENT_ID requises', provider: 'powens' });
  }

  const redirectUrl = body.redirectUrl || `${originFromReq(req)}/app?bank=powens`;
  const params = new URLSearchParams({
    domain,
    client_id: clientId,
    redirect_uri: redirectUrl,
    connector_capabilities: 'bank',
    account_types: 'checking,card',
    state: String(body.context || 'luno'),
  });
  if (body.code || process.env.POWENS_USER_CODE) params.set('code', body.code || process.env.POWENS_USER_CODE);
  return json(res, 200, {
    provider: 'powens',
    redirectUrl: `https://webview.powens.com/fr/connect?${params.toString()}`,
  });
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'Méthode non autorisée' });

  const body = req.body || {};
  if (!body.email) return json(res, 400, { error: 'Email utilisateur requis' });

  const provider = body.provider || process.env.BANK_PROVIDER || (process.env.BRIDGE_CLIENT_ID ? 'bridge' : 'powens');
  try {
    if (provider === 'bridge') return await bridgeConnect(req, res, body);
    if (provider === 'powens') return powensConnect(req, res, body);
    return json(res, 400, { error: 'Provider bancaire inconnu', provider });
  } catch (err) {
    return json(res, 500, { error: err.message || 'Erreur connexion bancaire', provider });
  }
}
