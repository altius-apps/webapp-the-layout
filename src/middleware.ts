import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';
import { NAV_MENU_SECTIONS } from '@/lib/nav-menu-sections';

// Crawler policy (2026-08-12 incident, see vault "Supabase Load Diagnosis
// 2026-08-11"): allowlist-only. Anything that identifies as a bot or scraping
// framework and is not in ALLOWED_BOTS gets 403 everywhere. Allowed bots still
// get 503 + Retry-After on the /players surfaces until the profile read path
// stops rebuilding inline — lift that block only after the async-rebuild fix
// is verified. Real browsers match neither test. robots.ts mirrors this policy.
// Google's non-Googlebot crawlers (GoogleOther = bulk crawl, Google-InspectionTool
// = Search Console) match neither BOT_UA nor ALLOWED_BOTS, so they used to fall
// through as ordinary browser traffic and render the expensive surfaces.
// 2026-08-12 evening sweep: a scraper with a plain Chrome UA walked ~1k unique
// /players/[id] pages in <1h. UA matching can only catch the sloppy tools
// (HeadlessChrome et al. below); honest-looking browser UAs need Vercel Bot
// Protection (Firewall → challenge mode) — that's the real gate, not this regex.
const BOT_UA =
  /bot|crawl|spider|slurp|facebookexternalhit|meta-external|python-requests|python-httpx|scrapy|go-http-client|java\/|libwww|googleother|google-inspectiontool|headlesschrome|phantomjs|puppeteer|playwright|selenium|curl\/|wget\/|okhttp|axios\/|node-fetch/i;
const ALLOWED_BOTS = /googlebot|bingbot|google-inspectiontool/i;

export async function middleware(request: NextRequest) {
  // The mega-menu's cached data route: unknown sections 404 here so they can't
  // each become an ISR cache entry. Known ones skip the session refresh.
  if (request.nextUrl.pathname.startsWith('/api/nav-menu/')) {
    const section = request.nextUrl.pathname.slice('/api/nav-menu/'.length);
    return (NAV_MENU_SECTIONS as readonly string[]).includes(section)
      ? NextResponse.next()
      : new NextResponse('Not found', { status: 404 });
  }
  const ua = request.headers.get('user-agent') ?? '';
  if (BOT_UA.test(ua)) {
    if (!ALLOWED_BOTS.test(ua)) {
      return new NextResponse('Forbidden', { status: 403 });
    }
    if (
      request.nextUrl.pathname.includes('/players') ||
      request.nextUrl.pathname.startsWith('/usau/teams')
    ) {
      return new NextResponse('Crawling temporarily paused', {
        status: 503,
        headers: { 'Retry-After': '86400' },
      });
    }
  }
  return await updateSession(request);
}

export const config = {
  // NOTE: this file must live in `src/` (next to `app/`), not the repo root —
  // for a src/-based app Next.js ignores a root-level middleware.ts.
  //
  // Runs the Supabase session refresh on EVERY page route (was: only the 5
  // auth-reading route groups). Rationale: iOS Safari force-expires JS-set
  // cookies after 7 days, so signed-in users who only browse public pages
  // (scores, teams…) were silently logged out on mobile within a week — the
  // server-set cookies this middleware produces are exempt from that cap.
  // updateSession() short-circuits before any network call when the request
  // has no auth cookie, so anonymous traffic pays nothing.
  //
  // Excluded: static assets/images (no session semantics), /api (the UFA
  // proxy — latency-sensitive data fetches that never read the session), and
  // /.well-known (Apple's AASA fetcher is "AASA-Bot", which BOT_UA would 403,
  // silently breaking Universal Links).
  // Each protected route still enforces its own auth (assertAdmin /
  // assertTeamEditor / client gate) — this middleware is cookie refresh, not
  // the access gate.
  matcher: [
    '/api/nav-menu/:path*',
    '/((?!api|\\.well-known|_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|txt|xml|css|js|map)$).*)',
  ],
};
