'use server';

// Server actions for fantasy leagues: cache revalidation after league/contest
// writes. League invite emails are sent by the shared invite-email Edge
// Function (2026-10-09), shared with the mobile app.

import { revalidatePath } from 'next/cache';

// ─── revalidation ────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bust the public caches for fantasy league pages after a write. Public
 *  'use server' action — only revalidates, reveals/writes nothing. Busts both
 *  the legacy /fantasy/contests/[id] path and the UFA canonical
 *  /fantasy/ufa/l/[id] path since the caller here doesn't know the contest's
 *  competition — harmless no-op on whichever one isn't cached. */
export async function revalidateFantasyLeague(leagueId?: string, contestId?: string) {
  revalidatePath('/fantasy');
  revalidatePath('/fantasy/leagues');
  if (leagueId && UUID_RE.test(leagueId)) revalidatePath(`/fantasy/leagues/${leagueId}`);
  if (contestId && UUID_RE.test(contestId)) {
    revalidatePath(`/fantasy/contests/${contestId}`);
    revalidatePath(`/fantasy/ufa/l/${contestId}`);
    revalidatePath(`/fantasy/l/${contestId}`, 'layout');
  }
}
