// Vercel Serverless Function — identifica livro por capa
// Estratégia 1: Google Lens (reverse image search, sem API key)
// Estratégia 2: Google Cloud Vision API (opcional, se GOOGLE_VISION_API_KEY configurada)

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

    // Estratégia 1: Google Cloud Vision API (se chave configurada)
    const VISION_KEY = process.env.GOOGLE_VISION_API_KEY;
    if (VISION_KEY) {
        try {
            const result = await callVisionAPI(imageBase64, VISION_KEY);
            if (result.webEntities.length > 0 || result.webPages.length > 0) {
                return res.status(200).json(result);
            }
        } catch (e) { /* continuar para Lens */ }
    }

    // Estratégia 2: Google Lens (sem API key)
    try {
        const result = await callGoogleLens(imageBase64);
        return res.status(200).json(result);
    } catch (e) {
        return res.status(503).json({ error: e.message, configured: true });
    }
}

// ─── Google Cloud Vision ───────────────────────────────────────────────────
async function callVisionAPI(imageBase64, apiKey) {
    const resp = await fetch(
        `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
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
    if (!resp.ok) throw new Error('Vision API ' + resp.status);
    const data = await resp.json();
    const r = data.responses?.[0];
    return {
        text: r?.textAnnotations?.[0]?.description || '',
        webEntities: (r?.webDetection?.webEntities || [])
            .filter(e => e.score > 0.35 && e.description && !GENERIC_LABELS.has(e.description.toLowerCase()))
            .sort((a, b) => b.score - a.score)
            .map(e => ({ score: +e.score.toFixed(3), description: e.description })),
        webPages: [
            ...(r?.webDetection?.pagesWithMatchingImages || []),
            ...(r?.webDetection?.partialMatchingImages || []).map(p => ({ url: p.url, pageTitle: '' }))
        ].slice(0, 10).map(p => ({ url: p.url || '', title: p.pageTitle || '' })),
    };
}

// ─── Google Lens (sem API key) ─────────────────────────────────────────────
async function callGoogleLens(imageBase64) {
    const imgBuf = Buffer.from(imageBase64, 'base64');
    const boundary = 'lens' + Date.now();

    // Construir corpo multipart manualmente
    const body = Buffer.concat([
        Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="encoded_image"; filename="img.jpg"\r\n` +
            `Content-Type: image/jpeg\r\n\r\n`
        ),
        imgBuf,
        Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    // Upload para o Lens — seguir redirect manualmente
    const uploadResp = await fetch('https://lens.google.com/v3/upload?hl=pt&re=df&stcs=1&ep=gisbubb', {
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
            'Origin': 'https://lens.google.com',
            'Referer': 'https://lens.google.com/',
        },
        body,
        redirect: 'manual',
    });

    const lensUrl = uploadResp.headers.get('location') || uploadResp.url;
    if (!lensUrl || !lensUrl.includes('lens.google.com')) {
        throw new Error('Lens upload redirect not received');
    }

    // Buscar página de resultados
    const pageResp = await fetch(lensUrl, {
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html',
            'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
        },
    });
    const html = await pageResp.text();

    return parseLensHtml(html);
}

// ─── Parser da página de resultados do Google Lens ─────────────────────────
function parseLensHtml(html) {
    const webEntities = [];
    const webPages = [];
    let text = '';

    // 1. JSON-LD estruturado (o mais fiável — aparece quando Google identifica o livro)
    const jsonLdRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    let m;
    while ((m = jsonLdRe.exec(html)) !== null) {
        try {
            const d = JSON.parse(m[1]);
            const items = Array.isArray(d) ? d : [d];
            for (const item of items) {
                if (item['@type'] === 'Book' || item['@type'] === 'Product') {
                    if (item.name) webEntities.unshift({ score: 0.97, description: item.name });
                    if (item.author?.name) webEntities.push({ score: 0.95, description: item.author.name });
                    if (item.author && Array.isArray(item.author)) {
                        item.author.forEach(a => a.name && webEntities.push({ score: 0.95, description: a.name }));
                    }
                }
            }
        } catch (_) {}
    }

    // 2. URLs de sites de livros embebidos na página (Goodreads, Fnac, Amazon, etc.)
    const bookSiteRe = /https?:\/\/(?:www\.)?(?:goodreads\.com\/book\/show|amazon\.(?:com|co\.uk|de|fr|es)\/[^/]+\/dp|fnac\.pt\/[^"'\s<>]+|bertrand\.pt\/[^"'\s<>]+|wook\.pt\/[^"'\s<>]+|bookdepository\.com\/[^"'\s<>]+)[^\s"'<>\\]*/g;
    const foundUrls = new Set();
    let uMatch;
    while ((uMatch = bookSiteRe.exec(html)) !== null) {
        const url = uMatch[0].replace(/['"\\]+$/, '');
        if (foundUrls.has(url)) continue;
        foundUrls.add(url);
        webPages.push({ url, title: '' });

        // Goodreads tem o título no URL: /book/show/12345.Titulo_Do_Livro
        const grM = url.match(/goodreads\.com\/book\/show\/\d+\.([^/?&"]+)/);
        if (grM) {
            const t = decodeURIComponent(grM[1]).replace(/_/g, ' ').replace(/\+/g, ' ');
            if (t.length > 3) webEntities.push({ score: 0.88, description: t });
        }
    }

    // 3. Títulos de páginas vizinhos a URLs de livros (og:title, <title>, aria-label)
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]{4,80})"/i)?.[1];
    if (ogTitle) {
        const clean = ogTitle.replace(/\s*[-|–]\s*(Google|Lens|Pesquisa).*$/i, '').trim();
        if (clean.length > 3) webEntities.push({ score: 0.72, description: clean });
    }

    // 4. Dados embebidos em JS — Google usa padrões como ["Titulo do Livro","Autor Nome",...]
    // Procurar sequências de strings longas próximas de palavras-chave de livro
    const jsDataRe = /"([A-ZÀ-Þa-zÀ-ÿ][^"]{4,70})"\s*,\s*"([A-ZÀ-Þ][a-zA-ZÀ-ÿ. ]{5,40})"\s*,\s*(?:null|\d+)\s*,\s*"(?:Book|Livro|PT|pt|por)"/g;
    while ((m = jsDataRe.exec(html)) !== null) {
        webEntities.push({ score: 0.82, description: m[1] });
        webEntities.push({ score: 0.80, description: m[2] });
    }

    // Deduplicate entities por descrição
    const seen = new Set();
    const deduped = webEntities.filter(e => {
        const k = e.description.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k); return true;
    });

    return { text, webEntities: deduped, webPages: webPages.slice(0, 10) };
}
