const YOUSIGN_BASE = 'https://api.yousign.app/v3';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const json = (res, status, body) => res.status(status).json(body);

function pdfEscape(value) {
  return String(value || '').replace(/[()\\]/g, '\\$&').replace(/[^\x20-\x7E]/g, '?');
}

function makeSimplePdf(lines) {
  const safeLines = lines.map(pdfEscape).slice(0, 24);
  const textOps = safeLines.map((line, i) => `BT /F1 11 Tf 50 ${780 - i * 22} Td (${line}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(textOps)} >>\nstream\n${textOps}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((off) => { body += `${String(off).padStart(10, '0')} 00000 n \n`; });
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

async function yousign(path, options = {}) {
  const response = await fetch(`${process.env.YOUSIGN_API_BASE || YOUSIGN_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.YOUSIGN_API_KEY}`,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const msg = data.message || data.detail || data.error || 'Erreur YouSign';
    throw new Error(`${msg} (${response.status})`);
  }
  return data;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'Méthode non autorisée' });

  if (!process.env.YOUSIGN_API_KEY) {
    return json(res, 501, { error: 'YOUSIGN_API_KEY non configurée dans Vercel', provider: 'yousign' });
  }

  const { signer = {}, devis = {}, message = '', documentBase64, fileName } = req.body || {};
  if (!signer.email) return json(res, 400, { error: 'Email du signataire requis' });

  try {
    const signatureRequest = await yousign('/signature_requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `LUNO - ${devis.num || 'document à signer'}`,
        delivery_mode: 'email',
        email_notification: { custom_note: message || undefined },
      }),
    });

    const pdfBuffer = documentBase64
      ? Buffer.from(String(documentBase64).split(',').pop(), 'base64')
      : makeSimplePdf([
          'LUNO - Document a signer',
          `Devis: ${devis.num || '-'}`,
          `Client: ${devis.client || '-'}`,
          `Montant TTC: ${devis.total || '-'}`,
          '',
          message || 'Merci de signer ce document.',
        ]);

    const form = new FormData();
    form.append('nature', 'signable_document');
    form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), fileName || `${devis.num || 'document'}.pdf`);

    const document = await yousign(`/signature_requests/${signatureRequest.id}/documents`, {
      method: 'POST',
      body: form,
    });

    const [firstName, ...lastParts] = String(signer.name || signer.email.split('@')[0]).trim().split(/\s+/);
    const signerData = await yousign(`/signature_requests/${signatureRequest.id}/signers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        info: {
          first_name: firstName || 'Client',
          last_name: lastParts.join(' ') || 'LUNO',
          email: signer.email,
          locale: 'fr',
        },
        signature_level: 'electronic_signature',
        signature_authentication_mode: 'no_otp',
        fields: [{ type: 'signature', document_id: document.id, page: 1, x: 360, y: 700 }],
      }),
    });

    const activated = await yousign(`/signature_requests/${signatureRequest.id}/activate`, { method: 'POST' });
    return json(res, 200, {
      provider: 'yousign',
      signatureRequestId: signatureRequest.id,
      documentId: document.id,
      signerId: signerData.id,
      status: activated.status || 'activated',
      signingUrl: signerData.signature_link || signerData.signing_url || null,
    });
  } catch (err) {
    return json(res, 500, { error: err.message || 'Erreur signature serveur', provider: 'yousign' });
  }
}
