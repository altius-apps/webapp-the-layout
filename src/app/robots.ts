import type { MetadataRoute } from 'next';

// Crawler hygiene (see vault: Supabase Load Diagnosis 2026-08-11). The by-name
// player routes exist to resolve roster names → canonical /players/[id] pages;
// to a crawler they are thousands of long-tail duplicate URLs whose FIRST hit
// always misses the ISR cache and runs a name-resolution RPC (measured at
// 190/min of find_usau_player_by_name). Canonical content lives on /players —
// keep crawlers off the resolvers. /admin and /api are not crawlable content.
// Allowlist-only (2026-08-12): default-deny every crawler, allow only the two
// major well-behaved ones. Middleware enforces the same policy with 403s for
// bots that ignore robots.txt.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: ['Googlebot', 'Bingbot'],
        allow: '/',
        // Invite links (/fantasy/join, /fantasy/invite, /playbook/invite) are
        // deliberately NOT disallowed: their pages send noindex, which a
        // crawler only sees if it may fetch them; a blocked URL that's linked
        // somewhere public can still be listed — code and all.
        disallow: ['/wfdf/players/by-name/', '/euf/players/by-name/', '/players/*/thread', '/admin', '/api/'],
        crawlDelay: 10,
      },
      {
        userAgent: '*',
        disallow: '/',
      },
    ],
  };
}
