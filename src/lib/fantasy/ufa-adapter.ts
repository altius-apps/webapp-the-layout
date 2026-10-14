// UFA → fantasy stat-line adapter.
//
// Maps a `ufa_game_player_stats` DB row into the league-agnostic
// FantasyStatLine the scoring engine consumes. This is the ONE place the
// UFA-specific derivations live:
//   • turnovers  = throwaways + drops + stalls  (no single upstream field)
//   • yards      = yards_thrown + yards_received
//
// Future leagues (WUL/PUL) get their own adapter with the same output shape.

import type { FantasyStatLine } from './scoring';

/** The columns we read from ufa_game_player_stats (snake_case, as stored). */
export interface UfaStatRow {
  goals: number;
  assists: number;
  blocks: number;
  throwaways: number;
  drops: number;
  stalls: number;
  yards_thrown: number;
  yards_received: number;
  callahans: number;
}

export function ufaRowToStatLine(row: UfaStatRow): FantasyStatLine {
  return {
    goals: row.goals ?? 0,
    assists: row.assists ?? 0,
    blocks: row.blocks ?? 0,
    turnovers: (row.throwaways ?? 0) + (row.drops ?? 0) + (row.stalls ?? 0),
    yards: (row.yards_thrown ?? 0) + (row.yards_received ?? 0),
    callahans: row.callahans ?? 0,
  };
}
