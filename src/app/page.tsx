// The Layout — home page, restructured to the "Home v2" design spec.
// Server component: fetches today's slate + current standings + team-stats in
// parallel and hands shaped data to the home components.
//
// Page order (desktop, per HomeV2 in the design source, restructured so all
// standings live together at the top):
//   1. Nav (AppRail — untouched)
//   2. Full-width hero carousel (UFA → USAU → WFDF → PUL → WUL)
//   3. "Every league, one place." strip
//   4. "Up next" — UFA + USAU cards, side by side on desktop (a lone card
//      spans the row with two inner columns)
//   5. LEAGUE STANDINGS group — "Top of the league" (4 UFA division cards),
//      "Recent results" (one card per IN-SEASON league, swipe row on mobile),
//      USAU Rankings (full-width 4×4 grid of the top 16), then the "Season
//      complete" carousel
//   6. Footer
//
// Which leagues appear where is decided by src/lib/home/season-phase.ts: a
// league is `in-season` (Recent results), `complete` (Season complete, for six
// months after its final) or `dormant` (neither). Every section wrapper is
// gated on content, so an empty section is absent — never a blank band — and
// the row primitives (StandingsCarousel / UpNextCards) rebalance to whatever
// count is left. Any league with no current content is simply omitted.

import React from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  getAllGamesByYears,
  getCurrentGames,
  getStandings,
  getTeamStats,
  currentSeasonYear,
} from '@/lib/ufa/client';
import { gameUiState } from '@/lib/ufa/format';
import {
  pickTopGame,
  pickUpcomingGameOfWeek,
  pickPlayoffSlate,
  pickAllStarGame,
  isAllStarGame,
} from '@/lib/ufa/game-of-the-week';
import type { UfaGame, UfaStanding, UfaTeamStat } from '@/lib/ufa/types';
import {
  getCurrentEvent,
  listNextUpcomingEvents,
  getEvent,
  recentUsauMajorsWithChampions,
  listSeriesStages,
  type UsauFeedCard,
  type CompetitionLevel,
} from '@/lib/usau/data';
import { listPulGames, getPulCurrentSeason } from '@/lib/pul/data';
import { listWulGames, getWulCurrentSeason, getWulResultsSeason } from '@/lib/wul/data';
import { AppRail } from '@/components/app-rail';
import { HeroGameCard } from '@/components/home/hero-game-card';
import { HomeHero, type KeyedSlide } from '@/components/home/home-hero';
import { HeroUsauSlide, HeroUsauSeriesSlide } from '@/components/home/hero-usau-slide';
import { HeroPulSlide } from '@/components/home/hero-pul-slide';
import { HeroWulSlide } from '@/components/home/hero-wul-slide';
import { HeroWfdfSlide } from '@/components/home/hero-wfdf-slide';
import { getCurrentWfdfEvent } from '@/lib/wfdf/data';
import { teamMeta, ALL_STAR_TEAM_META } from '@/lib/ufa/teams';
import { LeaguesStrip } from '@/components/home/leagues-strip';
import { ufaDivisionCards, pulStandingsCard, wulStandingsCard } from '@/components/home/standings-strip';
import { RankingsCard } from '@/components/home/rankings-card';
import { UpNextCards } from '@/components/home/up-next-card';
import { RecentResultsCards } from '@/components/home/recent-results-card';
import {
  PulSeasonCompleteSection,
  WulSeasonCompleteSection,
  UfaSeasonCompleteSection,
  UsauSeasonCompleteSection,
  WfdfSeasonCompleteSection,
} from '@/components/home/league-standings-sections';
import { StandingsCarousel } from '@/components/home/standings-carousel';
import {
  getWfdfSeasonCompleteCards,
  getUfaSeasonCompleteCard,
  getUsauSeasonCompleteCard,
  getUsauCollegeSeasonCompleteCard,
} from '@/lib/home/season-complete';
import {
  homeNow,
  ufaSeasonPhase,
  pulSeasonPhase,
  wulSeasonPhase,
  usauClubSeasonPhase,
  usauCollegeSeasonPhase,
  wfdfEventPhase,
  isCollegeChampionshipsName,
  ufaTitleSeasonGames,
} from '@/lib/home/season-phase';
import { SEASON_PREVIEW_DAYS } from '@/lib/season-windows';
import { getPulStandingsCached, getWulStandingsCached } from '@/lib/cached-readers';
import { StandoutsCarousel } from '@/components/home/standouts-carousel';
import { getStandoutPerformances } from '@/lib/home/standouts';
import { SiteFooter } from '@/components/site-footer';
import { usauToday } from '@/lib/today';

// 5 min: home data (standouts/scores blocks) only moves when crons ingest, and
// at 60s the standouts award scan (a paginated full-season stat read) was
// recomputing every minute under crawler traffic. See Supabase Load Diagnosis
// 2026-08-11 (vault).
export const revalidate = 300;

/** How long a finished game may headline the hero as "Game of the week". */
const HERO_RESULT_WINDOW_DAYS = 14;

export const metadata: Metadata = {
  title: 'The Layout · Ultimate Frisbee',
  description:
    'Live scores, standings, and stats for UFA, USAU, and more — The Layout.',
};

