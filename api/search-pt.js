// Vercel Serverless Function — pesquisa livros em Wook.pt e Bertrand.pt
// Ambas as lojas bloqueiam IPs de datacenter (Vercel/AWS) — usar ScrapingBee.
// Wook: Cloudflare forte -> premium_proxy (25 créditos)
// Bertrand: bot detection simples -> sem premium (1 crédito)
// Env: SCRAPINGBEE_KEY (obrigatório)

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).end();

    const { q, debug } = req.query;
    if (!q || q.trim().length < 2) return res.status(400).json({ error: 'q required' });

    const query = q.trim().substring(0, 150);
    const key = process.env.SCRAPINGBEE_KEY;

    if (!key) {
        return res.status(200).json({ results: [], error: 'SCRAPINGBEE_KEY env var missing' });
    }

    const [wookRes, bertrandRes] = await Promise.allSettled([
        fetchStore(key, `https://www.wook.pt/pesquisa?keyword=${encodeURIComponent(query)}`, true, 'wook'),
        fetchStore(key, `https://www.bertrand.pt/pesquisa/${encodeURIComponent(query)}`, false, 'bertrand'),
    ]);

    const wook = wookRes.status === 'fulfilled' ? wookRes.value : { books: [], meta: { error: String(wookRes.reason).slice(0, 200) } };
    const bertrand = bertrandRes.status === 'fulfilled' ? bertrandRes.value : { books: [], meta: { error: String(bertrandRes.reason).slice(0, 200) } };

    const all = [...wook.books, ...bertrand.books];
    const seen = new Set();
    const unique = all.filter(b => {
        const k = (b.id || '') + '|' + (b.title || '').toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    const payload = { results: unique.slice(0, 12) };
    if (debug === '1') payload.debug = { wook: wook.meta, bertrand: bertrand.meta };
    return res.status(200).json(payload);
}

async function fetchStore(key, targetUrl, premium, source) {
    const params = new URLSearchParams({
        api_key: key,
        url: targetUrl,
        country_code: 'pt',
        render_js: 'false',
    });
    if (premium) params.set('premium_proxy', 'true');
    const url = `https://app.scrapingbee.com/api/v1/?${params}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(28000) });
    const meta = { status: r.status, bytes: 0, matches: 0 };
    if (!r.ok) return { books: [], meta };
    const html = await r.text();
    meta.bytes = html.length;
    const books = parseProductList(html, source);
    meta.matches = books.length;
    return { books, meta };
}

function parseProductList(html, source) {
    const books = [];
    const seen = new Set();

    // Strategy 1: anchor tags with aria-label/title (Wook)
    const linkRe = /<a[^>]+href="(\/livro\/[^"]+\/(\d+))"[^>]*(?:aria-label|title)="([^"]{2,200})"/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null && books.length < 20) {
        if (seen.has(m[2])) continue;
        seen.add(m[2]);
        const title = decodeEntities(m[3]).trim();
        if (title.length < 2) continue;
        books.push(buildBook(m[2], m[1], title, html, m.index, source));
    }

    // Strategy 2: data-product-id/name (Bertrand)
    if (books.length === 0) {
        const re = /data-product-id="(\d+)"[^>]*data-product-name="([^"]+)"/g;
        while ((m = re.exec(html)) !== null && books.length < 20) {
            if (seen.has(m[1])) continue;
            seen.add(m[1]);
            const block = extractBlockAround(html, m.index, 3500);
            const hrefMatch = block.match(/href="(\/livro\/[^"]+\/\d+)"/);
            const href = hrefMatch ? hrefMatch[1] : `/livro/-/${m[1]}`;
            books.push(buildBook(m[1], href, decodeEntities(m[2]).trim(), html, m.index, source));
        }
    }

    // Strategy 3: bare anchor with inner text (fallback)
    if (books.length === 0) {
        const re = /<a[^>]+href="(\/livro\/[^"]+\/(\d+))"[^>]*>([^<]{3,200})<\/a>/gi;
        while ((m = re.exec(html)) !== null && books.length < 20) {
            if (seen.has(m[2])) continue;
            seen.add(m[2]);
            const title = decodeEntities(m[3]).trim();
            if (title.length < 2) continue;
            books.push(buildBook(m[2], m[1], title, html, m.index, source));
        }
    }

    return books;
}

function buildBook(id, href, title, html, idx, source) {
    const block = extractBlockAround(html, idx, 3500);
    const host = source === 'wook' ? 'https://www.wook.pt' : 'https://www.bertrand.pt';
    return {
        id,
        title,
        author: extractAuthor(block),
        cover: extractCover(block, source),
        price: extractPrice(block),
        url: host + href,
        source,
    };
}

function extractBlockAround(html, idx, radius) {
    return html.substring(Math.max(0, idx - 300), Math.min(html.length, idx + radius));
}

function extractAuthor(block) {
    const m = block.match(/class="authors[^"]*"[^>]*>[\s\S]{0,600}?(?:<a[^>]*>)?\s*(?:de\s+)?([^<]{3,120})</i);
    return m ? decodeEntities(m[1]).trim() : '';
}

function extractCover(block, source) {
    const hostPattern = source === 'wook' ? 'img\\.wook\\.pt' : 'img\\.bertrand\\.pt';
    const re = new RegExp(`(?:data-src|src)="(https://${hostPattern}/[^"]+)"`, 'i');
    const m = block.match(re);
    return m ? m[1].replace(/&amp;/g, '&') : '';
}

function extractPrice(block) {
    const m = block.match(/class="[^"]*font-bold[^"]*"[^>]*>\s*([\d,]+€)\s*</i)
        || block.match(/data-price="([\d.]+)"/)
        || block.match(/>(\d+,\d{2})€</);
    if (!m) return '';
    const v = m[1];
    return v.includes('€') ? v : (v.replace('.', ',') + '€');
}

function decodeEntities(s) {
    return String(s)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}
