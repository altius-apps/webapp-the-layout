// Fantasy data layer — reads (public, anon-safe) + writes (owner-gated).
//
// READ functions use the anon publishable key and work from Server Components
// with NO session — mirrors wul_*/pul_* reads.
// WRITE functions run client-side, derive owner_id from supabase.auth.getUser()
// (never trust the client), and rely on RLS + the owner_username trigger for
// enforcement. Mirrors src/lib/playbook/data.ts.
//
// fantasy_* tables aren't in database.types.ts (same as wul_*/pul_*), so we
// cast rows via local interfaces.

import { createClient as createSessionClient } from '@/lib/supabase/client';
import { createClient as createAnonClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabase/env';
import { scoreStatLine, roundPoints, type FantasyRole } from './scoring';
import { ufaRowToStatLine, type UfaStatRow } from './ufa-adapter';
import { moderateName } from '@/lib/moderation';

// fantasy_*/ufa_* tables aren't in database.types.ts (same as wul_*/pul_*), so
// we use untyped clients and cast rows via the local interfaces below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

/** Anon client for READ paths that run without a session (Server Components). */
let _anon: AnyClient | null = null;
function anon(): AnyClient {
  if (_anon) return _anon;
  _anon = createAnonClient(supabaseUrl(), supabaseAnonKey(), {
    auth: { persistSession: false },
  });
  return _anon;
}

/** Session-aware browser client (carries the auth cookie), untyped for
 *  fantasy_* access. Used by write paths so auth.getUser() + RLS work. */
function sessionClient(): AnyClient {
  return createSessionClient() as unknown as AnyClient;
}

/** Default season year for UFA stat reads. */
export function fantasySeasonYear(now: Date = new Date()): number {
  return now.getFullYear();
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface FantasyPlayerHit {
  playerId: string;
  fullName: string;
  teamId: string | null;
  teamName: string | null;
}

export interface RosterSlot {
  playerId: string;
  role: FantasyRole;
  fullName: string;
  teamId: string | null;
  teamName: string | null;
}

/** A rostered player + the fantasy points they scored in a given week. */
export interface WeekPlayerScore extends RosterSlot {
  /** Fantasy points this player scored that week (rounded, may be 0 or negative). */
  points: number;
  /** Games this player played in the week (0 = bye/DNP → 0 pts). */
  gamesPlayed: number;
}

/** One week of a team's history: total + per-player breakdown. */
export interface WeekBreakdown {
  week: string;
  totalPoints: number;
  players: WeekPlayerScore[];
}

export interface LeaderboardRow {
  teamId: string;
  teamName: string;
  ownerId: string;
  ownerDisplayName: string | null;
  ownerUsername: string | null;
  totalPoints: number;
}

// ─── Team + roster reads ──────────────────────────────────────────────────────

/** Roster slots for a team + week, joined to player/team names. */
export async function getTeamRoster(teamId: string, week: string): Promise<RosterSlot[]> {
  const { data, error } = await anon()
    .from('fantasy_roster_slots')
    .select('player_id, role, ufa_players:player_id (full_name, current_team_id, ufa_teams:current_team_id (name, full_name))')
    .eq('team_id', teamId)
    .eq('week', week);
  if (error) throw new Error(error.message);

  return (data ?? []).map((r: Record<string, unknown>) => {
    const p = r.ufa_players as
      | { full_name?: string; current_team_id?: string; ufa_teams?: { name?: string; full_name?: string } }
      | null;
    return {
      playerId: r.player_id as string,
      role: r.role as FantasyRole,
      fullName: p?.full_name ?? (r.player_id as string),
      teamId: p?.current_team_id ?? null,
      teamName: p?.ufa_teams?.full_name ?? p?.ufa_teams?.name ?? null,
    };
  });
}

/**
 * Per-player fantasy points for a team in ONE week — the breakdown behind the
 * team's weekly total. Computed on the fly from that week's roster slots + the
 * players' UFA game stats, using the SAME scoring matrix as the scoring job
 * (scoreStatLine via the UFA adapter). A player with no game that week scores 0.
 * Returned sorted by points desc (best performers first).
 */
export async function getTeamWeekBreakdown(
  teamId: string,
  week: string,
  year = fantasySeasonYear(),
): Promise<WeekBreakdown> {
  const roster = await getTeamRoster(teamId, week);
  if (roster.length === 0) return { week, totalPoints: 0, players: [] };

  const playerIds = roster.map((r) => r.playerId);
  // That week's per-player stat lines (a player can appear in multiple games).
  const { data: statRows } = await anon()
    .from('ufa_game_player_stats')
    .select(
      'player_id, goals, assists, blocks, throwaways, drops, stalls, yards_thrown, yards_received, callahans, ufa_games!inner(week, year)',
    )
    .in('player_id', playerIds)
    .eq('ufa_games.week', week)
    .eq('ufa_games.year', year);

  // Sum each player's points + games across the week's games.
  const agg = new Map<string, { points: number; games: number }>();
  for (const raw of statRows ?? []) {
    const r = raw as Record<string, unknown>;
    const pid = r.player_id as string;
    const role = roster.find((s) => s.playerId === pid)?.role;
    if (!role) continue; // stat row for a non-rostered player (shouldn't happen via .in)
    const pts = scoreStatLine(ufaRowToStatLine(r as unknown as UfaStatRow), role);
    const cur = agg.get(pid) ?? { points: 0, games: 0 };
    cur.points += pts;
    cur.games += 1;
    agg.set(pid, cur);
  }

  const players: WeekPlayerScore[] = roster
    .map((slot) => {
      const a = agg.get(slot.playerId) ?? { points: 0, games: 0 };
      return { ...slot, points: roundPoints(a.points), gamesPlayed: a.games };
    })
    .sort((a, b) => b.points - a.points);

  const totalPoints = roundPoints(players.reduce((s, p) => s + p.points, 0));
  return { week, totalPoints, players };
}

// ─── Writes (client-side; owner derived from session) ────────────────────────

export interface MyProfile {
  displayName: string | null;
  username: string | null;
}

/** The signed-in user's editable public identity (display name + handle). */
export async function getMyProfile(): Promise<MyProfile | null> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from('profiles')
    .select('display_name, username')
    .eq('id', user.id)
    .maybeSingle();
  if (!data) return null;
  return {
    displayName: (data.display_name as string) ?? null,
    username: (data.username as string) ?? null,
  };
}

/** profiles.username constraint: lowercase, 3–30 chars, alnum + underscore. */
export const USERNAME_RE = /^[a-z0-9_]{3,30}$/;

/**
 * Is a handle free? Uses the fantasy_handle_available RPC (SECURITY DEFINER,
 * boolean-only). This is required, NOT a nicety: profiles SELECT is
 * authenticated-only, so a direct anon `.eq('username',…)` query reads empty
 * and would always report "available" (broken at signup, before a session).
 * The RPC sees the row and returns only a boolean — no row-data disclosure.
 */
export async function isUsernameAvailable(username: string): Promise<boolean> {
  const u = username.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) return false;
  const { data, error } = await anon().rpc('fantasy_handle_available', { p_handle: u });
  if (error) return false; // fail closed — treat as unavailable on error
  return data === true;
}