export default async function HomePage() {
  // One clock for every phase decision on the page (HOME_AS_OF overrides it
  // outside production so any month can be previewed).
  const now = homeNow();
  const year = currentSeasonYear(now);

  // USAU hero pick for one level group: current tournament via weekend cadence —
  // mirrors scores/page.tsx pattern. Can be LAST weekend's finished event. A
  // whole series stage can headline instead ("2026 USAU Sectionals"). No
  // DB-wide fallback: an out-of-season level just drops its slide.
  const usauHeroPick = async (competitionLevels: CompetitionLevel[]) => {
    const pick = await getCurrentEvent({ competitionLevels });
    if (!pick) return null;
    if ('series' in pick) return { kind: 'series' as const, series: pick.series };
    const event = await getEvent(pick.slug);
    return event ? { kind: 'event' as const, event } : null;
  };

  // Fetch all data sources in parallel. Cross-league fetches are gated with
  // try/catch via Promise.allSettled so a failure in one league never breaks
  // the page — the slide is simply omitted.
  const [gamesRes, seasonRes, standingsRes, teamStatsRes, usauRes, usauUpNextRes, pulRes, wulRes, usauMajorsRes, wfdfRes, standoutsRes, wfdfSeasonRes, usauCollegeRes, usauSeriesRes, usauCollegeHeroRes] =
    await Promise.allSettled([
      getCurrentGames(),
      // Season-wide fetch so "Up next" stays populated between weekends.
      getAllGamesByYears([year]),
      getStandings(),
      getTeamStats({ year }),
      // USAU hero, Club slide — College gets its own slide (last entry), so
      // the two levels never compete for one card. Masters stays here.
      usauHeroPick(['CLUB', 'MASTERS', 'GRAND_MASTERS', 'GREAT_GRAND_MASTERS']),
      // USAU ("Up next" card): the next several UPCOMING flighted tournaments,
      // always forward-looking (unlike getCurrentEvent, which looks back Sun–Tue).
      // A LIST (not one event's pool games) so the card stays full even before
      // any games are ingested for the nearest event. Fetch the whole preview
      // window (the limit only slices — same query cost) so every level section
      // (Club / College / Masters) has supply; a small slice let College fall
      // invitationals crowd Club out. UpNextCards caps rows per section.
      listNextUpcomingEvents(50),
      // PUL: upcoming-this-week else most-recent final. Season resolved from the
      // data (newest present) so it self-advances and never queries an empty year.
      (async () => listPulGames({ season: await getPulCurrentSeason() }))(),
      // WUL: same rule, plus the newest season with results when that's older:
      // next season's schedule lands ~3 months before its first game, and a
      // pool of only unplayed games would drop the Season complete card early.
      (async () => {
        const [current, results] = await Promise.all([getWulCurrentSeason(), getWulResultsSeason()]);
        const seasons = current === results ? [current] : [current, results];
        return (await Promise.all(seasons.map((season) => listWulGames({ season })))).flat();
      })(),
      // USAU: recent completed CLUB majors (TCT events) with champions — ONE
      // scan shared by "Recent results" (first 4), the Club Nationals "Season
      // complete" card (found by name) and the club season-phase (a major
      // newer than Nationals = next season underway). 12 reaches back through
      // a full club season. `limit` only slices the output; cost is the same.
      recentUsauMajorsWithChampions(12),
      // WFDF: the live Worlds, else the next within SEASON_PREVIEW_DAYS, else
      // one that just finished — or null.
      getCurrentWfdfEvent(),
      // Standout player performances (last 4 weeks, strength-gated recency) for
      // the home carousel. UFA/PUL/WUL wired; only leagues with recent games
      // contribute. Cheap windowed Supabase reads (per-game box-score tables).
      getStandoutPerformances(),
      // WFDF: podium-per-division cards for every Worlds that ended within the
      // last six months — the "Season complete" carousel's WFDF page(s).
      getWfdfSeasonCompleteCards(now),
      // USAU College Championships (D-I + D-III), one card, for the spring →
      // autumn window when Club has nothing complete. Two events, tiny scan.
      recentUsauMajorsWithChampions(2, {
        competitionLevels: ['COLLEGE_D1', 'COLLEGE_D3'],
        nameFilter: isCollegeChampionshipsName,
      }),
      // USAU Club series stages (sectionals, regionals) that started in the
      // last 60 days — a finished stage gets one "Recent results" row.
      listSeriesStages({
        startFrom: usauToday(new Date(now.getTime() - 60 * 86400_000)),
        startTo: usauToday(now),
        levels: ['CLUB'],
      }),
      // USAU hero, College slide (D-I + D-III).
      usauHeroPick(['COLLEGE_D1', 'COLLEGE_D3']),
    ]);

  const currentGames: UfaGame[] = gamesRes.status === 'fulfilled' ? gamesRes.value : [];
  const seasonGames: UfaGame[] = seasonRes.status === 'fulfilled' ? seasonRes.value : [];
  // Merge — current-week feed wins on id collision so live/score updates take
  // precedence over the schedule snapshot.
  const gamesByID = new Map<string, UfaGame>();
  for (const g of seasonGames) gamesByID.set(g.gameID, g);
  for (const g of currentGames) gamesByID.set(g.gameID, g);
  const games: UfaGame[] = Array.from(gamesByID.values());
  const standings: UfaStanding[] =
    standingsRes.status === 'fulfilled' ? standingsRes.value : [];
  const teamStats: UfaTeamStat[] =
    teamStatsRes.status === 'fulfilled' ? teamStatsRes.value.stats ?? [] : [];
  const standouts =
    standoutsRes.status === 'fulfilled' ? standoutsRes.value : [];

  // ── Cross-league slide data ──────────────────────────────────────────────
  const usauPick = usauRes.status === 'fulfilled' ? usauRes.value : null;
  const usauEvent = usauPick?.kind === 'event' ? usauPick.event : null;
  const usauSeries = usauPick?.kind === 'series' ? usauPick.series : null;
  const collegePick = usauCollegeHeroRes.status === 'fulfilled' ? usauCollegeHeroRes.value : null;
  const collegeEvent = collegePick?.kind === 'event' ? collegePick.event : null;
  const collegeSeries = collegePick?.kind === 'series' ? collegePick.series : null;

  // USAU "Up next" card: a LIST of upcoming flighted tournaments (forward-looking,
  // unlike the hero's getCurrentEvent which looks back Sun–Tue). Listing several
  // events keeps the card full even when the nearest one has no games ingested yet.
  const usauUpcomingEvents = usauUpNextRes.status === 'fulfilled' ? usauUpNextRes.value : [];

  // WFDF: events are sparse, so unlike USAU the slide shows only when a Worlds
  // is genuinely current — live, starting within SEASON_PREVIEW_DAYS, or ended
  // in the last two weeks (getCurrentWfdfEvent returns null otherwise), so a
  // months-old or months-away Worlds never lingers in the loop. (USAU can
  // headline year-round because its calendar is dense.)
  const wfdfEvent = wfdfRes.status === 'fulfilled' ? wfdfRes.value : null;

  // PUL: prefer the next game within SEASON_PREVIEW_DAYS; fall back to a final
  // from the last 7 days (Eastern dates).
  const pulGames = pulRes.status === 'fulfilled' ? pulRes.value : [];
  const pulFeatured = pickLeagueGame(pulGames, now);

  // WUL: same rule.
  const wulGames = wulRes.status === 'fulfilled' ? wulRes.value : [];
  const wulFeatured = pickLeagueGame(wulGames, now);

  // UFA hero games:
  //  - topGame  → LIVE game only (undefined when nothing is on — the slide
  //               then drops; it NEVER falls back to a past/future game).
  //  - gotwGame → best UPCOMING marquee matchup; the always-present UFA slide
  //               (games[0] keeps it from being empty mid-season; EmptyHero
  //               renders for a truly empty slate).
  const topGame = pickTopGame(games, standings);
  // Fallback keeps the UFA slide non-empty mid-season: the soonest upcoming/
  // live game, else the most recent final — but only for HERO_RESULT_WINDOW_DAYS
  // after it was played, so a finished season's title game doesn't headline
  // as "Game of the week" until next April (Hunter, 2026-09-09). Never a
  // cancelled/postponed game NOR the all-star exhibition (it has its own
  // slide — no game appears on two cards). Undefined → the UFA slide drops
  // when another league has a slide, else the EmptyHero off-season card.
  const heroTs = (g: UfaGame): number => (g.startTimestamp ? new Date(g.startTimestamp).getTime() : 0);
  // Both windows count whole Eastern days (usauToday) so neither rolls over at
  // 8 pm ET.
  const gameDay = (g: UfaGame): string => (g.startTimestamp ? usauToday(new Date(g.startTimestamp)) : '');
  const heroResultFrom = usauToday(new Date(now.getTime() - HERO_RESULT_WINDOW_DAYS * 86400_000));
  // Upcoming games preview only SEASON_PREVIEW_DAYS ahead: a schedule published
  // in January must not headline April's opener or August's All-Star game.
  const previewUntil = usauToday(new Date(now.getTime() + SEASON_PREVIEW_DAYS * 86400_000));
  const inPreview = (g: UfaGame): boolean => !gameUiState(g).isUpcoming || gameDay(g) <= previewUntil;
  const heroPool = games.filter((g) => !isAllStarGame(g) && !gameUiState(g).isCancelled && inPreview(g));
  const firstShowableGame =
    heroPool
      .filter((g) => {
        const st = gameUiState(g);
        return st.isUpcoming || st.isLive;
      })
      .sort((a, b) => heroTs(a) - heroTs(b))[0] ??
    heroPool
      .filter((g) => gameUiState(g).isFinal && gameDay(g) >= heroResultFrom)
      .sort((a, b) => heroTs(b) - heroTs(a))[0];
  const gotwGame = pickUpcomingGameOfWeek(games.filter(inPreview), standings) ?? firstShowableGame;

  // Playoff mode: when the soonest active week is a playoff round, EVERY game
  // in it gets its own labeled slide ("Semifinal"/"Championship") — the
  // win%-scored GOTW is playoff-blind and benched Empire–Spiders on one game
  // of record difference (Hunter, 2026-08-26). Empty outside the playoffs.
  const playoffSlate = pickPlayoffSlate(games);
  // Champ-weekend WUL/PUL All-Star exhibition — once-a-year slide; undefined
  // outside its window (upcoming within SEASON_PREVIEW_DAYS, live, or up to
  // 3 days after the final).
  const allStarGame = pickAllStarGame(games.filter(inPreview));

  // Records for a game's two teams (from current standings).
  const recordOf = (slug?: string): string | undefined => {
    if (!slug) return undefined;
    const s = standings.find((row) => row.teamID === slug);
    if (!s) return undefined;
    return s.ties > 0 ? `${s.wins}-${s.losses}-${s.ties}` : `${s.wins}-${s.losses}`;
  };

  // Two derived slices fed to the "Up next" / "Recent results" cards:
  //  - upNext: next 4 games chronologically (Live or Upcoming, soonest first)
  //  - recent: last 4 results (Final, most recent first)
  // We intentionally don't exclude the featured (hero) game — when there's
  // only one upcoming game on the slate, hiding it leaves the row empty.
  const tsOf = (g: UfaGame): number =>
    g.startTimestamp ? new Date(g.startTimestamp).getTime() : 0;

  // Supply up to 6 upcoming UFA games; the UpNextCards component decides how
  // many to actually SHOW (equal-height match to the USAU card). Was capped at
  // 4, which left the card short next to USAU's 5 tournaments.
  const upNext = games
    .filter((g) => {
      const s = gameUiState(g);
      return (s.isUpcoming || s.isLive) && inPreview(g);
    })
    .sort((a, b) => tsOf(a) - tsOf(b))
    .slice(0, 6);

  const recent = games
    .filter((g) => gameUiState(g).isFinal)
    .sort((a, b) => tsOf(b) - tsOf(a))
    .slice(0, 4);

  // Recent USAU CLUB majors (TCT events with champions), newest first.
  const usauMajors = usauMajorsRes.status === 'fulfilled' ? usauMajorsRes.value : [];
  const usauCollege = usauCollegeRes.status === 'fulfilled' ? usauCollegeRes.value : [];

  // For "Recent results": up to 4 rows per league regardless of age (the
  // pickLeagueGame 7-day window is for the hero carousel only — for the
  // results card we want to show the championship weekend even if the season
  // ended weeks ago). Order: final → semifinals (date desc) → most-recent
  // regular-season games, filling to 4. Neither league has quarterfinals, so
  // the 4th slot is always the latest regular-season game, not a quarter.
  const pulRecentFour = pickPulRecentFour(pulGames);
  const wulRecentFour = pickWulRecentFour(wulGames);

  // ── Season phase per league ─────────────────────────────────────────────────
  // UFA's title game lives in whichever season last ran a bracket: until this
  // year's bracket is decided that's the PREVIOUS season, so pull it in (one
  // cached API read) rather than let the champion card vanish at the year
  // boundary. Keyed on the data, not the calendar month: the read stops the
  // moment the pool holds a decided bracket.
  const prevYearGames: UfaGame[] =
    ufaTitleSeasonGames(games).length === 0 ? await getAllGamesByYears([year - 1]).catch(() => []) : [];
  // Dedupe by gameID: the current-week feed keeps serving last season's final
  // weekend into January, and a doubled week-16 reads as a bulk week.
  const ufaPoolByID = new Map<string, UfaGame>();
  for (const g of prevYearGames) ufaPoolByID.set(g.gameID, g);
  for (const g of games) ufaPoolByID.set(g.gameID, g);
  const ufaPhasePool = Array.from(ufaPoolByID.values());
  const ufaPhase = ufaSeasonPhase(ufaPhasePool, now);
  const pulPhase = pulSeasonPhase(pulGames, now);
  const wulPhase = wulSeasonPhase(wulGames, now);
  const usauPhase = usauClubSeasonPhase(usauMajors, usauUpcomingEvents, now);
  const collegePhase = usauCollegeSeasonPhase(usauCollege, usauUpcomingEvents, now);

  // ── "Season complete" carousel pages ────────────────────────────────────────
  // Order: UFA → USAU (Club, College) → PUL → WUL → WFDF. A league contributes
  // only while its phase is `complete`; each section resolves to null when the
  // data can't back a card, so a null page never leaves a dead dot.
  const wfdfSeasonCards = (wfdfSeasonRes.status === 'fulfilled' ? wfdfSeasonRes.value : []).filter(
    (card) => wfdfEventPhase(card, now).phase === 'complete',
  );

  // PUL/WUL standings (cached readers) — for a COMPLETE season, the season
  // whose final the playoff pickers resolved (the "Season complete" card);
  // for an IN-SEASON league, the season the games feed is on (the "Top of the
  // league" card). Dormant → no read.
  const pulSeason = pulRecentFour[0]?.game.season;
  const wulSeason = wulRecentFour[0]?.game.season;
  const pulStandingsSeason =
    pulPhase.phase === 'complete' ? pulSeason : pulPhase.phase === 'in-season' ? pulGames[0]?.season : undefined;
  const wulStandingsSeason =
    wulPhase.phase === 'complete' ? wulSeason : wulPhase.phase === 'in-season' ? wulGames[0]?.season : undefined;
  const [pulStandings, wulStandings] = await Promise.all([
    pulStandingsSeason ? getPulStandingsCached(pulStandingsSeason).catch(() => []) : [],
    wulStandingsSeason ? getWulStandingsCached(wulStandingsSeason).catch(() => []) : [],
  ]);

  const ufaSeasonNode =
    ufaPhase.phase === 'complete'
      ? UfaSeasonCompleteSection({ card: getUfaSeasonCompleteCard(ufaTitleSeasonGames(ufaPhasePool), standings) })
      : null;
  const usauSeasonNode =
    usauPhase.phase === 'complete'
      ? UsauSeasonCompleteSection({ card: getUsauSeasonCompleteCard(usauMajors) })
      : null;
  const collegeSeasonNode =
    collegePhase.phase === 'complete'
      ? UsauSeasonCompleteSection({ card: getUsauCollegeSeasonCompleteCard(usauCollege) })
      : null;
  const pulSeasonNode =
    pulPhase.phase === 'complete' && pulSeason
      ? PulSeasonCompleteSection({ season: pulSeason, playoffs: pulRecentFour, standings: pulStandings })
      : null;
  const wulSeasonNode =
    wulPhase.phase === 'complete' && wulSeason
      ? WulSeasonCompleteSection({ season: wulSeason, playoffs: wulRecentFour, standings: wulStandings })
      : null;

  const seasonCompleteCards: Array<{ label: string; node: React.ReactNode }> = [
    ...(ufaSeasonNode ? [{ label: 'UFA', node: ufaSeasonNode }] : []),
    ...(usauSeasonNode ? [{ label: 'USAU Club', node: usauSeasonNode }] : []),
    ...(collegeSeasonNode ? [{ label: 'USAU College', node: collegeSeasonNode }] : []),
    ...(pulSeasonNode ? [{ label: 'PUL', node: pulSeasonNode }] : []),
    ...(wulSeasonNode ? [{ label: 'WUL', node: wulSeasonNode }] : []),
    ...wfdfSeasonCards.map((card) => ({
      label: card.name,
      node: <WfdfSeasonCompleteSection key={card.slug} card={card} />,
    })),
  ];

  // ── "Recent results" cards — in-season leagues only ─────────────────────────
  // A finished season lives in the "Season complete" card instead (its playoff
  // rows carry the same results), so no league appears in both sections.
  // USAU rows: the latest Club majors plus any FINISHED series stage, newest
  // first — one "2026 USAU Sectionals" row stands in for its 27 sections.
  const usauTodayIso = usauToday(now);
  const usauFinishedStages = (usauSeriesRes.status === 'fulfilled' ? usauSeriesRes.value : []).filter(
    (s) => s.endDate != null && s.endDate < usauTodayIso,
  );
  const usauRecentCards: UsauFeedCard[] = [
    ...usauFinishedStages.map((s) => ({ kind: 'series' as const, ...s })),
    ...usauMajors.slice(0, 4).map((m) => ({ kind: 'event' as const, ...m })),
  ]
    .sort(
      (a, b) =>
        (b.endDate ?? '').localeCompare(a.endDate ?? '') ||
        (a.kind === 'series' ? 0 : 1) - (b.kind === 'series' ? 0 : 1),
    )
    .slice(0, 4);

  const recentResultCards = RecentResultsCards({
    ufaGames: ufaPhase.phase === 'in-season' ? recent : [],
    usauMajors: usauPhase.phase === 'in-season' ? usauRecentCards : [],
    pulGames: pulPhase.phase === 'in-season' ? pulRecentFour : [],
    wulGames: wulPhase.phase === 'in-season' ? wulRecentFour : [],
  });

  // "Top of the league" — every IN-SEASON league's current table (a finished
  // league's table lives in its "Season complete" card instead). UFA: one
  // card per division; PUL/WUL: one card each. The UFA feed carries its own
  // season, so the eyebrow follows the data (not the calendar year) and a
  // zeroed preseason table hides rather than showing 0-0 rows.
  const standingsYear = standings.length > 0 ? Math.max(...standings.map((s) => s.year)) : year;
  const showUfaStandings = ufaPhase.phase === 'in-season' && standings.some((s) => s.wins + s.losses + s.ties > 0);
  const pulTopCard = pulPhase.phase === 'in-season' ? pulStandingsCard(pulStandings) : null;
  const wulTopCard = wulPhase.phase === 'in-season' ? wulStandingsCard(wulStandings) : null;
  const topOfLeagueCards = [
    ...(showUfaStandings ? ufaDivisionCards(standings, teamStats) : []),
    ...(pulTopCard ? [pulTopCard] : []),
    ...(wulTopCard ? [wulTopCard] : []),
  ];
  const topOfLeagueLeagues = [
    ...(showUfaStandings ? ['UFA'] : []),
    ...(pulTopCard ? ['PUL'] : []),
    ...(wulTopCard ? ['WUL'] : []),
  ];
  const topOfLeagueYear = showUfaStandings ? standingsYear : (pulStandingsSeason ?? wulStandingsSeason ?? year);
  const topOfLeagueHref = showUfaStandings ? '/teams' : pulTopCard ? '/pul/teams' : '/wul/teams';

  // ── Build carousel slides (order: UFA → USAU → WFDF → PUL → WUL) ────────
  // Each builder returns null when the league has no current content; null
  // entries are filtered out so offseason leagues simply don't appear. Each
  // slide carries an identity key so HomeHero can drop it when the signed-in
  // user's STARRED items (prepended client-side) already show the same
  // game/event.
  const slideCandidates: Array<KeyedSlide | null> = [
    // UFA "Top game" slide — LIVE game only. Rendered ONLY while a UFA game is
    // in progress; dropped otherwise (no past/future fallback, so it can't show
    // a different game than the Game-of-the-week highlight). Suppressed while
    // the playoff slate is active: the live playoff game already has its own
    // labeled slide there, and two cards for one game reads as a bug.
    topGame && playoffSlate.length === 0
      ? {
          key: `ufa:${topGame.gameID}`,
          node: (
            <HeroGameCard
              key="ufa-top"
              game={topGame}
              awayRecord={recordOf(topGame.awayTeamID)}
              homeRecord={recordOf(topGame.homeTeamID)}
              eyebrow="Top game"
            />
          ),
        }
      : null,
    // UFA headline slide(s). During a playoff round: one slide PER game in the
    // round, labeled by round — with two semifinals there is no "the" game of
    // the week, so both show. Otherwise the single win%-picked Game of the
    // week. With no game to show (off-season, two weeks past the final) the
    // slide is dropped — unless it would be the ONLY slide, in which case it
    // renders the EmptyHero off-season card so the carousel never goes empty.
    ...(playoffSlate.length > 0
      ? playoffSlate.map(({ game: pg, label }) => ({
          key: `ufa:${pg.gameID}`,
          node: (
            <HeroGameCard
              key={`ufa-playoff-${pg.gameID}`}
              game={pg}
              awayRecord={recordOf(pg.awayTeamID)}
              homeRecord={recordOf(pg.homeTeamID)}
              eyebrow={label}
            />
          ),
        }))
      : gotwGame || !(allStarGame || usauEvent || usauSeries || collegeEvent || collegeSeries || wfdfEvent || pulFeatured || wulFeatured)
        ? [
            {
              key: gotwGame ? `ufa:${gotwGame.gameID}` : 'ufa:empty',
              node: (
                <HeroGameCard
                  key="ufa-gotw"
                  game={gotwGame}
                  awayRecord={recordOf(gotwGame?.awayTeamID)}
                  homeRecord={recordOf(gotwGame?.homeTeamID)}
                  eyebrow="Game of the week"
                />
              ),
            },
          ]
        : []),
    // Champ-weekend WUL/PUL All-Star exhibition — its own once-a-year slide,
    // rendered with LEAGUE marks (the API's allstars1/2 ids carry no
    // franchise; see ALL_STAR_TEAM_META for the side-mapping caveat).
    allStarGame
      ? {
          key: `ufa:${allStarGame.gameID}`,
          node: (
            <HeroGameCard
              key="ufa-allstar"
              game={allStarGame}
              eyebrow="All-Star Game"
              awayMeta={ALL_STAR_TEAM_META[allStarGame.awayTeamID]}
              homeMeta={ALL_STAR_TEAM_META[allStarGame.homeTeamID]}
            />
          ),
        }
      : null,
    // USAU — Club then College tournament cards, each null when its level has
    // no current event.
    usauEvent ? { key: `usau:${usauEvent.slug}`, node: <HeroUsauSlide key="usau" event={usauEvent} /> } : null,
    usauSeries
      ? {
          key: `usau-series:${usauSeries.id}`,
          node: <HeroUsauSeriesSlide key="usau-series" series={usauSeries} today={usauToday(now)} />,
        }
      : null,
    collegeEvent
      ? { key: `usau:${collegeEvent.slug}`, node: <HeroUsauSlide key="usau-college" event={collegeEvent} /> }
      : null,
    collegeSeries
      ? {
          key: `usau-series:${collegeSeries.id}`,
          node: <HeroUsauSeriesSlide key="usau-college-series" series={collegeSeries} today={usauToday(now)} />,
        }
      : null,
    // WFDF — Worlds tournament card, null in the off-season. Same weekend flip.
    wfdfEvent ? { key: `wfdf:${wfdfEvent.slug}`, node: <HeroWfdfSlide key="wfdf" event={wfdfEvent} /> } : null,
    // PUL — game card, null when no current/recent game.
    pulFeatured ? { key: `pul:${pulFeatured.id}`, node: <HeroPulSlide key="pul" game={pulFeatured} /> } : null,
    // WUL — game card, null when no current/recent game.
    wulFeatured ? { key: `wul:${wulFeatured.id}`, node: <HeroWulSlide key="wul" game={wulFeatured} /> } : null,
  ];
  const slides = slideCandidates.filter((s): s is KeyedSlide => s !== null);

  return (
    <div className="min-h-screen bg-bg text-ink pb-[calc(max(env(safe-area-inset-bottom),0.75rem)+96px)] lg:pb-0">
      {/* Global top rail — app switching + logo + account (untouched) */}
      <AppRail />

      {/* 1. Full-width hero carousel — starred items lead for signed-in users */}
      <div className="px-5 lg:px-10 pt-6 lg:pt-8">
        <HomeHero slides={slides} />
      </div>

      {/* 2. "Every league, one place." strip */}
      <div className="px-5 lg:px-10 pt-7">
        {/* Mobile-only section head per the v2 mobile spec — desktop puts the
            headline inside the strip card itself. */}
        <h2 className="lg:hidden font-display italic font-bold text-[26px] leading-[0.95] tracking-[-0.02em] text-ink m-0 mb-3">
          Every league
        </h2>
        <LeaguesStrip />
      </div>

      {/* 3. "Standout performances" — rotating carousel of the best individual
             stat-lines from recent games across every wired league (UFA, PUL,
             WUL, USAU Nationals). Each line retires on its own significance
             (a killer performance lasts ~3 weeks), UFA award-watch tags ride
             the same clock, and the section is absent once nothing survives.
             Sits above "Up next" so player highlights lead. */}
      {standouts.length > 0 && (
        <div className="px-5 lg:px-10 pt-9 lg:pt-11">
          <div className="flex items-end justify-between gap-4 mb-4 lg:mb-5">
            <div>
              <span className="block text-[10.5px] font-bold tracking-[0.18em] uppercase text-accent font-sans mb-2">
                Player spotlight
              </span>
              <h2 className="font-display italic font-bold text-[26px] lg:text-[34px] leading-[0.95] tracking-[-0.02em] text-ink m-0">
                Standout performances
              </h2>
            </div>
          </div>
          <StandoutsCarousel lines={standouts} />
        </div>
      )}

      {/* 4. "Up next" — UFA + USAU cards, side by side on desktop so they
             fill the width instead of stacking narrow in a single column; a
             lone card spans both columns. Wrapper only when there's a card. */}
      {(upNext.length > 0 || usauUpcomingEvents.length > 0) && (
        <div className="px-5 lg:px-10 pt-9 lg:pt-11 grid grid-cols-1 lg:grid-cols-2 gap-5">
          <UpNextCards ufaGames={upNext} usauEvents={usauUpcomingEvents} />
        </div>
      )}

      {/* 4. LEAGUE STANDINGS group — every league's current standing, together,
             in one vertical stack: UFA divisions → USAU rankings → PUL/WUL. */}

      {/* 4a. "Top of the league" — in-season standings: UFA division cards
             and/or the PUL and WUL tables. Absent when no league is running. */}
      {topOfLeagueCards.length > 0 && (
        <div className="px-5 lg:px-10 pt-9 lg:pt-11">
          <div className="flex items-end justify-between gap-4 mb-4 lg:mb-5">
            <div>
              <span className="block text-[10.5px] font-bold tracking-[0.18em] uppercase text-accent font-sans mb-2">
                {topOfLeagueLeagues.join(' · ')} · {topOfLeagueYear}
              </span>
              <h2 className="font-display italic font-bold text-[26px] lg:text-[34px] leading-[0.95] tracking-[-0.02em] text-ink m-0">
                Top of the league
              </h2>
            </div>
            <Link
              href={topOfLeagueHref}
              className="text-[11px] font-bold tracking-[0.12em] uppercase text-muted no-underline inline-flex items-center gap-1.5 hover:text-accent transition-colors whitespace-nowrap pb-[3px]"
            >
              Standings
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 8H13M13 8L8.5 3.5M13 8L8.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
              </svg>
            </Link>
          </div>
          <StandingsCarousel
            cards={topOfLeagueCards.map((c) => c.node)}
            labels={topOfLeagueCards.map((c) => c.label)}
            ariaLabel="Standings"
          />
        </div>
      )}

      {/* 4b. "Recent results" — one card per in-season league: a swipe row on
             mobile, a balanced grid (no lopsided column) on desktop. Sits
             directly under the UFA cards, above the rankings (Hunter, 2026-09-11). */}
      {recentResultCards.length > 0 && (
        <div className="px-5 lg:px-10 pt-9 lg:pt-11">
          <StandingsCarousel
            cards={recentResultCards.map((c) => c.node)}
            labels={recentResultCards.map((c) => c.label)}
            ariaLabel="Recent results"
          />
        </div>
      )}

      {/* 4c. USAU Rankings — full-width 4×4 grid of the top 16, with matching
             horizontal padding so its outer edges line up with the cards above. */}
      <div className="px-5 lg:px-10 pt-5 lg:pt-6">
        <RankingsCard />
      </div>

      {/* 4d. "Season complete" carousel — one equal-height card per league
             whose season finished in the last six months (UFA playoffs +
             standings, USAU podiums, PUL/WUL playoffs + standings, WFDF
             podiums): a swipe row on mobile, a balanced grid on desktop —
             3 per row, not 4: four across at 1280px is ~255px per card and
             the playoff score rows overlap (2026-09-11). */}
      {seasonCompleteCards.length > 0 && (
        <div className="px-5 lg:px-10 pt-5 lg:pt-6">
          <StandingsCarousel
            cards={seasonCompleteCards.map((c) => c.node)}
            labels={seasonCompleteCards.map((c) => c.label)}
            desktopMaxPerRow={3}
            ariaLabel="Completed seasons"
          />
        </div>
      )}

      <div className="pt-9 lg:pt-11">
        <SiteFooter />
      </div>
    </div>
  );
}

