// Edge Function: delete-account
//
// Deletes the CALLING user's account and their personal data. Apple Guideline
// 5.1.1(v) requires in-app account deletion for any app with account creation.
//
// Why an Edge Function (not a client call): removing an auth user requires the
// service-role key via auth.admin.deleteUser(). That key must never reach the
// app binary — so the privileged work happens here, server-side, and the client
// only sends its access token.
//
// AUTH MODEL: the caller proves identity with their normal Supabase access
// token (Authorization: Bearer <jwt>). We resolve that token to a user id with
// the ANON client, then do all privileged work with the SERVICE client. The
// user can only ever delete THEMSELVES — the id comes from their own verified
// token, never from the request body. A signed-in session is the only proof
// required (Hunter, 2026-10-07: "if they are signed in they can delete"); v7
// dropped the password / Sign in with Apple re-auth and ignores the body, so
// older builds that still send one keep working.
//
// SCHEMA FACTS (verified against the live DB, 2026-06-18; FKs re-checked
// 2026-10-07):
//   - pb_* children now cascade from pb_teams / pb_plays, and user rows cascade
//     from profiles — except pb_teams.owner_id, which is RESTRICT, so the
//     user's solo teams must be deleted before the auth user.
//   - Only profiles cascades from auth.users, so deleting the auth user at the
//     end cleans up the profile for free.
//   - pb_team_role enum = {owner, coach, member}.
//
// DELETION POLICY (Hunter's decisions, 2026-06-18):
//   - Teams the user OWNS that still have OTHER members → BLOCK. Return the
//     team list; the app makes them transfer ownership first. (Don't silently
//     orphan or delete a shared team.)
//   - Teams the user owns where they're the SOLE member → delete the team and
//     its plays alongside the account.
//   - Personal plays (owner_id = user, no team) → delete.
//   - Team plays the user AUTHORED but that belong to a SURVIVING team → KEEP
//     (created_by is left pointing at the deleted id; the team keeps its
//     playbook).
//   - player_content uploads → delete the DB rows.
//   - Storage files (pb_plays.video_url, player_content.storage_path) → NOT
//     cleaned up yet (deferred; rows are removed but objects remain). TODO.
//   - Fantasy leagues the user OWNS → ownership passes to another member
//     automatically inside the deleteUser cascade (DB trigger
//     fantasy_hand_off_leagues_on_profile_delete — Hunter's "option B",
//     2026-10-07): a member with a team first, then the longest-standing one.
//     Solo leagues go with the account. Leagues no longer block (v6; v5
//     returned 409 fantasy_transfer_required).
//   - A team in a LIVE fantasy draft → BLOCK until the draft is over (Hunter,
//     2026-10-07). Checked before anything is deleted; the deleteUser cascade
//     would otherwise hit fantasy_teams_guard_delete after the playbook steps.
//
// Returns:
//   200 { deleted: true }                          on success
//   409 { error: 'draft_in_progress',              the user has a team in a
//         leagues: [{ id, name, contestId }] }     live draft
//   409 { error: 'ownership_transfer_required',    when owned multi-member
//         teams: [{ id, name }] }                  teams block deletion
//   429 { error: 'rate_limited' }                  >3 attempts in a minute
//   401 { error: 'unauthenticated' }               missing/invalid token

import { createClient } from 'jsr:@supabase/supabase-js@2';