/**
 * Set the signed-in user's public handle. RLS lets a user update only their own
 * profile row (profiles_update_own). Throws on format/profanity/taken. This is
 * the user's unique handle — synced onto their teams by trigger.
 */
export async function setMyUsername(username: string): Promise<void> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');
  const u = username.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) {
    throw new Error('Handle must be 3–30 characters: lowercase letters, numbers, underscores.');
  }
  const bad = moderateName(u, 'Handle');
  if (bad) throw new Error(bad);
  const { error } = await supabase.from('profiles').update({ username: u }).eq('id', user.id);
  if (error) {
    // 23505 = unique_violation (handle taken)
    if ((error as { code?: string }).code === '23505') throw new Error('That handle is taken.');
    throw new Error(error.message);
  }
}

/**
 * Set the signed-in user's display name — the primary label in league
 * standings. Not unique. Runs the profanity filter. 1–60 chars. The
 * fantasy_resync trigger updates any of the user's teams' denormalized copy.
 */
export async function setDisplayName(name: string): Promise<void> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');
  const n = name.trim();
  if (n.length < 1 || n.length > 60) throw new Error('Display name must be 1–60 characters.');
  const bad = moderateName(n, 'Display name');
  if (bad) throw new Error(bad);
  const { error } = await supabase.from('profiles').update({ display_name: n }).eq('id', user.id);
  if (error) throw new Error(error.message);
}

/**
 * Set (or clear) the signed-in user's profile-icon URL — the avatar shown in
 * the nav account chip in place of the initials monogram. Pass null to clear it
 * back to initials. The value is a public storage URL in the `avatars` bucket
 * (upload keyed to the user's own {user_id}/… folder via storage RLS). Writes
 * the user's own profiles row (profiles_update_own RLS).
 */
