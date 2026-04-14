// Vercel Serverless Function - Heartbeat para manter Supabase ativo
// Executado automaticamente via Vercel Cron a cada 5 dias

export default async function handler(req, res) {
    const SUPABASE_URL = 'https://ztixwjxpxjejvcffupcu.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0aXh3anhweGplanZjZmZ1cGN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxNzUxNDAsImV4cCI6MjA5MTc1MTE0MH0.2XZVL-cjJG2Cq08pxOXZHVN3JYUfYeHo_BKDjVPfEgU';

    try {
        // Ping: update heartbeat table
        const response = await fetch(SUPABASE_URL + '/rest/v1/heartbeat?id=eq.1', {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': 'Bearer ' + SUPABASE_KEY,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ last_ping: new Date().toISOString() })
        });

        // Also do a simple SELECT to keep the DB active
        await fetch(SUPABASE_URL + '/rest/v1/books?select=id&limit=1', {
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': 'Bearer ' + SUPABASE_KEY,
            }
        });

        res.status(200).json({
            ok: true,
            message: 'Heartbeat sent',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error.message
        });
    }
}
