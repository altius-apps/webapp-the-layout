import 'server-only';

// Fantasy server-side reads for Server Components.
//
// leagues.ts / draft-room.ts read through the BROWSER client
// (@/lib/supabase/client is 'use client'). Imported into a Server Component
// that export is a client reference, so calling it throws — and the pages'
// .catch(() => null) turns that into "no draft" / "no team". These read
// through the cookie-aware SERVER client instead, which also carries the
// signed-in user's session for the per-user team lookup. The *Public reads
// use a cookie-free anon client so cached (revalidate) routes stay static.

import { createClient as createServerSupabase } from '@/lib/supabase/server';
import { createClient as createAnonClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabase/env';
import type { DraftStatus } from './draft-room';

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

let _anon: AnyClient | null = null;
function anon(): AnyClient {
  if (_anon) return _anon;
  _anon = createAnonClient(supabaseUrl(), supabaseAnonKey(), {
    auth: { persistSession: false },
  });
  return _anon;
}

/** The contest's draft status, or null when none is scheduled. Public read. */
export async function getDraftStatusServer(contestId: string): Promise<DraftStatus | null> {
  const { db } = serverDb();
  const { data, error } = await db
    .from('fantasy_drafts')
    .select('status')
    .eq('contest_id', contestId)
    .maybeSingle();
  if (error) throw error;
  return data ? (data.status as DraftStatus) : null;
}

/** getDraftStatusServer without cookies, for cached routes. Public read. */
export async function getDraftStatusPublic(contestId: string): Promise<DraftStatus | null> {
  const { data, error } = await anon()
    .from('fantasy_drafts')
    .select('status')
    .eq('contest_id', contestId)
    .maybeSingle();
  if (error) throw error;
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
  if (error) throw error;
  return data ? { id: data.id as string, teamName: data.team_name as string } : null;
}
