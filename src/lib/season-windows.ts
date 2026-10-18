// Date windows shared by the home page and the league data readers. Kept a
// leaf module (no imports) so a data reader can use it without pulling in the
// home-page phase logic — usau/data.ts is imported by client components.

/** How far ahead the home page previews an upcoming game, event or season
 *  (hero slides, Up next) — Hunter, 2026-09-13: "60 days in advance of an
 *  event/season starting". Deliberately wider than season-phase's in-season
 *  horizon: previewing is not being in-season, so a preview 15–60 days out can
 *  sit beside a league that is still `complete` (its champion card) or
 *  `dormant`. */
export const SEASON_PREVIEW_DAYS = 60;

/** Leagues whose pages pick a default season. USAU splits by level: the levels
 *  run on different calendars. */
export type SeasonLeague = 'ufa' | 'pul' | 'wul' | 'euf' | 'usau-club' | 'usau-masters' | 'usau-college';

/** When each league's default season moves to the next year (US Eastern
 *  month/day): about a month before that league's season starts, never just
 *  because next year's first row landed in the DB — six 2027 College rows
 *  arriving in October 2026 flipped every USAU level to 2027 and hid Club
 *  Nationals (Hunter, 2026-10-17: pro leagues flip in February, Club in May).
 *  College season Y starts in January of Y, so it flips in December of Y-1. */
const SEASON_FLIP: Record<SeasonLeague, { month: number; day: number; priorYear?: true }> = {
  ufa: { month: 2, day: 1 },
  pul: { month: 2, day: 1 },
  wul: { month: 2, day: 1 },
  euf: { month: 3, day: 1 },
  'usau-club': { month: 5, day: 1 },
  'usau-masters': { month: 5, day: 1 },
  'usau-college': { month: 12, day: 1, priorYear: true },
};

/** The season a league's pages default to on `now` (US Eastern date). */
export function defaultSeason(league: SeasonLeague, now: Date = new Date()): number {
  const [y, m, d] = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).split('-').map(Number);
  const flip = SEASON_FLIP[league];
  // The season whose flip date falls in this calendar year.
  const season = flip.priorYear ? y + 1 : y;
  return m > flip.month || (m === flip.month && d >= flip.day) ? season : season - 1;
}

/** The newest of `available` at or before `target`; the oldest if all are later. */
export function pickSeason(available: readonly number[], target: number): number | null {
  let pick: number | null = null;
  for (const s of available) if (s <= target && (pick == null || s > pick)) pick = s;
  return pick ?? (available.length > 0 ? Math.min(...available) : null);
}

/** USAU level (league.ts UsauLevel) → its season calendar. */
export function usauSeasonLeague(level: string): SeasonLeague {
  if (level === 'CLUB') return 'usau-club';
  return level.startsWith('COLLEGE') ? 'usau-college' : 'usau-masters';
}
