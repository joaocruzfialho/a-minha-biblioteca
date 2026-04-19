// Vercel Serverless Function — pesquisa livros em lojas portuguesas
// Tenta Wook.pt e Bertrand.pt via fetch server-side (bypass CORS do browser)
// Retorna JSON com array de livros encontrados

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).end();

    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.status(400).json({ error: 'q required' });

    const query = q.trim().substring(0, 150);
    const results = [];

    const HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.5',
        'Cache-Control': 'no-cache',
    };

    // ─── Wook.pt ───────────────────────────────────────────────────────────
    try {
        const wookUrl = `https://www.wook.pt/pesquisa?q=${encodeURIComponent(query)}`;
        const r = await fetch(wookUrl, { headers: HEADERS, signal: AbortSignal.timeout(6000) });
        if (r.ok) {
            const html = await r.text();
            const books = parseJsonLd(html, 'wook');
            books.forEach(b => results.push(b));
        }
    } catch (_) {}

    // ─── Bertrand.pt ────────────────────────────────────────────────────────
    try {
        const bertrandUrl = `https://www.bertrand.pt/pesquisa?q=${encodeURIComponent(query)}`;
        const r = await fetch(bertrandUrl, { headers: HEADERS, signal: AbortSignal.timeout(6000) });
        if (r.ok) {
            const html = await r.text();
            const books = parseJsonLd(html, 'bertrand');
            books.forEach(b => results.push(b));
        }
    } catch (_) {}

    // Deduplicate by ISBN or title+author
    const seen = new Set();
    const unique = results.filter(b => {
        const key = b.isbn || (b.title + '|' + b.author).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return res.status(200).json({ results: unique.slice(0, 10) });
}

function parseJsonLd(html, source) {
    const books = [];
    const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        try {
            const data = JSON.parse(m[1]);
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
                const extracted = extractBook(item, source);
                if (extracted) books.push(extracted);
                // ItemList
                if (item['@type'] === 'ItemList' && Array.isArray(item.itemListElement)) {
                    for (const el of item.itemListElement.slice(0, 5)) {
                        const sub = el.item || el;
                        const b = extractBook(sub, source);
                        if (b) books.push(b);
                    }
                }
            }
        } catch (_) {}
    }

    // Fallback: extract from product microdata or meta tags if JSON-LD empty
    if (books.length === 0) {
        const titleRe = /<(?:h2|h3)[^>]+class="[^"]*(?:title|name|product)[^"]*"[^>]*>\s*<a[^>]*>([^<]{4,80})<\/a>/gi;
        while ((m = titleRe.exec(html)) !== null && books.length < 5) {
            const title = m[1].trim();
            if (title) books.push({ title, author: '', isbn: '', cover: '', source });
        }
    }

    return books.slice(0, 6);
}

function extractBook(item, source) {
    if (!item || (item['@type'] !== 'Book' && item['@type'] !== 'Product')) return null;
    const title = item.name || item.headline || '';
    if (!title || title.length < 2) return null;
    const author = item.author?.name || item.author?.[0]?.name || '';
    const isbn = item.isbn || item.gtin13 || item.productID || '';
    const cover = item.image?.url || item.image || '';
    const publisher = item.publisher?.name || '';
    const year = item.datePublished ? String(item.datePublished).substring(0, 4) : '';
    return { title, author, isbn: String(isbn).replace(/[^0-9]/g, ''), cover, publisher, year, source };
}