// ─── Cross-league game picker ────────────────────────────────────────────────
// For PUL and WUL: prefer the next game within SEASON_PREVIEW_DAYS; if none,
// fall back to a final from the last 7 days. Returns null when the season has
// no games in either window (e.g. offseason — that's the correct "no slide"
// case). Dates are Eastern (usauToday), the one clock the home page uses.
//
// Works with both PulGame and WulGame since both have the same shape:
//   { status: 'scheduled'|'final', gameDate: string|null }

import type { PulGame } from '@/lib/pul/data';
import type { WulGame } from '@/lib/wul/data';
import { deriveWulPostseasonRounds } from '@/lib/wul/data';

/** Shared minimal shape for both PulGame and WulGame. */
type LeagueGame = { status: 'scheduled' | 'final'; gameDate: string | null };

function pickLeagueGameGeneric<T extends LeagueGame>(games: T[], now: Date): T | null {
  if (games.length === 0) return null;

  // yyyy-mm-dd compares as a string, same as gameDate.
  const today = usauToday(now);
  const previewUntil = usauToday(new Date(now.getTime() + SEASON_PREVIEW_DAYS * 86400_000));

  // Next game within the preview window (soonest first)
  const upcoming = games
    .filter((g) => g.status === 'scheduled' && g.gameDate !== null && g.gameDate >= today && g.gameDate <= previewUntil)
    .sort((a, b) => (a.gameDate ?? '').localeCompare(b.gameDate ?? ''));

  if (upcoming.length > 0) return upcoming[0];

  // Most recent final within the last 7 days. A 7-day window lets a league
  // keep showing its just-played game for a week, then drops off — so once a
  // season ends, the slide disappears rather than lingering on stale results
  // (PUL/WUL ended ~1–2wk ago and should NOT show until next season's data).
  const sevenDaysAgo = usauToday(new Date(now.getTime() - 7 * 86400_000));
  const recent = games
    .filter((g) => g.status === 'final' && g.gameDate !== null && g.gameDate >= sevenDaysAgo && g.gameDate <= today)
    .sort((a, b) => (b.gameDate ?? '').localeCompare(a.gameDate ?? ''));

  return recent.length > 0 ? recent[0] : null;
}

