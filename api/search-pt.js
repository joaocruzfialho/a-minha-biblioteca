// Vercel Serverless Function — pesquisa livros em Wook.pt e Bertrand.pt
// Wook bloqueia IPs de datacenter (Cloudflare) — usa ScrapingBee (env SCRAPINGBEE_KEY).
// Bertrand não bloqueia — fetch direto.

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).end();

    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.status(400).json({ error: 'q required' });

    const query = q.trim().substring(0, 150);

    const [wook, bertrand] = await Promise.all([
        fetchWook(query).catch(() => []),
        fetchBertrand(query).catch(() => []),
    ]);

    const all = [...wook, ...bertrand];
    const seen = new Set();
    const unique = all.filter(b => {
        const key = (b.id || '') + '|' + (b.title || '').toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return res.status(200).json({ results: unique.slice(0, 12) });
}

async function fetchWook(query) {
    const key = process.env.SCRAPINGBEE_KEY;
    if (!key) return [];
    const target = `https://www.wook.pt/pesquisa?keyword=${encodeURIComponent(query)}`;
    const url = `https://app.scrapingbee.com/api/v1/?api_key=${key}&url=${encodeURIComponent(target)}&premium_proxy=true&country_code=pt&render_js=false`;
    const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
    if (!r.ok) return [];
    const html = await r.text();
    return parseProductList(html, 'wook');
}

async function fetchBertrand(query) {
    const target = `https://www.bertrand.pt/pesquisa/${encodeURIComponent(query)}`;
    const r = await fetch(target, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
            'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.5',
        },
        signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return [];
    const html = await r.text();
    return parseProductList(html, 'bertrand');
}

function parseProductList(html, source) {
    const books = [];
    const seen = new Set();
    const linkRe = /<a[^>]+href="(\/livro\/[^"]+\/(\d+))"[^>]*(?:aria-label|title)="([^"]{2,200})"/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null && books.length < 20) {
        const href = m[1];
        const id = m[2];
        if (seen.has(id)) continue;
        seen.add(id);
        const title = decodeEntities(m[3]).trim();
        if (title.length < 2) continue;
        const block = extractBlockAround(html, m.index, 3500);
        const author = extractAuthor(block);
        const cover = extractCover(block, source);
        const price = extractPrice(block);
        const host = source === 'wook' ? 'https://www.wook.pt' : 'https://www.bertrand.pt';
        books.push({
            id,
            title,
            author,
            cover,
            price,
            url: host + href,
            source,
        });
    }

    // Fallback: extract by data-product-name (Bertrand tags products that way)
    if (books.length === 0 && source === 'bertrand') {
        const re = /data-product-id="(\d+)"[^>]*data-product-name="([^"]+)"/g;
        while ((m = re.exec(html)) !== null && books.length < 20) {
            if (seen.has(m[1])) continue;
            seen.add(m[1]);
            const block = extractBlockAround(html, m.index, 3500);
            books.push({
                id: m[1],
                title: decodeEntities(m[2]).trim(),
                author: extractAuthor(block),
                cover: extractCover(block, source),
                price: extractPrice(block),
                url: `https://www.bertrand.pt/livro/-/${m[1]}`,
                source,
            });
        }
    }

    return books;
}

function extractBlockAround(html, idx, radius) {
    return html.substring(Math.max(0, idx - 200), Math.min(html.length, idx + radius));
}

function extractAuthor(block) {
    const m = block.match(/class="authors"[^>]*>[\s\S]{0,600}?(?:<a[^>]*>)?\s*(?:de\s+)?([^<]{3,120})</i)
        || block.match(/class="authors[^"]*"[^>]*>\s*<p>\s*de\s+<a[^>]*>([^<]{3,120})</i);
    return m ? decodeEntities(m[1]).trim() : '';
}

function extractCover(block, source) {
    const host = source === 'wook' ? 'img.wook.pt' : 'img.bertrand.pt';
    const re = new RegExp(`(?:data-src|src)="(https://${host.replace('.', '\\.')}/[^"]+)"`, 'i');
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
