// Server-only caching layer over the public league readers.
//
// The pages that consume these (/scores, /players, home standings) read
// `searchParams`, which forces per-request dynamic rendering — so their
// route-level `revalidate` exports never take effect and every request would
// otherwise hit Supabase. All of this data is public (world-readable RLS, anon
// client), so we can safely memoize it across requests with `unstable_cache`,
// keyed by the reader's own arguments and refreshed every 5 minutes.
//
// This lives in its own `server-only` module on purpose: the raw data modules
// (e.g. usau/data.ts) are intentionally importable from client components
// (live player search, mega-menu). `next/cache` is server-only, so keeping the
// cache wrappers out of those modules avoids pulling server APIs into the
// client bundle. Client components keep importing the raw readers directly.

import 'server-only';
import { unstable_cache } from 'next/cache';

import {
  recentUsauTournamentPage as _recentUsauTournamentPage,
  listOfficialUsauRankings as _listOfficialUsauRankings,
  listUsauClubStandings as _listUsauClubStandings,
  listUsauPlayers as _listUsauPlayers,
  listSeasons as _listSeasons,
  listSeriesStageEvents as _listSeriesStageEvents,
  listUsauScheduleUpcoming as _listUsauScheduleUpcoming,
  type CompetitionLevel,
} from '@/lib/usau/data';
import type { Flight } from '@/lib/usau/flights';
import {
  listPulPlayers as _listPulPlayers,
  getPulStandings as _getPulStandings,
} from '@/lib/pul/data';
import {
  listWulPlayers as _listWulPlayers,
  getWulStandings as _getWulStandings,
} from '@/lib/wul/data';

// Public standings/leaderboard data changes at most a few times a day during
// a season; 5 minutes keeps it fresh while collapsing repeat traffic to one
// DB read per window.
const REVALIDATE_SECONDS = 300;

// `today` (yyyy-mm-dd, US Eastern — see usauToday) is an EXPLICIT cache-key arg
// rather than a `new Date()` default evaluated inside the cached body. It gates
// which events count as "recent" (start_date <= today), so leaving it out of the
// key froze the cutoff at whenever the entry was first computed and let the NEXT
// weekend's tournaments show up a day early. competitionLevel, flights, season
// and page are likewise serialized, so each combination memoizes independently.
// `flights` must be passed in canonical order (see parseFlightsParam) so the same
// selection always yields the same cache key.
export const recentUsauTournamentPageCached = unstable_cache(
  (
    today: string,
    competitionLevel: CompetitionLevel = 'CLUB',
    flights: Flight[] = [],
    season: number | null = null,
    page = 0,
  ) =>
    _recentUsauTournamentPage(
      new Date(`${today}T12:00:00Z`),
      undefined,
      competitionLevel,
      flights,
      season,
      page,
    ),
  ['usau-recent-tournament-page'],
  { revalidate: REVALIDATE_SECONDS },
);

// One series stage's merged tournaments (/scores and /schedule ?series=).
// `today` is an explicit key arg for the same reason as above: it decides which
// members have started and so get champions.
export const listSeriesStageEventsCached = unstable_cache(
  _listSeriesStageEvents,
  ['usau-series-stage-events'],
  { revalidate: REVALIDATE_SECONDS },
);

// /schedule's upcoming USAU calendar. `today` decides "hasn't started yet",
// so it's a key arg; flights must be in canonical order (parseFlightsParam).
export const usauScheduleCached = unstable_cache(
  _listUsauScheduleUpcoming,
  ['usau-schedule-upcoming'],
  { revalidate: REVALIDATE_SECONDS },
);

// Seasons list for /scores' server-side season default (absent ?season ⇒
// latest season with data). Tiny query, long-lived data.
export const listUsauSeasonsCached = unstable_cache(
  _listSeasons,
  ['usau-seasons'],
  { revalidate: REVALIDATE_SECONDS },
);

export const listOfficialUsauRankingsCached = unstable_cache(
  _listOfficialUsauRankings,
  ['usau-official-rankings'],
  { revalidate: REVALIDATE_SECONDS },
);

export const listUsauClubStandingsCached = unstable_cache(
  _listUsauClubStandings,
  ['usau-club-standings'],
  { revalidate: REVALIDATE_SECONDS },
);

// Cached variant for the SERVER call site only. The client-side live search in
// players-search-list.tsx must keep calling the raw `listUsauPlayers` (browser
// can't run unstable_cache), so we do not touch that export.
export const listUsauPlayersCached = unstable_cache(
  _listUsauPlayers,
  ['usau-players'],
  { revalidate: REVALIDATE_SECONDS },
);

export const listPulPlayersCached = unstable_cache(
  _listPulPlayers,
  ['pul-players'],
  { revalidate: REVALIDATE_SECONDS },
);

export const getPulStandingsCached = unstable_cache(
  _getPulStandings,
  ['pul-standings'],
  { revalidate: REVALIDATE_SECONDS },
);

export const listWulPlayersCached = unstable_cache(
  _listWulPlayers,
  ['wul-players'],
  { revalidate: REVALIDATE_SECONDS },
);

export const getWulStandingsCached = unstable_cache(
  _getWulStandings,
  ['wul-standings'],
  { revalidate: REVALIDATE_SECONDS },
);