// Typed wrappers — preserve the concrete return type so JSX props satisfy.
function pickLeagueGame(games: PulGame[], now: Date): PulGame | null;
function pickLeagueGame(games: WulGame[], now: Date): WulGame | null;
function pickLeagueGame(games: PulGame[] | WulGame[], now: Date): PulGame | WulGame | null {
  return pickLeagueGameGeneric(games as PulGame[], now);
}

// ─── "Recent results" 4-row pickers (PUL / WUL) ──────────────────────────────
// Neither league has quarterfinals — playoffs are 2 semifinals + 1 final. To
// fill each league's group to 4 rows (matching UFA's 4-row group), we show
// the championship weekend (final + both semis) plus the most recent
// regular-season game from the latest season that has a completed final — or,
// while a season is still being played (no final yet), its latest results.
// `round` drives each row's label/emphasis; only 'final' gets the trophy
// treatment, never a bare 'week' game and never a semifinal.

export type PulRecentRound = 'final' | 'semifinal' | 'regular';
export interface PulRecentGame {
  game: PulGame;
  round: PulRecentRound;
}

function pickPulRecentFour(games: PulGame[]): PulRecentGame[] {
  const finals = games.filter((g) => g.status === 'final');
  if (finals.length === 0) return [];

  // Resolve to the latest season that actually has a completed Finals game —
  // guards against a new season's early regular-season games outranking last
  // season's still-most-recent championship weekend. With no Finals yet, the
  // season in progress shows its latest results.
  const seasonsWithFinal = [...new Set(finals.filter((g) => g.weekLabel === 'finals').map((g) => g.season))];
  const season = Math.max(...(seasonsWithFinal.length > 0 ? seasonsWithFinal : finals.map((g) => g.season)));
  const seasonFinals = finals.filter((g) => g.season === season);

  const byDateDesc = (a: PulGame, b: PulGame) => (b.gameDate ?? '').localeCompare(a.gameDate ?? '');

  const finalGame = seasonFinals.find((g) => g.weekLabel === 'finals') ?? null;
  const semis = seasonFinals.filter((g) => g.weekLabel === 'semifinals').sort(byDateDesc);
  const regular = seasonFinals
    .filter((g) => g.weekLabel !== 'finals' && g.weekLabel !== 'semifinals')
    .sort(byDateDesc);

  const out: PulRecentGame[] = [];
  if (finalGame) out.push({ game: finalGame, round: 'final' });
  for (const g of semis) out.push({ game: g, round: 'semifinal' });
  for (const g of regular) {
    if (out.length >= 4) break;
    out.push({ game: g, round: 'regular' });
  }
  return out.slice(0, 4);
}

