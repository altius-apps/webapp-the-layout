// Player ratings — the ranked player list for event contests (Hunter,
// 2026-10-09). fantasy_player_ratings holds one row per player in the event's
// draft pool, rebuilt in the background by fantasy_rebuild_player_ratings
// (weekly cron, Mondays 10:44 UTC, plus manual runs while the formula is tuned). Public
// read. Autodraft takes the team's queue first, then the best-ranked player
// still available — fantasy_draft_best_available reads the same rows.
//
// The order is one composite score (0..1) from the player's last 5 seasons at
// the event's own level (Club for Club Nationals, College for College
// Nationals), recent seasons counting most:
//   • 50%  goals + assists per event, over events where the player has a stat
//          line (USAU tracks no blocks)
//   • 30%  Nationals finishes
//   • 10%  Nationals appearances
//   • 10%  TCT appearances (Club only; College has no Triple Crown Tour)
// USAU issues a new player id every season, so a career is every stint with
// the player's name (the same rule the player profile uses).
//
// Division leagues (settings.division): each row carries the division of the
// player's team at the event and a rank within it. getContestRatings returns
// only that division's rows and swaps `rank` for the division rank, so every
// surface that shows "#N" (Players tab, draft rooms, board tiles) agrees.

import { createClient } from '@/lib/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { EVENT_SCORING, scoreEventLine } from './event-adapter';
import { contestDivision } from './competitions';
import type { ContestView } from './leagues';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;
function client(): AnyClient {
  return createClient() as unknown as AnyClient;
}

/** S = has scored at past events · A = Nationals/TCT experience · B = flight
 *  events only · C = no history at this level. */
export type RatingTier = 'S' | 'A' | 'B' | 'C';

export interface PlayerRating {
  playerLeague: string;
  playerId: string;
  playerName: string;
  teamName: string | null;
  /** 1 = best in the contest's pool: the division rank in a division league,
   *  the all-divisions rank otherwise. Gaps appear as players are drafted. */
  rank: number;
  /** The all-divisions rank, whatever the league's division. */
  overallRank: number;
  /** The player's team's division at the event; null on rows not yet rebuilt. */
  division: 'men' | 'women' | 'mixed' | null;
  /** Composite 0..1 the rank sorts by. */
  score: number | null;
  tier: RatingTier;
  /** Past events where the player's team had stats tracked. */
  statEvents: number;
  avgGoals: number;
  avgAssists: number;
  nationals: number;
  tctEvents: number;
  proEliteEvents: number;
  eliteSelectEvents: number;
  selectEvents: number;
}

export type RatingMap = Map<string, PlayerRating>;

export function ratingKey(playerLeague: string, playerId: string): string {
  return `${playerLeague}:${playerId}`;
}

function mapRating(r: Record<string, unknown>, inDivision: boolean): PlayerRating {
  return {
    playerLeague: r.player_league as string,
    playerId: r.player_id as string,
    playerName: r.player_name as string,
    teamName: (r.team_name as string | null) ?? null,
    rank: (inDivision ? r.division_rank : r.rank) as number,
    overallRank: r.rank as number,
    division: (r.division as PlayerRating['division']) ?? null,
    score: r.score == null ? null : Number(r.score),
    tier: r.tier as RatingTier,
    statEvents: Number(r.stat_events ?? 0),
    avgGoals: Number(r.avg_goals ?? 0),
    avgAssists: Number(r.avg_assists ?? 0),
    nationals: Number(r.nationals ?? 0),
    tctEvents: Number(r.tct_events ?? 0),
    proEliteEvents: Number(r.pro_elite_events ?? 0),
    eliteSelectEvents: Number(r.elite_select_events ?? 0),
    selectEvents: Number(r.select_events ?? 0),
  };
}

const PAGE = 1000; // PostgREST's per-response row cap; a Nationals pool is ~1,250.

/** Every rated player in the contest's pool, best first. [] for weekly
 *  contests and for events whose ratings haven't been built yet. A division
 *  league gets only its division, ranked within it. */
export async function getContestRatings(contest: ContestView): Promise<PlayerRating[]> {
  if (contest.settings.mode !== 'event' || !contest.settings.eventId) return [];
  const division = contestDivision(contest.settings);
  const inDivision = division !== 'all';
  const out: PlayerRating[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = client()
      .from('fantasy_player_ratings')
      .select(
        'player_league, player_id, player_name, team_name, rank, division, division_rank, score, tier, stat_events, avg_goals, avg_assists, nationals, tct_events, pro_elite_events, elite_select_events, select_events',
      )
      .eq('event_id', contest.settings.eventId)
      .eq('player_league', contest.competitionDef.playerLeague);
    if (inDivision) query = query.eq('division', division);
    const { data, error } = await query.order(inDivision ? 'division_rank' : 'rank').range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const r of rows) out.push(mapRating(r, inDivision));
    if (rows.length < PAGE) return out;
  }
}

export function toRatingMap(ratings: PlayerRating[]): RatingMap {
  return new Map(ratings.map((r) => [ratingKey(r.playerLeague, r.playerId), r]));
}

/** Projected fantasy points for one event: the player's per-event averages
 *  scored like a real event line, without the team-placement bonus. Null when
 *  the player has no tracked events. */
export function projectedEventPoints(r: PlayerRating): number | null {
  if (r.statEvents === 0) return null;
  return Math.round(scoreEventLine({ goals: r.avgGoals, assists: r.avgAssists, callahans: 0 }, null) * 10) / 10;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One short line on why the player sits where they do: scoring when there is
 *  any, then the strongest experience signal. */
export function ratingSummary(r: PlayerRating): string {
  const parts: string[] = [];
  if (r.statEvents > 0) parts.push(`${(r.avgGoals + r.avgAssists).toFixed(1)} G+A per event`);
  if (r.nationals > 0) parts.push(`${r.nationals}× Nationals`);
  else if (r.tctEvents > 0) parts.push(plural(r.tctEvents, 'TCT event', 'TCT events'));
  else if (r.proEliteEvents > 0) parts.push(plural(r.proEliteEvents, 'Pro-Elite event', 'Pro-Elite events'));
  else if (r.eliteSelectEvents > 0) parts.push(plural(r.eliteSelectEvents, 'Elite-Select event', 'Elite-Select events'));
  else if (r.selectEvents > 0) parts.push(plural(r.selectEvents, 'Select Flight event', 'Select Flight events'));
  return parts.length > 0 ? parts.join(' · ') : 'No past events on record';
}

/** Plain-language explainer for the list header and the rules modal. College
 *  has no Triple Crown Tour, so its formula line leaves TCT out. */
export function ratingExplainer(competition: ContestView['competition']): string[] {
  const club = competition === 'usau-club-nationals';
  return [
    club
      ? 'Ranks blend four things from the last 5 seasons, recent seasons counting most: goals + assists per event the player has a stat line for (50%), Nationals finishes (30%), Nationals appearances (10%) and TCT appearances (10%).'
      : 'Ranks blend three things from the last 5 seasons, recent seasons counting most: goals + assists per event the player has a stat line for, Nationals finishes and Nationals appearances.',
    'In a division league, ranks are within that division.',
    `Proj = those averages scored like this event (${EVENT_SCORING.goal} per goal, ${EVENT_SCORING.assist} per assist), before any team-finish bonus.`,
    'If your clock runs out, autodraft picks for you: your queue first, then the top-ranked player left.',
  ];
}
