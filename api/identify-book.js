// Vercel Serverless Function — identifica livro por capa
// Autenticação: GOOGLE_SERVICE_ACCOUNT_JSON (service account) ou GOOGLE_VISION_API_KEY (API key)
// Google Cloud Vision API — Web Detection: reverse image search contra toda a web indexada

const GENERIC = new Set([
    'book','livro','novel','novela','fiction','literature','literatura',
    'publishing','editora','book cover','capa','paperback','hardcover',
    'bestseller','text','font','graphic design','illustration','poster',
    'album cover','product','image','photograph','photography','design',
    'cover art','visual arts','stock photography','brand','logo',
    'paper','printed matter','publication','magazine',
]);

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).end();

    const { imageBase64 } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

    const SA_JSON   = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const VISION_KEY = process.env.GOOGLE_VISION_API_KEY;

    if (!SA_JSON && !VISION_KEY) {
        return res.status(503).json({ configured: false, error: 'No credentials configured' });
    }

    try {
        let authHeader;
        if (SA_JSON) {
            const token = await getAccessToken(SA_JSON);
            authHeader = `Bearer ${token}`;
        }

        const visionUrl = VISION_KEY && !SA_JSON
            ? `https://vision.googleapis.com/v1/images:annotate?key=${VISION_KEY}`
            : 'https://vision.googleapis.com/v1/images:annotate';

        const vResp = await fetch(visionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(authHeader ? { Authorization: authHeader } : {}),
            },
            body: JSON.stringify({
                requests: [{
                    image: { content: imageBase64 },
                    features: [
                        { type: 'TEXT_DETECTION', maxResults: 1 },
                        { type: 'WEB_DETECTION', maxResults: 15 },
                    ]
                }]
            })
        });

        if (!vResp.ok) {
            const e = await vResp.json().catch(() => ({}));
            return res.status(vResp.status).json({ error: e?.error?.message || 'Vision API error ' + vResp.status });
        }

        const data = await vResp.json();
        const r = data.responses?.[0];
        if (!r) return res.status(500).json({ error: 'Empty Vision response' });

        const text = r.textAnnotations?.[0]?.description || '';
        const webEntities = (r.webDetection?.webEntities || [])
            .filter(e => e.score > 0.35 && e.description && !GENERIC.has(e.description.toLowerCase()))
            .sort((a, b) => b.score - a.score)
            .map(e => ({ score: +e.score.toFixed(3), description: e.description }));
        const webPages = [
            ...(r.webDetection?.pagesWithMatchingImages || []),
            ...(r.webDetection?.partialMatchingImages || []).map(p => ({ url: p.url, pageTitle: '' }))
        ].slice(0, 10).map(p => ({ url: p.url || '', title: p.pageTitle || '' }));

        return res.status(200).json({ text, webEntities, webPages });

    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}

// ─── Autenticação via Service Account (JWT → OAuth2 access token) ─────────
// Usa o módulo crypto built-in do Node.js — sem dependências externas
import crypto from 'crypto';

function b64url(s) {
    return Buffer.from(s).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function getAccessToken(saJson) {
    const sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
    const now = Math.floor(Date.now() / 1000);

    const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({
        iss:   sa.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud:   'https://oauth2.googleapis.com/token',
        iat:   now,
        exp:   now + 3600,
    }));

    const unsigned  = `${header}.${payload}`;
    const signer    = crypto.createSign('RSA-SHA256');
    signer.update(unsigned);
    const signature = signer.sign(sa.private_key, 'base64')
        .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

    const jwt = `${unsigned}.${signature}`;

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    const tokenData = await tokenResp.json();
    if (!tokenData.access_token) throw new Error('Token error: ' + JSON.stringify(tokenData));
    return tokenData.access_token;
}
