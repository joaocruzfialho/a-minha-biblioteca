// Vercel Serverless Function — identifica livro por capa via Google Cloud Vision API
// (Web Detection: reverse image search que encontra capas indexadas na web)
// Free tier: 1000 req/mês — https://cloud.google.com/vision/pricing
// Setup: Google Cloud Console → Enable Cloud Vision API → Create API Key → Vercel env var GOOGLE_VISION_API_KEY

const GENERIC_LABELS = new Set([
    'book', 'livro', 'novel', 'novela', 'fiction', 'literature', 'literatura',
    'publishing', 'editora', 'book cover', 'capa', 'paperback', 'hardcover',
    'bestseller', 'text', 'font', 'graphic design', 'illustration', 'poster',
    'album cover', 'product', 'image', 'photograph', 'photography', 'design',
    'cover art', 'visual arts', 'stock photography', 'brand', 'logo',
    'paper', 'printed matter', 'publication', 'magazine',
]);

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).end();

    const { imageBase64 } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

    const VISION_KEY = process.env.GOOGLE_VISION_API_KEY;
    if (!VISION_KEY) {
        return res.status(503).json({ configured: false, error: 'GOOGLE_VISION_API_KEY not set' });
    }

    try {
        const vResp = await fetch(
            `https://vision.googleapis.com/v1/images:annotate?key=${VISION_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requests: [{
                        image: { content: imageBase64 },
                        features: [
                            { type: 'TEXT_DETECTION', maxResults: 1 },
                            { type: 'WEB_DETECTION', maxResults: 15 },
                        ]
                    }]
                })
            }
        );

        if (!vResp.ok) {
            const errBody = await vResp.json().catch(() => ({}));
            return res.status(vResp.status).json({ error: errBody?.error?.message || 'Vision API error' });
        }

        const data = await vResp.json();
        const r = data.responses?.[0];
        if (!r) return res.status(500).json({ error: 'Empty Vision response' });

        // Full text from OCR (Vision's OCR is far better than Tesseract for photos)
        const text = r.textAnnotations?.[0]?.description || '';

        // Web entities: what Google thinks the image shows (often includes exact title + author)
        const webEntities = (r.webDetection?.webEntities || [])
            .filter(e => e.score > 0.35 && e.description && !GENERIC_LABELS.has(e.description.toLowerCase()))
            .sort((a, b) => b.score - a.score)
            .map(e => ({ score: +e.score.toFixed(3), description: e.description }));

        // Pages with exact or partial matching images (URLs of Amazon, Goodreads, etc.)
        const webPages = [
            ...(r.webDetection?.pagesWithMatchingImages || []),
            ...(r.webDetection?.partialMatchingImages || []).map(p => ({ url: p.url, pageTitle: '' }))
        ]
            .slice(0, 10)
            .map(p => ({ url: p.url || '', title: p.pageTitle || '' }));

        return res.status(200).json({ text, webEntities, webPages });

    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
