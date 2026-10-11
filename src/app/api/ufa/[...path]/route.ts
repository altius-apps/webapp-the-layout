// Catch-all proxy to backend.ufastats.com — keeps the browser off CORS issues
// and centralizes caching. Mirrors the same TTL policy as the server-side
// client in src/lib/ufa/client.ts.

import { NextRequest, NextResponse } from 'next/server';
import { UFA_BASE } from '@/lib/ufa/client';

export const runtime = 'nodejs';

// Upstream paths the app actually proxies (useLiveGames → games?current=true /
// games?gameID=). Exact match, so `..` segments can't reach other upstream paths.
const ALLOWED_PATHS = new Set(['games']);

export async function GET(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  const path = params.path.join('/');
  if (!ALLOWED_PATHS.has(path)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const search = req.nextUrl.search;
  const ttl = ttlForRequest(req.nextUrl.searchParams);
  const upstream = `${UFA_BASE}/${path}${search}`;

  const res = await fetch(upstream, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (the-layout-proxy)',
      Accept: 'application/json',
    },
    next: { revalidate: ttl },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return NextResponse.json(
      { error: 'UFA upstream error', status: res.status, body: body.slice(0, 400) },
      { status: res.status },
    );
  }

  const data = await res.json();
  return NextResponse.json(data, {
    headers: {
      'Cache-Control': `public, s-maxage=${ttl}, stale-while-revalidate=86400`,
      'X-Ufa-Upstream-Path': `/${path}`,
      'X-Ufa-Cache-TTL': String(ttl),
    },
  });
}

// Only `games` passes ALLOWED_PATHS.
function ttlForRequest(params: URLSearchParams): number {
  if (params.get('current') === 'true' || params.get('sidebar') === 'true') return 30;
  if (params.has('gameID')) return 30;
  return 300;
}
