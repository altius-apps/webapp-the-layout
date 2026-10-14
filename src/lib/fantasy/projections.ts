// Projections — per-player, per-period stat averages for a weekly contest's
// season (fantasy_player_projections RPC, public read). The client scores a
// player's average line by the roster role it sits in, so a projection is
// "what this slot would score in a typical week". Event contests have no
// projections (the RPC returns no rows).

import { createClient } from '@/lib/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { scoreStatLine, type FantasyRole, type FantasyStatLine } from './scoring';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;
function client(): AnyClient {
  return createClient() as unknown as AnyClient;
}

export interface PlayerProjection extends FantasyStatLine {
  playerLeague: string;
  playerId: string;
  playerName: string;
  /** Periods (weeks) the player has stats in this season. */
  periods: number;
}

export type ProjectionMap = Map<string, PlayerProjection>;

export function projectionKey(playerLeague: string, playerId: string): string {
  return `${playerLeague}:${playerId}`;
}

export async function getProjections(contestId: string): Promise<ProjectionMap> {
  const { data, error } = await client().rpc('fantasy_player_projections', { p_contest: contestId });
  if (error) throw new Error(error.message);
  const out: ProjectionMap = new Map();
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const p: PlayerProjection = {
      playerLeague: r.player_league as string,
      playerId: r.player_id as string,
      playerName: r.player_name as string,
      periods: Number(r.periods ?? 0),
      goals: Number(r.goals ?? 0),
      assists: Number(r.assists ?? 0),
      blocks: Number(r.blocks ?? 0),
      turnovers: Number(r.turnovers ?? 0),
      yards: Number(r.yards ?? 0),
      // fantasy_player_projections returns no callahan average.
      callahans: 0,
    };
    out.set(projectionKey(p.playerLeague, p.playerId), p);
  }
  return out;
}

/** Projected points for one slot; null when the player has no season stats. */
export function projectedPoints(p: PlayerProjection | undefined, role: FantasyRole): number | null {
  if (!p || p.periods === 0) return null;
  return Math.round(scoreStatLine(p, role) * 10) / 10;
}

/** Sum of slot projections; slots without a projection count as 0. */
export function projectedTotal(
  slots: { playerLeague: string; playerId: string; role: FantasyRole }[],
  map: ProjectionMap,
): number {
  let total = 0;
  for (const s of slots) total += projectedPoints(map.get(projectionKey(s.playerLeague, s.playerId)), s.role) ?? 0;
  return Math.round(total * 10) / 10;
}

/** Logistic win probability from the projected margin. 12 points of margin
 *  ≈ 73% — one typical slot's swing. Purely a display heuristic. */
export function winProbability(mine: number, theirs: number): number {
  const p = 1 / (1 + Math.exp(-(mine - theirs) / 12));
  return Math.round(p * 100);
}