interface OwnedTeam {
  id: string;
  name: string;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request): Promise<Response> => {
  // CORS preflight — harmless for the RN client (not CORS-bound) but required
  // if this is ever called from a browser tool or the Supabase dashboard.
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    // Misconfiguration — never reveal which var is missing to the client.
    return json(500, { error: 'server_misconfigured' });
  }

  // 1) Resolve the caller from their own access token (anon client + their JWT).
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json(401, { error: 'unauthenticated' });

  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await anon.auth.getUser();
  if (userErr || !userData?.user) return json(401, { error: 'unauthenticated' });
  const userId = userData.user.id;

  // Privileged client for all destructive work. RLS is bypassed here, so every
  // query below is explicitly scoped to userId — there is no path that touches
  // another user's data.
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // RATE LIMIT: cap deletion attempts per user to blunt abuse of this expensive,
  // destructive path. Reads/writes delete_account_attempts (service-role only;
  // RLS denies all clients). Cost is two cheap indexed queries on the normal
  // path — invisible to the user.
  const RATE_WINDOW_MS = 60_000;
  const RATE_MAX = 3;
  {
    const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
    const { count, error: rlErr } = await admin
      .from('delete_account_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('attempted_at', since);
    if (rlErr) return json(500, { error: 'lookup_failed' });
    if ((count ?? 0) >= RATE_MAX) return json(429, { error: 'rate_limited' });

    // Record this attempt. Non-fatal if it fails — don't block a legitimate
    // deletion just because the ledger write hiccuped.
    await admin.from('delete_account_attempts').insert({ user_id: userId });
  }

  // 2) PRE-FLIGHT GUARDS. Nothing is deleted until these pass.
  //
  // Live fantasy drafts first. Same RPC the apps' pre-flight calls, run with
  // the caller's own token so there is one rule. A draft that goes live after
  // this check still fails the deleteUser cascade (fantasy_teams_guard_delete)
  // — a seconds-wide window.
  {
    const { data: drafts, error: draftsErr } = await anon.rpc(
      'fantasy_drafts_blocking_account_deletion',
    );
    if (draftsErr) return json(500, { error: 'lookup_failed' });
    const live = (drafts ?? []) as { league_id: string; league_name: string; contest_id: string }[];
    if (live.length > 0) {
      return json(409, {
        error: 'draft_in_progress',
        leagues: live.map((d) => ({ id: d.league_id, name: d.league_name, contestId: d.contest_id })),
      });
    }
  }

  // Playbook teams this user owns, and whether each is solo.
  const { data: ownedTeams, error: ownedErr } = await admin
    .from('pb_teams')
    .select('id, name')
    .eq('owner_id', userId);
  if (ownedErr) return json(500, { error: 'lookup_failed' });

  const soloTeamIds: string[] = [];
  const blockedTeams: OwnedTeam[] = [];

  for (const team of (ownedTeams ?? []) as OwnedTeam[]) {
    // Count members OTHER than the owner on this team.
    const { count, error: cntErr } = await admin
      .from('pb_team_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('team_id', team.id)
      .neq('user_id', userId);
    if (cntErr) return json(500, { error: 'lookup_failed' });

    if ((count ?? 0) > 0) blockedTeams.push({ id: team.id, name: team.name });
    else soloTeamIds.push(team.id);
  }

  // If any owned team still has other members, refuse and tell the app what
  // needs an ownership transfer first. Nothing has been deleted yet. (Owned
  // fantasy leagues don't block: the DB hands each one to another member.)
  if (blockedTeams.length > 0) {
    return json(409, {
      error: 'ownership_transfer_required',
      teams: blockedTeams,
    });
  }

  // TOCTOU re-check: a member could have joined a "solo" team in the window
  // between the count above and now. Re-verify each solo team is STILL solo
  // BEFORE deleting any of its data — otherwise a late joiner's team gets
  // silently destroyed. This runs before step 3, so a re-block deletes nothing.
  for (const teamId of soloTeamIds) {
    const { count, error: reErr } = await admin
      .from('pb_team_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('team_id', teamId)
      .neq('user_id', userId);
    if (reErr) return json(500, { error: 'lookup_failed' });
    if ((count ?? 0) > 0) {
      const t = (ownedTeams ?? []).find((x) => (x as OwnedTeam).id === teamId) as
        | OwnedTeam
        | undefined;
      return json(409, {
        error: 'ownership_transfer_required',
        teams: [{ id: teamId, name: t?.name ?? '(recently changed)' }],
      });
    }
  }

  // 3) ORDERED DELETION (no cascades — children before parents). Each step is
  //    scoped to userId / soloTeamIds. We stop on the first error so we never
  //    delete the auth user while owned data still exists.

  // The set of plays being deleted = the user's personal plays (owner_id, no
  // team) PLUS every play on a solo team that's about to be removed. We collect
  // their ids first so we can delete pb_play_steps (which references play_id
  // with NO foreign key / no cascade — verified live 2026-06-18) BEFORE the
  // plays themselves. Skipping this orphans step rows pointing at deleted plays.
  const playIdsToDelete: string[] = [];
  {
    const { data: personal, error: pErr } = await admin
      .from('pb_plays')
      .select('id')
      .eq('owner_id', userId)
      .is('team_id', null);
    if (pErr) return json(500, { error: 'lookup_failed' });
    for (const r of (personal ?? []) as { id: string }[]) playIdsToDelete.push(r.id);

    if (soloTeamIds.length > 0) {
      const { data: teamPlays, error: tErr } = await admin
        .from('pb_plays')
        .select('id')
        .in('team_id', soloTeamIds);
      if (tErr) return json(500, { error: 'lookup_failed' });
      for (const r of (teamPlays ?? []) as { id: string }[]) playIdsToDelete.push(r.id);
    }
  }

  // 3a) Steps for all plays being deleted (FK-less child — must go first).
  if (playIdsToDelete.length > 0) {
    const { error } = await admin
      .from('pb_play_steps')
      .delete()
      .in('play_id', playIdsToDelete);
    if (error) return json(500, { error: 'delete_failed', step: 'play_steps' });
  }

  // 3b) Personal plays: authored, no team.
  {
    const { error } = await admin
      .from('pb_plays')
      .delete()
      .eq('owner_id', userId)
      .is('team_id', null);
    if (error) return json(500, { error: 'delete_failed', step: 'personal_plays' });
  }

  // 3c) Plays belonging to the user's SOLO teams (which are about to be deleted).
  //     Team plays on SURVIVING teams are intentionally left untouched.
  if (soloTeamIds.length > 0) {
    const { error } = await admin
      .from('pb_plays')
      .delete()
      .in('team_id', soloTeamIds);
    if (error) return json(500, { error: 'delete_failed', step: 'solo_team_plays' });
  }

  // 3d) The solo teams themselves, BEFORE the memberships: guard_team_member_
  //     delete refuses to remove a team's last owner while the team still
  //     exists, so deleting the owner row first failed every solo-team owner
  //     (after their plays were already gone). Deleting the team cascades its
  //     members, invites, lines and roster, and the guard lets those through.
  if (soloTeamIds.length > 0) {
    const { error } = await admin
      .from('pb_teams')
      .delete()
      .in('id', soloTeamIds);
    if (error) return json(500, { error: 'delete_failed', step: 'solo_teams' });
  }

  // 3e) The user's memberships on everyone else's teams.
  {
    const { error } = await admin
      .from('pb_team_members')
      .delete()
      .eq('user_id', userId);
    if (error) return json(500, { error: 'delete_failed', step: 'memberships' });
  }

  // 3f) Invites the user sent to other teams.
  {
    const { error } = await admin
      .from('pb_team_invites')
      .delete()
      .eq('invited_by', userId);
    if (error) return json(500, { error: 'delete_failed', step: 'invites' });
  }

  // 3g) User-uploaded player content. (Storage objects deferred — TODO below.)
  {
    const { error } = await admin
      .from('player_content')
      .delete()
      .eq('uploaded_by', userId);
    if (error) return json(500, { error: 'delete_failed', step: 'player_content' });
  }

  // TODO (storage cleanup, deferred): before/after this point, remove the
  // Storage objects referenced by the deleted rows — pb_plays.video_url and
  // player_content.storage_path — via admin.storage.from(bucket).remove([...]).
  // Left for a follow-up per the "DB rows only for now" decision.

  // Audit trail: record the deletion (captured in Supabase function logs). Logs
  // the user id, time, and source IP — never the token or password.
  console.log(
    JSON.stringify({
      event: 'account_deletion',
      userId,
      soloTeamsDeleted: soloTeamIds.length,
      ts: new Date().toISOString(),
      ip: req.headers.get('x-forwarded-for') ?? 'unknown',
    }),
  );

  // 4) Finally delete the auth user. This cascades profiles automatically.
  {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) return json(500, { error: 'delete_failed', step: 'auth_user' });
  }

  return json(200, { deleted: true });
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
