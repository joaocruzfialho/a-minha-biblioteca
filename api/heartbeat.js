// Vercel Serverless Function - Heartbeat para manter Supabase ativo
// Executado automaticamente via Vercel Cron todos os dias às 10:00 UTC
// (Supabase pausa após 7 dias sem atividade no plano gratuito)

export default async function handler(req, res) {
    const SUPABASE_URL = 'https://ztixwjxpxjejvcffupcu.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0aXh3anhweGplanZjZmZ1cGN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxNzUxNDAsImV4cCI6MjA5MTc1MTE0MH0.2XZVL-cjJG2Cq08pxOXZHVN3JYUfYeHo_BKDjVPfEgU';

    const results = {};

    // 1. SELECT na tabela books — atividade suficiente para manter o projeto ativo
    try {
        const booksResp = await fetch(SUPABASE_URL + '/rest/v1/books?select=id&limit=1', {
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': 'Bearer ' + SUPABASE_KEY,
            }
        });
        results.books_ping = booksResp.ok ? 'ok (' + booksResp.status + ')' : 'error (' + booksResp.status + ')';
    } catch (e) {
        results.books_ping = 'failed: ' + e.message;
    }

    // 2. Tentar atualizar tabela heartbeat (se existir — nao critica se falhar)
    try {
        const heartbeatResp = await fetch(SUPABASE_URL + '/rest/v1/heartbeat?id=eq.1', {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': 'Bearer ' + SUPABASE_KEY,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ last_ping: new Date().toISOString() })
        });
        results.heartbeat_table = heartbeatResp.ok ? 'ok' : 'skipped (' + heartbeatResp.status + ')';
    } catch (e) {
        results.heartbeat_table = 'skipped';
    }

    const allOk = results.books_ping && results.books_ping.startsWith('ok');

    res.status(allOk ? 200 : 500).json({
        ok: allOk,
        timestamp: new Date().toISOString(),
        results
    });
}
