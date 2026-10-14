// PUL → fantasy stat-line adapter.
//
// Maps a `pul_game_player_stats` DB row into the league-agnostic
// FantasyStatLine. PUL is simpler than UFA:
//   • `turnovers` is already a single upstream column (no throwaway/drop/stall
//     split to sum)
//   • PUL tracks NO yardage or callahans → yards: 0, callahans: 0 (those
//     terms contribute nothing, by design — see scoring.ts header)

import type { FantasyStatLine } from './scoring';

/** The columns we read from pul_game_player_stats (snake_case, as stored). */
export interface PulStatRow {
  goals: number | null;
  assists: number | null;
  blocks: number | null;
  turnovers: number | null;
}

export function pulRowToStatLine(row: PulStatRow): FantasyStatLine {
  return {
    goals: row.goals ?? 0,
    assists: row.assists ?? 0,
    blocks: row.blocks ?? 0,
    turnovers: row.turnovers ?? 0,
    yards: 0,
    callahans: 0,
  };
}
