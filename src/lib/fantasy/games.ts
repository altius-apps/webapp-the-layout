// Fantasy GAME registry — the hub's card data. A "game" is the user-facing
// name for a `competition` (see competitions.ts, which owns the DB-facing
// CompetitionId/CompetitionDef and stays the source of truth for scoring
// mode, player pool, etc.). This module adds presentation-only fields the
// hub/game-home pages need: card copy, status, badge, brand mark.
//
// Statuses (Hunter, 2026-08-27; wfdf-wucc promoted to live 2026-09-08):
// ufa + usau-club-nationals + wfdf-wucc='live' (event games draft once their
// event's rosters are in — fantasy_draft_rosters_ready; no calendar floor since
// 2026-10-11), usau-college-nationals / pul / wul='coming-soon'.
// eucs='coming-soon' — shown but greyed (Hunter, 2026-09-08) until we define a
// resolver that identifies the season's championship (EUCF); the series has no
// single start date we can point a league at.
//
// 'wfdf-wucc' is a WFDF-wide game despite its id: resolveEventForCompetition
// returns the season's soonest un-ended wfdf_events row of ANY kind, so it
// rides WJUC/WMUCC/WUGC as well as WUCC.

import type { CompetitionId } from './competitions';

export type GameStatus = 'live' | 'coming-soon' | 'hidden';

export interface GameDef {
  id: CompetitionId;
  /** Card + page title ("UFA Fantasy"). */
  name: string;
  /** One-line card description. */
  blurb: string;
  status: GameStatus;
  /** Brand mark in /public. */
  logoSrc: string;
  /** Tailwind-safe accent token for the card's wash/border (existing design
   *  tokens only — no per-game hex values). */
  accent: 'accent' | 'ink';
}

export const GAMES: GameDef[] = [
  {
    id: 'ufa',
    name: 'UFA Fantasy',
    blurb: 'Season-long fantasy for the UFA — draft, set your lineup, outscore your friends.',
    status: 'live',
    logoSrc: '/UFA-red.png',
    accent: 'accent',
  },
  {
    id: 'usau-club-nationals',
    name: 'Club Nationals Fantasy',
    blurb: 'One-weekend fantasy for USAU Club Nationals.',
    status: 'live',
    logoSrc: '/USAU-logo.png',
    accent: 'ink',
  },
  {
    id: 'usau-college-nationals',
    name: 'College Nationals Fantasy',
    blurb: 'One-weekend fantasy for USAU College Nationals.',
    status: 'coming-soon',
    logoSrc: '/USAU-logo.png',
    accent: 'ink',
  },
  {
    id: 'pul',
    name: 'PUL Fantasy',
    blurb: 'Season-long fantasy for the Premier Ultimate League.',
    status: 'coming-soon',
    logoSrc: '/PUL.webp',
    accent: 'ink',
  },
  {
    id: 'wul',
    name: 'WUL Fantasy',
    blurb: 'Season-long fantasy for the WUL.',
    status: 'coming-soon',
    logoSrc: '/WUL-logo.jpeg',
    accent: 'ink',
  },
  {
    id: 'wfdf-wucc',
    name: 'WFDF Fantasy',
    blurb: 'Fantasy for WFDF Worlds events.',
    status: 'live',
    logoSrc: '/WFDF_Logo.webp',
    accent: 'ink',
  },
  {
    id: 'eucs',
    name: 'EUCS Fantasy',
    blurb: 'Fantasy for the European Ultimate Club Series.',
    status: 'coming-soon',
    logoSrc: '/EUF_Logo.webp',
    accent: 'ink',
  },
];

const BY_ID = new Map(GAMES.map((g) => [g.id, g]));

export function getGame(id: string): GameDef | null {
  return BY_ID.get(id as CompetitionId) ?? null;
}

/** Cards the hub renders — hidden games excluded entirely. */
export function hubGames(): GameDef[] {
  return GAMES.filter((g) => g.status !== 'hidden');
}
