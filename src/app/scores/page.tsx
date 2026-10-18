// The Games — live UFA feed (server component shell).
// Pulls today's slate from the UFA backend (cached 30s), sorts it so the
// soonest upcoming/live games are at top and finished games sit at the
// bottom, then hands it to the client FeedPage for theming + interactivity.

import { FeedPage } from '@/components/feed-page';
import { getCurrentGames } from '@/lib/ufa/client';
import { sortForFeed } from '@/lib/ufa/format';
import { getToday, usauToday } from '@/lib/today';
import type { UfaGame } from '@/lib/ufa/types';
import { type UsauSeriesStageEvents, type UsauTournamentPage } from '@/lib/usau/data';
import {
  recentUsauTournamentPageCached,
  listUsauSeasonsCached,
  listSeriesStageEventsCached,
} from '@/lib/cached-readers';
import {
  parseLeagueParam,
  parseLevelParam,
  parseSeriesParam,
  type UsauLevel,
  type UsauSeriesStage,
} from '@/lib/league';
import { parseFlightsParam } from '@/lib/usau/flights';
import { defaultSeason, pickSeason, usauSeasonLeague } from '@/lib/season-windows';
import { PageShell } from '@/components/page-shell';
import { PulScores } from '@/components/pul/pul-scores';
import { getPulCurrentSeason } from '@/lib/pul/data';
import { WulScores } from '@/components/wul/wul-scores';
import { getWulResultsSeason } from '@/lib/wul/data';

export const revalidate = 30;

interface Props {
  searchParams: {
    league?: string;
    div?: string;
    level?: string;
    season?: string;
    flight?: string;
    page?: string;
    series?: string;
  };
}

