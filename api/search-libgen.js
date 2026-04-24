// Vercel Serverless Function — pesquisa livros em libgen.li (metadados)
// Usa-se só para enriquecer título/autor/editora/ano/ISBN/idioma.
// Não expõe links de download; devolve só metadados.
// Capa: fallback via OpenLibrary por ISBN quando disponível.

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).end();

    const { q, isbn, debug } = req.query;
    const query = (isbn || q || '').toString().trim();
    if (!query || query.length < 2) return res.status(400).json({ error: 'q or isbn required' });

    // colunas: t=title, a=author, i=isbn; objects[]=f (files); topics[]=l (libgen non-fiction/fiction)
    const params = new URLSearchParams();
    params.set('req', query.substring(0, 200));
    params.append('columns[]', 't');
    params.append('columns[]', 'a');
    params.append('columns[]', 'i');
    params.append('objects[]', 'f');
    params.append('objects[]', 'e');
    params.append('topics[]', 'l');
    params.append('topics[]', 'f');
    params.set('res', '25');

    const targets = [
        `https://libgen.li/index.php?${params}`,
        `https://libgen.is/search.php?${params}`,
    ];

    const meta = { status: 0, bytes: 0, matches: 0, host: '' };
    let html = '';
    for (const url of targets) {
        try {
            const r = await fetch(url, {
                signal: AbortSignal.timeout(10000),
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
                },
            });
            meta.status = r.status;
            meta.host = new URL(url).host;
            if (!r.ok) continue;
            html = await r.text();
            meta.bytes = html.length;
            if (html.length > 3000) break;
        } catch (e) {
            meta.error = String(e).slice(0, 200);
        }
    }

    const books = parseLibgenTable(html);
    meta.matches = books.length;

    const payload = { results: books.slice(0, 12) };
    if (debug === '1') payload.debug = meta;
    return res.status(200).json(payload);
}

function parseLibgenTable(html) {
    if (!html) return [];
    // Localizar a primeira <tbody>...</tbody> depois do cabeçalho "Author"
    const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
    if (!tbodyMatch) return [];
    const tbody = tbodyMatch[1];

    const rows = tbody.split(/<\/tr>/i).map(s => s.trim()).filter(Boolean);
    const books = [];
    const seen = new Set();

    for (const row of rows) {
        const cells = extractCells(row);
        if (cells.length < 6) continue;

        const titleCell = cells[0];
        const titleMatch = titleCell.match(/<a[^>]*href="edition\.php\?id=(\d+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!titleMatch) continue;
        const id = titleMatch[1];
        if (seen.has(id)) continue;
        seen.add(id);

        const title = cleanText(titleMatch[2]).replace(/\s+/g, ' ').trim();
        if (!title || title.length < 2) continue;

        // ISBNs aparecem num segundo <a> com <font color="green">
        const isbnMatch = titleCell.match(/<font[^>]*color="green"[^>]*>([^<]+)<\/font>/i);
        const isbnRaw = isbnMatch ? isbnMatch[1] : '';
        const isbns = isbnRaw.split(/[;,\s]+/).map(s => s.replace(/[^\dXx]/g, '')).filter(s => s.length === 10 || s.length === 13);
        // Preferir ISBN-13
        const isbn = isbns.find(s => s.length === 13) || isbns[0] || '';

        const author = cleanText(cells[1]);
        const publisher = cleanText(cells[2]);
        const year = cleanText(cells[3]).match(/\d{4}/)?.[0] || '';
        const language = cleanText(cells[4]);

        const cover = isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false` : '';

        books.push({
            id,
            title,
            author,
            publisher,
            year,
            language,
            isbn,
            cover,
            url: `https://libgen.li/edition.php?id=${id}`,
            source: 'libgen',
        });
    }

    return books;
}

function extractCells(row) {
    const cells = [];
    const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = re.exec(row)) !== null) cells.push(m[1]);
    return cells;
}

function cleanText(s) {
    return String(s)
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
