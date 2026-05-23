const json = (res, status, body) => res.status(status).json(body);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function extractJson(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Réponse OCR non JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'Méthode non autorisée' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(res, 501, {
      error: 'OPENAI_API_KEY non configurée dans Vercel',
      provider: 'openai',
    });
  }

  const { fileName, mimeType, dataUrl } = req.body || {};
  if (!dataUrl || !mimeType) {
    return json(res, 400, { error: 'Champs requis manquants : dataUrl, mimeType' });
  }

  const isPdf = mimeType === 'application/pdf' || /\.pdf$/i.test(fileName || '');
  const inputContent = [
    {
      type: 'input_text',
      text:
        'Tu es un OCR comptable français. Extrais les données de facture/devis/reçu. ' +
        'Réponds uniquement en JSON valide avec les clés: type, fournisseur, date, numero, montantHT, tva, tvaAmt, montantTTC, devise, confidence, lignes, notes. ' +
        'Utilise null si une valeur est absente. Les montants doivent être des nombres.',
    },
    isPdf
      ? { type: 'input_file', filename: fileName || 'document.pdf', file_data: dataUrl }
      : { type: 'input_image', image_url: dataUrl, detail: 'high' },
  ];

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_OCR_MODEL || 'gpt-4o',
        input: [{ role: 'user', content: inputContent }],
        temperature: 0,
        max_output_tokens: 1200,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return json(res, response.status, {
        error: data.error?.message || 'Erreur OpenAI OCR',
        provider: 'openai',
        details: data.error || data,
      });
    }

    const text =
      data.output_text ||
      data.output?.flatMap((o) => o.content || []).map((c) => c.text || '').join('\n') ||
      '';
    const extracted = extractJson(text);
    return json(res, 200, { provider: 'openai', extracted, rawResponseId: data.id });
  } catch (err) {
    return json(res, 500, { error: err.message || 'Erreur OCR serveur' });
  }
}