export default async function HomePage({ searchParams }: Props) {
  const league = parseLeagueParam(searchParams.league);
  // USAU competition level (?level=club|college-d1|…). Only read on the USAU view.
  const usauLevel = parseLevelParam(searchParams.level);
  // USAU flight filter (?flight=pro,elite) — Triple Crown Tour tiers, Club only,
  // MULTI-select. Mirrors the /schedule tab so completed games filter by flight.
  // Flights are a CLUB-ONLY concept, so ignore any persisted ?flight when the
  // level isn't Club — otherwise switching Club→Masters carries the flight over
  // and filters out every Masters event (no masters event has a TCT flight),
  // showing a false "No completed tournaments" empty state. The UI already hides
  // the flight control off-Club; this makes the server query agree.
  const usauFlights = usauLevel === 'CLUB' ? parseFlightsParam(searchParams.flight) : [];
  // ?series=sectionals|regionals → one stage's merged tournaments in place of
  // the feed. Pairs that don't exist parse to null and never query.
  const usauSeriesStage = league === 'usau' ? parseSeriesParam(searchParams.series, usauLevel) : null;

  // ── PUL branch ────────────────────────────────────────────────────────────
  if (league === 'pul') {
    const currentSeason = await getPulCurrentSeason();
    const season = parseInt(searchParams.season ?? String(currentSeason), 10) || currentSeason;
    return (
      <PageShell title="Scores" eyebrow={`PUL · ${season} Season`}>
        <PulScores season={season} />
      </PageShell>
    );
  }
  // ── WUL branch ────────────────────────────────────────────────────────────
  if (league === 'wul') {
    const currentSeason = await getWulResultsSeason();
    const season = parseInt(searchParams.season ?? String(currentSeason), 10) || currentSeason;
    return (
      <PageShell title="Scores" eyebrow={`WUL · Western Ultimate League · ${season}`}>
        <WulScores season={season} />
      </PageShell>
    );
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Only the USAU view consumes usauEvent (FeedPage renders it solely when
  // league==='usau'). The USAU lookup is a multi-query Supabase chain
  // (getCurrentEvent → getEvent) that previously ran on EVERY scores render
  // inside Promise.all — so the default UFA view blocked on data it never
  // showed, causing slow/stalled loads. Gate it on the active league so UFA
  // renders as fast as its own ~fast API call. (Mirrors how /schedule gates
  // its USAU fetch.) Switching to USAU re-fetches on that navigation.
  const EMPTY_USAU_PAGE: UsauTournamentPage = { cards: [], total: 0, page: 0, pageCount: 1 };
  const usauSeries = usauSeriesStage
    ? await loadUsauSeries(usauSeriesStage, usauLevel, searchParams.season)
    : null;
  const [games, usauPage] = await Promise.all([
    getCurrentGames().catch((err) => {
      console.error('Failed to fetch UFA current games:', err);
      return [] as UfaGame[];
    }),
    league === 'usau' && !usauSeries
      ? loadUsauPage(usauLevel, usauFlights, searchParams).catch((err) => {
          console.error('Failed to load recent USAU tournaments:', err);
          return EMPTY_USAU_PAGE;
        })
      : Promise.resolve(EMPTY_USAU_PAGE),
  ]);
  const today = getToday();
  return (
    <FeedPage
      games={sortForFeed(games)}
      today={today}
      usauPage={usauPage}
      usauLevel={usauLevel}
      usauSeries={usauSeries}
      usauToday={usauToday()}
    />
  );
}

/**
 * USAU results page fetch (mobile parity 2026-08-16):
 *   • ?season absent ⇒ the level's default season; ?season=all ⇒ every season;
 *     ?season=YYYY ⇒ that year.
 *   • ?page is 1-based in the URL (absent ⇒ 1). Out-of-range pages (filters
 *     narrowed the set) clamp to the last real page with one refetch.
 */
async function loadUsauPage(
  usauLevel: ReturnType<typeof parseLevelParam>,
  usauFlights: ReturnType<typeof parseFlightsParam>,
  searchParams: Props['searchParams'],
): Promise<UsauTournamentPage> {
  const season = searchParams.season === 'all' ? null : await resolveUsauSeason(searchParams.season, usauLevel);
  const requested = Math.min(MAX_USAU_PAGE, Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1)) - 1;
  // Eastern-date cutoff, passed explicitly so it's part of the cache key —
  // otherwise the "recent" window freezes at whenever the entry was built.
  const today = usauToday();
  const result = await recentUsauTournamentPageCached(today, usauLevel, usauFlights, season, requested);
  if (requested > 0 && requested >= result.pageCount) {
    return recentUsauTournamentPageCached(today, usauLevel, usauFlights, season, result.pageCount - 1);
  }
  return result;
}

/** One series stage (?series=) for the season in the URL, else the latest.
 *  Null when the stage has no rows that season — the normal feed renders. */
async function loadUsauSeries(
  stage: UsauSeriesStage,
  level: UsauLevel,
  seasonParam: string | undefined,
): Promise<UsauSeriesStageEvents | null> {
  const season = await resolveUsauSeason(seasonParam, level);
  if (season == null) return null;
  return listSeriesStageEventsCached(usauToday(), season, stage, level);
}

// ?season and ?page are cache-key args: every distinct value is a fresh
// Supabase read, so a crawler walking arbitrary values fans out on the DB
// (App Health rule 3). Seasons must exist; pages are capped well above the
// deepest feed (Club, every season ≈ 70 pages) — deeper requests clamp to the
// last real page as before.
const MAX_USAU_PAGE = 200;

/** A season that has USAU data, else the level's default season. Not simply the
 *  newest: the seasons list spans every level, so early 2027 College rows
 *  flipped Club to an empty 2027 (season-windows.ts). */
async function resolveUsauSeason(param: string | undefined, level: UsauLevel): Promise<number | null> {
  const seasons = await listUsauSeasonsCached();
  const parsed = parseInt(param ?? '', 10);
  return seasons.includes(parsed) ? parsed : pickSeason(seasons, defaultSeason(usauSeasonLeague(level)));
}
