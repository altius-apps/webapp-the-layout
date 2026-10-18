// Uptime-monitor target (App Health rule 4, Feature Backlog #20): one 1-row
// read through PostgREST, so "up" means Vercel AND the DB answered. Never
// cached and never rendered at build time (rule 5). /api is outside the
// middleware matcher, and Better Stack / UptimeRobot are Vercel-verified bots,
// so the Bot Protection challenge lets them through (plain curl gets a 429).

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabase/env';

// Both, like the per-user pages: force-dynamic alone still let Next's Data
// Cache answer supabase-js's GET, so the "health" read never reached the DB.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Above anon's 3s statement_timeout, so the DB normally answers first; this
// only cuts off a connection that never answers.
const TIMEOUT_MS = 5000;

const supabase = createClient(supabaseUrl(), supabaseAnonKey(), { auth: { persistSession: false } });

export async function GET() {
  const started = Date.now();
  const { error } = await supabase
    .from('usau_events')
    .select('id')
    .limit(1)
    .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
  const ms = Date.now() - started;
  return NextResponse.json(error ? { ok: false, ms, code: error.code } : { ok: true, ms }, {
    status: error ? 503 : 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