export async function setAvatarUrl(url: string | null): Promise<void> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');
  // Only accept a same-project Supabase storage URL (or null). Prevents a
  // caller from pointing the avatar at an arbitrary external/attacker URL.
  if (url !== null) {
    const ok = /^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\/avatars\//.test(url);
    if (!ok) throw new Error('Invalid avatar URL.');
  }

  // Read the current avatar first so we can delete its storage object after a
  // successful swap — a public-bucket URL never expires, so a replaced/removed
  // photo would otherwise stay publicly reachable forever (privacy).
  const { data: prev } = await supabase
    .from('profiles')
    .select('avatar_url')
    .eq('id', user.id)
    .maybeSingle();
  const prevUrl = prev?.avatar_url ?? null;

  // Setting an uploaded photo clears any picked team-logo icon — the two are
  // mutually exclusive (avatar_icon takes render precedence, so a stale icon
  // would mask the new photo). Clearing the photo (url=null) leaves icon as-is.
  const patch: Record<string, string | null> = { avatar_url: url };
  if (url !== null) patch.avatar_icon = null;
  const { error } = await supabase.from('profiles').update(patch).eq('id', user.id);
  if (error) throw new Error(error.message);

  // Best-effort cleanup of the OLD object (only when it actually changed and
  // was one of ours). Storage RLS still scopes deletion to the user's folder,
  // and a failure here must not fail the avatar change — the column is the
  // source of truth. Path = everything after `/public/avatars/`.
  if (prevUrl && prevUrl !== url) {
    const m = prevUrl.match(/\/storage\/v1\/object\/public\/avatars\/(.+)$/);
    const oldPath = m ? decodeURIComponent(m[1]) : null;
    // Only remove objects under THIS user's folder (defense in depth on top of RLS).
    if (oldPath && oldPath.startsWith(`${user.id}/`)) {
      await supabase.storage.from('avatars').remove([oldPath]).catch(() => {});
    }
  }
}

/**
 * Set (or clear) the signed-in user's profile ICON — a picked team logo /
 * country flag, stored as a compact "<league>:<teamId>" reference (e.g.
 * 'ufa:empire', 'wfdf:USA'), NOT an image URL. Pass null to clear it. Mutually
 * exclusive with the uploaded photo (avatar_url): setting an icon clears the
 * photo, and if that photo was an uploaded storage object it's cleaned up so it
 * doesn't stay publicly reachable. Writes the user's own profiles row
 * (profiles_update_own RLS).
 *
 * `ref` must match "<league>:<id>" where league ∈ {ufa,usau,pul,wul,wfdf} and id
 * is a short slug/code — the same shape enforced by the profiles_avatar_icon_format
 * DB CHECK. Rejects anything else so a caller can't stash arbitrary text here.
 */
export async function setAvatarIcon(ref: string | null): Promise<void> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');
  if (ref !== null) {
    const ok = /^(ufa|usau|pul|wul|wfdf|euf):[A-Za-z0-9][A-Za-z0-9/_ -]{0,79}$/.test(ref);
    if (!ok) throw new Error('Invalid avatar icon.');
  }

  // Read the current photo so we can clean up an uploaded storage object when
  // switching to an icon (the URL column is being cleared out from under it).
  const { data: prev } = await supabase
    .from('profiles')
    .select('avatar_url')
    .eq('id', user.id)
    .maybeSingle();
  const prevUrl = prev?.avatar_url ?? null;

  // Setting an icon clears the photo; clearing the icon (ref=null) leaves the
  // photo untouched so a user can fall back to a previously-uploaded photo.
  const patch: Record<string, string | null> =
    ref !== null ? { avatar_icon: ref, avatar_url: null } : { avatar_icon: null };
  const { error } = await supabase.from('profiles').update(patch).eq('id', user.id);
  if (error) throw new Error(error.message);

  if (ref !== null && prevUrl) {
    const m = prevUrl.match(/\/storage\/v1\/object\/public\/avatars\/(.+)$/);
    const oldPath = m ? decodeURIComponent(m[1]) : null;
    if (oldPath && oldPath.startsWith(`${user.id}/`)) {
      await supabase.storage.from('avatars').remove([oldPath]).catch(() => {});
    }
  }
}

// ─── Scoring preview (client hint) ────────────────────────────────────────────

/**
 * Preview points a player would score in a role, from their season-to-date
 * per-game UFA stats. Pure display aid for the builder's "what this scores"
 * hint — the authoritative cumulative score is computed by the scoring job.
 */
export async function playerSeasonPreview(
  playerId: string,
  role: FantasyRole,
  year = fantasySeasonYear(),
): Promise<number> {
  const { data, error } = await anon()
    .from('ufa_game_player_stats')
    .select('goals, assists, blocks, throwaways, drops, stalls, yards_thrown, yards_received, callahans, ufa_games!inner(year)')
    .eq('player_id', playerId)
    .eq('ufa_games.year', year);
  if (error) throw new Error(error.message);

  let total = 0;
  for (const row of data ?? []) {
    total += scoreStatLine(ufaRowToStatLine(row as unknown as UfaStatRow), role);
  }
  return roundPoints(total);
}
