// WUL → fantasy stat-line adapter.
//
// Maps a `wul_game_player_stats` DB row into the league-agnostic
// FantasyStatLine. WUL is the closest league to UFA statistically:
//   • `turnovers` is a single upstream column
//   • yardage exists: prefer `total_yards`, fall back to throw + receive

import type { FantasyStatLine } from './scoring';

/** The columns we read from wul_game_player_stats (snake_case, as stored). */
export interface WulStatRow {
  goals: number | null;
  assists: number | null;
  blocks: number | null;
  turnovers: number | null;
  throw_yards: number | null;
  receive_yards: number | null;
  total_yards: number | null;
}

export function wulRowToStatLine(row: WulStatRow): FantasyStatLine {
  return {
    goals: row.goals ?? 0,
    assists: row.assists ?? 0,
    blocks: row.blocks ?? 0,
    turnovers: row.turnovers ?? 0,
    yards: row.total_yards ?? (row.throw_yards ?? 0) + (row.receive_yards ?? 0),
    // WUL callahans are held out until the data is checked (see score-fantasy).
    callahans: 0,
  };
}