export type WulRecentRound = 'final' | 'semifinal' | 'third' | 'regular';
export interface WulRecentGame {
  game: WulGame;
  round: WulRecentRound;
}

function pickWulRecentFour(games: WulGame[]): WulRecentGame[] {
  const finals = games.filter((g) => g.status === 'final');
  if (finals.length === 0) return [];

  const rounds = deriveWulPostseasonRounds(finals);
  const seasonsWithFinal = [
    ...new Set(finals.filter((g) => rounds.get(g.id) === 'final').map((g) => g.season)),
  ];
  // No final yet → the season in progress shows its latest results.
  const season = Math.max(...(seasonsWithFinal.length > 0 ? seasonsWithFinal : finals.map((g) => g.season)));
  const seasonFinals = finals.filter((g) => g.season === season);

  const byDateDesc = (a: WulGame, b: WulGame) => (b.gameDate ?? '').localeCompare(a.gameDate ?? '');

  const finalGame = seasonFinals.find((g) => rounds.get(g.id) === 'final') ?? null;
  const semis = seasonFinals.filter((g) => rounds.get(g.id) === 'semifinal').sort(byDateDesc);
  // WUL plays an explicit 3rd-place game on championship day — its own row so
  // the "Season complete" card shows the whole bracket.
  const third = seasonFinals.find((g) => rounds.get(g.id) === 'third_place') ?? null;
  // Everything else: regular season, plus any postseason game
  // deriveWulPostseasonRounds left unclassified — treated as filler, ordered
  // most-recent first, same as regular season.
  const filler = seasonFinals
    .filter((g) => !rounds.has(g.id))
    .sort(byDateDesc);

  const out: WulRecentGame[] = [];
  if (finalGame) out.push({ game: finalGame, round: 'final' });
  for (const g of semis) out.push({ game: g, round: 'semifinal' });
  if (third) out.push({ game: third, round: 'third' });
  for (const g of filler) {
    if (out.length >= 4) break;
    out.push({ game: g, round: 'regular' });
  }
  return out.slice(0, 4);
}
