import 'server-only';

// Fantasy server-side reads for Server Components.
//
// leagues.ts / draft-room.ts read through the BROWSER client
// (@/lib/supabase/client is 'use client'). Imported into a Server Component
// that export is a client reference, so calling it throws — and the pages'
// .catch(() => null) turns that into "no draft" / "no team". These read
// through the cookie-aware SERVER client instead, which also carries the
// signed-in user's session for the per-user team lookup. Importing this module
// also registers the session reader leagues.ts uses on the server: league data
// is signed-in only (reader.ts).

import { createClient as createServerSupabase } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DraftStatus } from './draft-room';
import { registerServerReader } from './reader';

// fantasy_* tables aren't in the generated database.types.ts (repo
// convention), so loosen .from() only; auth stays typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQuery = { from: (t: string) => any };
function serverDb() {
  const supabase = createServerSupabase();
  return { supabase, db: supabase as unknown as AnyQuery };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

registerServerReader(() => createServerSupabase() as unknown as AnyClient);

/** The signed-in user, or null — the league layout's sign-in gate. */
export async function getServerUserId(): Promise<string | null> {
  const {
    data: { user },
  } = await createServerSupabase().auth.getUser();
  return user?.id ?? null;
}

/** The contest's draft status, or null when none is scheduled. Public read. */
export async function getDraftStatusServer(contestId: string): Promise<DraftStatus | null> {
  const { db } = serverDb();
  const { data, error } = await db
    .from('fantasy_drafts')
    .select('status')
    .eq('contest_id', contestId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? (data.status as DraftStatus) : null;
}

/** The signed-in user's team in a contest, or null (signed out / no team).
 *  Same shape as getMyContestTeam in leagues.ts. */
export async function getMyContestTeamServer(
  contestId: string,
): Promise<{ id: string; teamName: string } | null> {
  const { supabase, db } = serverDb();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await db
    .from('fantasy_teams')
    .select('id, team_name')
    .eq('owner_id', user.id)
    .eq('contest_id', contestId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { id: data.id as string, teamName: data.team_name as string } : null;
}
