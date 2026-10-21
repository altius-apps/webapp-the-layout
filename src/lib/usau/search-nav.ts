// Search result shape + routing helper.
//
// Deliberately isolated from usau/data.ts: the nav search components
// (search-bar, search-modal) are client components loaded on EVERY page, and
// importing anything from usau/data.ts drags its top-level supabase-js import
// (~60 kB) into the global bundle. `SearchResult` (a type) and `resultHref`
// (a pure routing switch) have zero runtime dependencies, so keeping them here
// lets the nav import them without pulling in the whole USAU data layer.

import type { Flight } from '@/lib/usau/flights';
import { usauEventHref } from '@/lib/usau/event-href';

export interface SearchResult {
  kind: 'team' | 'player' | 'tournament';
  /** team/player → UUID; tournament → usau_slug (the /usau/events/[slug] route). */
  id: string;
  name: string;
  /** Secondary line — team name for a player, state/level for a team,
   *  season + dates for a tournament. */
  hint: string | null;
  /** For tournaments only: curated Triple Crown Tour flight (or null). */
  flight?: Flight | null;
  /** USAU tournaments only: the division that matched best when one did
   *  ("rocky mountain womens") — the link opens that tab. */
  division?: string | null;
  /** Which league this result belongs to — drives routing (resultHref).
   *  Tournaments are USAU or WFDF. Defaults to 'usau' for legacy USAU rows. */
  league?: 'usau' | 'ufa' | 'pul' | 'wul' | 'wfdf' | 'euf';
  /** Resolved team logo path/URL (local `/teams/...` or remote R2 URL), or null
   *  when we have no logo — the result renderer falls back to a name monogram.
   *  Teams only; players/tournaments leave this undefined. */
  logoUrl?: string | null;
  /** Relevance/prominence score for ranking (higher = more prominent). Adult
   *  club + pro-league teams outrank college, which outranks youth/HS/MS — so
   *  a query like "Colorado" floats real clubs above U-20/Academy noise. The
   *  search comparator sorts by match-quality first, then this. */
  prominence?: number;
  /** Match-quality tier vs. the query, stamped by searchAll: 0 exact, 1 whole-
   *  word, 2 prefix, 3 contains/fuzzy. Lets the modal ORDER GROUPS by best
   *  match so a strong player hit can outrank weak team hits. Lower = better. */
  matchRank?: number;
  /** Tournaments only: the season, so tournament results list newest first. */
  season?: number;
}

/**
 * Build the destination href for a search result. League-aware so a single
 * helper can be shared by every search component (search-bar, search-modal)
 * instead of duplicating the routing switch.
 *
 *   - tournament → /usau/events/{slug}  (tournaments are USAU-only)
 *   - player     → /players/{id}        (all leagues use the unified profile)
 *   - team       → by league: usau→/usau/teams, ufa→/teams, pul→/pul/teams, wul→/wul/teams
 */
export function resultHref(r: SearchResult): string {
  if (r.kind === 'tournament') {
    // Tournaments belong to USAU or WFDF; route by league.
    if (r.league === 'wfdf') return `/wfdf/events/${r.id}`;
    if (r.league === 'euf') return `/euf/events/${r.id}`;
    return usauEventHref(r.id, r.division);
  }
  if (r.kind === 'player') {
    // WFDF isn't an anchor league — its players have no /players/[id]. Route to
    // the name-resolver, which redirects to the unified profile if the person
    // exists in an anchor league, else shows a WFDF-only view. `id` carries the
    // full name for WFDF player results.
    if (r.league === 'wfdf') return `/wfdf/players/by-name/${encodeURIComponent(r.id)}`;
    // EUF is likewise not an anchor league — its player ids are per-event, so
    // results carry the NAME and route to the by-name profile.
    if (r.league === 'euf') return `/euf/players/by-name/${encodeURIComponent(r.id)}`;
    return `/players/${r.id}`;
  }
  // team
  switch (r.league) {
    case 'ufa':
      return `/teams/${r.id}`;
    case 'pul':
      return `/pul/teams/${r.id}`;
    case 'wul':
      return `/wul/teams/${r.id}`;
    case 'wfdf':
      return `/wfdf/teams/${r.id}`;
    case 'euf': {
      // EUF team ids are per-event, so results carry "name|division" and route
      // to the club page, which merges every appearance of that club-division.
      const [eufName, eufDiv] = r.id.split('|');
      return `/euf/clubs/${encodeURIComponent(eufName)}${
        eufDiv ? `?div=${encodeURIComponent(eufDiv)}` : ''
      }`;
    }
    case 'usau':
    default:
      return `/usau/teams/${r.id}`;
  }
}
