/**
 * Fantasy scoring/week unit checks — standalone (no test-runner dependency).
 *
 * Run:  npx tsx scripts/test-fantasy-scoring.ts
 *
 * Exercises the pure engine (src/lib/fantasy/*) with hand-computed expectations,
 * plus a couple of week-boundary edge cases. Exits non-zero on any failure.
 * (If we adopt Vitest later, these cases port over 1:1.)
 */

import { scoreStatLine, sumPoints, roundPoints, type FantasyStatLine } from '../src/lib/fantasy/scoring';
import { ufaRowToStatLine } from '../src/lib/fantasy/ufa-adapter';
import { placementBonus, scoreEventLine } from '../src/lib/fantasy/event-adapter';
import {
  buildWeeks,
  activeWeek,
  scorableWeeks,
  isWeekLocked,
  weekSortKey,
  type WeekGame,
} from '../src/lib/fantasy/weeks';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

function approx(actual: number, expected: number, label: string, tol = 1e-9) {
  if (Math.abs(actual - expected) <= tol) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}\n      expected ~${expected}\n      got       ${actual}`);
  }
}

// ─── Scoring: the role-skew matrix ───────────────────────────────────────────
console.log('\nScoring matrix:');
{
  // 1 goal, 1 assist, 1 block, 0 turnovers, 0 yards
  const line: FantasyStatLine = { goals: 1, assists: 1, blocks: 1, turnovers: 0, yards: 0, callahans: 0 };
  // Offender: 3 + 3 + 3 = 9
  approx(scoreStatLine(line, 'offender'), 9, 'offender G1 A1 B1 = 9');
  // Defender: 3 + 2 + 5 = 10
  approx(scoreStatLine(line, 'defender'), 10, 'defender G1 A1 B1 = 10');
}
{
  // Block is where the roles diverge most: 3 blocks
  const line: FantasyStatLine = { goals: 0, assists: 0, blocks: 3, turnovers: 0, yards: 0, callahans: 0 };
  approx(scoreStatLine(line, 'offender'), 9, 'offender 3 blocks = 9');
  approx(scoreStatLine(line, 'defender'), 15, 'defender 3 blocks = 15');
}
{
  // Turnovers: -1 each, both roles
  const line: FantasyStatLine = { goals: 0, assists: 0, blocks: 0, turnovers: 4, yards: 0, callahans: 0 };
  approx(scoreStatLine(line, 'offender'), -4, 'offender 4 turnovers = -4');
  approx(scoreStatLine(line, 'defender'), -4, 'defender 4 turnovers = -4');
}
{
  // Yards: 1 pt / 100, decimals, role-neutral
  const line: FantasyStatLine = { goals: 0, assists: 0, blocks: 0, turnovers: 0, yards: 250, callahans: 0 };
  approx(scoreStatLine(line, 'offender'), 2.5, 'offender 250 yds = 2.5');
  approx(scoreStatLine(line, 'defender'), 2.5, 'defender 250 yds = 2.5');
}
{
  // Combined realistic line: G1 A4 B2 TO1, 496 yds (tdecraene @ 2026-06-20-PHI-BOS)
  const line: FantasyStatLine = { goals: 1, assists: 4, blocks: 2, turnovers: 1, yards: 265 + 231, callahans: 0 };
  // Offender: 1*3 + 4*3 + 2*3 + 1*(-1) + 496/100 = 3+12+6-1+4.96 = 24.96
  approx(scoreStatLine(line, 'offender'), 24.96, 'offender realistic line = 24.96');
  // Defender: 1*3 + 4*2 + 2*5 + 1*(-1) + 4.96 = 3+8+10-1+4.96 = 24.96
  approx(scoreStatLine(line, 'defender'), 24.96, 'defender realistic line = 24.96');
}
{
  // Callahan: +10 on top of the goal it also counts as, both roles
  const line: FantasyStatLine = { goals: 1, assists: 0, blocks: 1, turnovers: 0, yards: 0, callahans: 1 };
  approx(scoreStatLine(line, 'offender'), 16, 'offender callahan (G1 B1 C1) = 16');
  approx(scoreStatLine(line, 'defender'), 18, 'defender callahan (G1 B1 C1) = 18');
}
{
  // Missing fields default to 0 (leagues without yardage etc.)
  const line = { goals: 2, assists: 0, blocks: 0, turnovers: 0, yards: 0 } as FantasyStatLine;
  approx(scoreStatLine(line, 'offender'), 6, 'offender 2 goals only = 6');
}

// ─── Event scoring: G/A/callahans + team placement ───────────────────────────
console.log('\nEvent scoring:');
{
  approx(placementBonus(1), 10, 'champion = 10');
  approx(placementBonus(2), 6, 'runner-up = 6');
  approx(placementBonus(4), 3, 'semifinalist = 3');
  approx(placementBonus(8), 1, 'quarterfinalist = 1');
  approx(placementBonus(9), 0, '9th = 0');
  approx(placementBonus(null), 0, 'unknown placement = 0');
  // G2 A1 C1, champion: 2*3 + 1*3 + 1*10 + 10 = 29
  approx(scoreEventLine({ goals: 2, assists: 1, callahans: 1 }, 1), 29, 'G2 A1 C1 champion = 29');
}

// ─── UFA adapter: turnovers + yards derivation ───────────────────────────────
console.log('\nUFA adapter:');
{
  const row = {
    goals: 1, assists: 4, blocks: 2,
    throwaways: 1, drops: 0, stalls: 0,
    yards_thrown: 265, yards_received: 231, callahans: 0,
  };
  const line = ufaRowToStatLine(row);
  eq(line, { goals: 1, assists: 4, blocks: 2, turnovers: 1, yards: 496, callahans: 0 }, 'row → statline (TO=1, yards=496)');
}
{
  // turnovers sums all three components
  const row = { goals: 0, assists: 0, blocks: 0, throwaways: 2, drops: 1, stalls: 1, yards_thrown: 0, yards_received: 0, callahans: 0 };
  eq(ufaRowToStatLine(row).turnovers, 4, 'turnovers = throwaways+drops+stalls');
}

// ─── sum + rounding ──────────────────────────────────────────────────────────
console.log('\nSum + rounding:');
{
  const games = [
    { playerId: 'a', gameId: 'g1', week: 'week-1', role: 'offender' as const, points: 8, line: {} as FantasyStatLine },
    { playerId: 'a', gameId: 'g2', week: 'week-2', role: 'offender' as const, points: 4.96, line: {} as FantasyStatLine },
  ];
  approx(sumPoints(games), 12.96, 'sumPoints across two games');
  eq(roundPoints(12.96), 13, 'roundPoints(12.96) = 13 (1 decimal → 13.0)');
  eq(roundPoints(22.96), 23, 'roundPoints(22.96) = 23.0');
  eq(roundPoints(2.54), 2.5, 'roundPoints(2.54) = 2.5');
}

// ─── Week logic ──────────────────────────────────────────────────────────────
console.log('\nWeek logic:');
{
  const games: WeekGame[] = [
    { week: 'week-1', startTimestamp: '2026-04-25T19:00:00-04:00', status: 'Final' },
    { week: 'week-1', startTimestamp: '2026-04-26T15:00:00-04:00', status: 'Final' },
    { week: 'week-2', startTimestamp: '2026-05-02T19:00:00-04:00', status: 'Final' },
    { week: 'week-10', startTimestamp: '2026-07-04T19:00:00-04:00', status: 'Upcoming' },
    { week: null, startTimestamp: '2026-08-01T19:00:00-04:00', status: 'Upcoming' }, // dropped
  ];
  // "now" = mid-May: week-1 & week-2 locked, week-10 not.
  const now = new Date('2026-05-15T12:00:00-04:00');
  const weeks = buildWeeks(games, now);

  eq(weeks.map((w) => w.week), ['week-1', 'week-2', 'week-10'], 'weeks sorted numerically, null dropped');
  eq(weeks[0].lockAt, '2026-04-25T23:00:00.000Z', 'week-1 locks at EARLIEST start (Sat 7pm EDT)');
  eq(weeks[0].gameCount, 2, 'week-1 has 2 games');
  eq(weeks.map((w) => w.locked), [true, true, false], 'lock state by now');
  eq(weeks.map((w) => w.complete), [true, true, false], 'complete = all Final');

  eq(activeWeek(weeks)?.week, 'week-10', 'activeWeek = earliest unlocked');
  eq(scorableWeeks(weeks).map((w) => w.week), ['week-1', 'week-2'], 'scorableWeeks = locked only');
  eq(isWeekLocked(weeks, 'week-1', now), true, 'week-1 locked at now');
  eq(isWeekLocked(weeks, 'week-10', now), false, 'week-10 not locked at now');
}
{
  // All locked → activeWeek falls back to last week
  const games: WeekGame[] = [
    { week: 'week-1', startTimestamp: '2026-04-25T19:00:00-04:00', status: 'Final' },
    { week: 'week-2', startTimestamp: '2026-05-02T19:00:00-04:00', status: 'Final' },
  ];
  const now = new Date('2026-09-01T00:00:00Z');
  const weeks = buildWeeks(games, now);
  eq(activeWeek(weeks)?.week, 'week-2', 'all-locked → activeWeek = last week');
}
{
  // Exact lock boundary: now === lockAt counts as locked (>=)
  const games: WeekGame[] = [{ week: 'week-1', startTimestamp: '2026-04-25T19:00:00-04:00', status: 'Upcoming' }];
  const atLock = new Date('2026-04-25T19:00:00-04:00');
  eq(buildWeeks(games, atLock)[0].locked, true, 'now === lockAt → locked');
  const oneMsBefore = new Date(new Date('2026-04-25T19:00:00-04:00').getTime() - 1);
  eq(buildWeeks(games, oneMsBefore)[0].locked, false, '1ms before lock → not locked');
}
{
  eq(weekSortKey('week-2') < weekSortKey('week-10'), true, 'week-2 sorts before week-10');
  eq(weekSortKey(null) > weekSortKey('week-99'), true, 'null week sorts last');
}

// ─── Result ──────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
