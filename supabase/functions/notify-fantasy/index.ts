// notify-fantasy: push notifications for the fantasy sub-app.
//
// Three callers, one body shape `{ event, ... }`:
//   { event: 'draft', draftId, contestId, status, oldStatus, currentOverall, oldOverall }
//       ← AFTER UPDATE trigger on fantasy_drafts (fantasy_drafts_notify)
//   { event: 'matchups', matchupIds: string[] }
//       ← score-fantasy, right after it marks H2H matchups scored
//   { event: 'reminders' }
//       ← the 5-minute send-game-notifications cron tick
//
// Categories (game_notifications.category, league = 'fantasy'):
//   draft_reminder  24 h / 1 h before scheduled_at        → league members
//   draft_live      status scheduled → live                → league members
//   draft_on_clock  current_overall advanced while live    → on-clock team's owner
//   draft_complete  status → complete                      → league members
//   matchup_result  a matchup row went scored=true         → both owners
//
// Dedup: claim-before-send into game_notifications (insert-ignore on the
// (league, game_id, category) PK) — the same ledger the game sender uses, so
// a retried trigger/cron tick never double-sends. Preference gate, per push
// and per category: notification_prefs.push_enabled && .fantasy (the Fantasy
// master switch) && the category's own toggle (CATEGORY_PREF; mobile Settings →
// Notifications, 2026-10-13). A missing row or null column = on; an unknown
// category = off. Tokens: push_tokens; DeviceNotRegistered tickets prune the
// token.
//
// Auth: verify_jwt OFF, manual service-key digest compare (same pattern as
// send-game-notifications) — the trigger/cron/scorer all send the vault
// service key.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH = 100;
const LEAGUE = 'fantasy';

type Category = 'draft_reminder' | 'draft_live' | 'draft_on_clock' | 'draft_complete' | 'matchup_result';

const CATEGORY_PREF: Record<Category, string> = {
  draft_reminder: 'fantasy_draft_reminders',
  draft_live: 'fantasy_draft_updates',
  draft_complete: 'fantasy_draft_updates',
  draft_on_clock: 'fantasy_on_clock',
  matchup_result: 'fantasy_matchups',
};
const PREF_COLUMNS = ['push_enabled', 'fantasy', ...new Set(Object.values(CATEGORY_PREF))];
// .in() lists ride in the URL and PostgREST caps a response at 1000 rows.
const IN_CHUNK = 200;

interface Push {
  userIds: string[];
  dedupId: string;
  category: Category;
  title: string;
  body: string;
  data: Record<string, string>;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function periodLabel(period: string): string {
  const m = period.match(/^week-(\d+)$/);
  if (m) return `Week ${m[1]}`;
  return period.charAt(0).toUpperCase() + period.slice(1);
}

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  });
}

// ── Data helpers ─────────────────────────────────────────────────────────────

async function contestInfo(sb: SupabaseClient, contestId: string) {
  const { data } = await sb
    .from('fantasy_contests')
    .select('id, league_id, name, settings, fantasy_leagues:league_id (name)')
    .eq('id', contestId)
    .maybeSingle();
  if (!data) return null;
  const lg = (data as Record<string, unknown>).fantasy_leagues as { name?: string } | null;
  return {
    id: data.id as string,
    leagueId: data.league_id as string,
    name: (lg?.name as string) ?? (data.name as string),
    settings: (data.settings as Record<string, unknown>) ?? {},
  };
}

async function leagueMemberIds(sb: SupabaseClient, leagueId: string): Promise<string[]> {
  const { data } = await sb.from('fantasy_league_members').select('user_id').eq('league_id', leagueId).limit(1000);
  return (data ?? []).map((r: Record<string, unknown>) => r.user_id as string);
}

async function teamOwners(
  sb: SupabaseClient,
  teamIds: string[],
): Promise<Map<string, { ownerId: string; teamName: string; autodraft: boolean }>> {
  const out = new Map<string, { ownerId: string; teamName: string; autodraft: boolean }>();
  if (teamIds.length === 0) return out;
  const { data } = await sb.from('fantasy_teams').select('id, owner_id, team_name, autodraft').in('id', teamIds);
  for (const r of data ?? []) {
    out.set(r.id as string, { ownerId: r.owner_id as string, teamName: r.team_name as string, autodraft: Boolean(r.autodraft) });
  }
  return out;
}

/** Snake: team on the clock for a 1-based overall. Auction: the nominator. */
function teamForOverall(draftOrder: string[], overall: number, draftType: string): string | null {
  const n = draftOrder.length;
  if (n === 0) return null;
  const idx0 = overall - 1;
  if (draftType === 'auction') return draftOrder[idx0 % n] ?? null;
  const round = Math.floor(idx0 / n);
  const pos = idx0 % n;
  return draftOrder[round % 2 === 0 ? pos : n - 1 - pos] ?? null;
}

// ── Delivery ─────────────────────────────────────────────────────────────────

async function deliver(sb: SupabaseClient, pushes: Push[], dryRun: boolean) {
  const summary: Array<{ dedupId: string; category: Category; users: number; recipients: number }> = [];
  if (pushes.length === 0) return { claimed: 0, sent: 0, summary };

  // 1. Preference gate. A failed read throws: sending to everyone would ignore
  // every opt-out.
  const allUsers = [...new Set(pushes.flatMap((p) => p.userIds))];
  const prefs = new Map<string, Record<string, unknown>>();
  for (const ids of chunk(allUsers, IN_CHUNK)) {
    const { data: prefRows, error: prefErr } = await sb
      .from('notification_prefs')
      .select(`user_id, ${PREF_COLUMNS.join(', ')}`)
      .in('user_id', ids);
    if (prefErr) throw prefErr;
    // The column list is built at runtime, which supabase-js can't type.
    for (const r of (prefRows ?? []) as unknown as Record<string, unknown>[]) prefs.set(r.user_id as string, r);
  }
  const allowed = (u: string, category: Category) => {
    if (!Object.hasOwn(CATEGORY_PREF, category)) return false;
    const column = CATEGORY_PREF[category];
    const p = prefs.get(u);
    if (!p) return true;
    return p.push_enabled !== false && p.fantasy !== false && p[column] !== false;
  };
  const targetsOf = (p: Push) => p.userIds.filter((u) => allowed(u, p.category));

  // 2. Claim (insert-ignore) — only rows that actually inserted get sent.
  const eligible = pushes.filter((p) => targetsOf(p).length > 0);
  if (eligible.length === 0 || dryRun) {
    for (const p of eligible) summary.push({ dedupId: p.dedupId, category: p.category, users: targetsOf(p).length, recipients: 0 });
    return { claimed: 0, sent: 0, summary };
  }
  const { data: claimedRows, error: claimErr } = await sb
    .from('game_notifications')
    .upsert(
      eligible.map((p) => ({ league: LEAGUE, game_id: p.dedupId, category: p.category })),
      { onConflict: 'league,game_id,category', ignoreDuplicates: true },
    )
    .select('game_id, category');
  if (claimErr) throw claimErr;
  const claimedKeys = new Set((claimedRows ?? []).map((r: Record<string, unknown>) => `${r.game_id}|${r.category}`));
  const claimed = eligible.filter((p) => claimedKeys.has(`${p.dedupId}|${p.category}`));
  if (claimed.length === 0) return { claimed: 0, sent: 0, summary };

  // 3. Tokens.
  const users = [...new Set(claimed.flatMap(targetsOf))];
  const tokensByUser = new Map<string, string[]>();
  for (const ids of chunk(users, IN_CHUNK)) {
    const { data: tokenRows, error: tokenErr } = await sb.from('push_tokens').select('user_id, token').in('user_id', ids);
    // Already claimed, so a retry won't resend: log it rather than lose it silently.
    if (tokenErr) console.error('[notify-fantasy] push_tokens read failed', tokenErr);
    for (const r of tokenRows ?? []) {
      const list = tokensByUser.get(r.user_id as string) ?? [];
      list.push(r.token as string);
      tokensByUser.set(r.user_id as string, list);
    }
  }

  // 4. Send.
  let sent = 0;
  for (const p of claimed) {
    const targets = targetsOf(p);
    const messages = targets.flatMap((u) => (tokensByUser.get(u) ?? []).map((to) => ({ to, title: p.title, body: p.body, data: p.data })));
    const delivered = messages.length > 0 ? await sendExpoPushes(sb, messages) : 0;
    sent += delivered;
    summary.push({ dedupId: p.dedupId, category: p.category, users: targets.length, recipients: delivered });
    await sb
      .from('game_notifications')
      .update({ recipients: delivered })
      .eq('league', LEAGUE)
      .eq('game_id', p.dedupId)
      .eq('category', p.category);
  }
  return { claimed: claimed.length, sent, summary };
}

async function sendExpoPushes(
  sb: SupabaseClient,
  messages: Array<{ to: string; title: string; body: string; data: Record<string, string> }>,
): Promise<number> {
  let delivered = 0;
  for (const batch of chunk(messages, EXPO_BATCH)) {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch.map((m) => ({ ...m, sound: 'default' }))),
    });
    if (!res.ok) {
      console.error('[notify-fantasy] expo push HTTP', res.status, await res.text());
      continue;
    }
    const json = (await res.json()) as { data?: Array<{ status: string; details?: { error?: string } }> };
    const tickets = json.data ?? [];
    for (let i = 0; i < tickets.length; i++) {
      const t = tickets[i];
      if (t.status === 'ok') delivered += 1;
      else if (t.details?.error === 'DeviceNotRegistered') await sb.from('push_tokens').delete().eq('token', batch[i].to);
      else console.warn('[notify-fantasy] ticket error', batch[i].to.slice(0, 24), t.details?.error);
    }
  }
  return delivered;
}

// ── Event builders ───────────────────────────────────────────────────────────

interface DraftEvent {
  draftId: string;
  contestId: string;
  status: string;
  oldStatus?: string;
  currentOverall: number;
  oldOverall?: number;
}

async function draftPushes(sb: SupabaseClient, ev: DraftEvent): Promise<Push[]> {
  const { data: draft } = await sb.from('fantasy_drafts').select('*').eq('id', ev.draftId).maybeSingle();
  if (!draft) return [];
  const contest = await contestInfo(sb, ev.contestId);
  if (!contest) return [];
  const members = await leagueMemberIds(sb, contest.leagueId);
  const draftOrder = (draft.draft_order as string[]) ?? [];
  const draftType = (draft.draft_type as string) ?? 'snake';
  const out: Push[] = [];
  const draftData = { fantasy: 'draft', contestId: contest.id, draftId: ev.draftId };

  const wentLive = ev.status === 'live' && ev.oldStatus !== 'live';
  if (wentLive) {
    out.push({
      userIds: members,
      dedupId: `${ev.draftId}:live`,
      category: 'draft_live',
      title: `${contest.name} draft is live`,
      body: draftType === 'auction' ? 'The auction has started — jump into the draft room.' : 'The draft has started — jump into the draft room.',
      data: draftData,
    });
  }

  if (ev.status === 'complete' && ev.oldStatus !== 'complete') {
    out.push({
      userIds: members,
      dedupId: `${ev.draftId}:complete`,
      category: 'draft_complete',
      title: `${contest.name} draft is complete`,
      body: 'Rosters are set. Check your team and the schedule.',
      data: { fantasy: 'league', contestId: contest.id },
    });
  }

  if (ev.status === 'live' && (wentLive || ev.currentOverall !== ev.oldOverall)) {
    const teamId = teamForOverall(draftOrder, ev.currentOverall, draftType);
    if (teamId) {
      const owners = await teamOwners(sb, [teamId]);
      const owner = owners.get(teamId);
      // An autodraft team is picked for the moment it's up — no "on the clock" ping.
      if (owner && !owner.autodraft) {
        const n = Math.max(draftOrder.length, 1);
        const round = Math.floor((ev.currentOverall - 1) / n) + 1;
        out.push({
          userIds: [owner.ownerId],
          dedupId: `${ev.draftId}:${ev.currentOverall}`,
          category: 'draft_on_clock',
          title: draftType === 'auction' ? "You're up to nominate" : "You're on the clock",
          body:
            draftType === 'auction'
              ? `${contest.name} — pick a player to put up for bid (${draft.nomination_seconds}s).`
              : `${contest.name} — round ${round}, pick ${ev.currentOverall}. ${draft.pick_seconds}s on the clock.`,
          data: draftData,
        });
      }
    }
  }
  return out;
}

async function reminderPushes(sb: SupabaseClient, now: number): Promise<Push[]> {
  // Two 10-minute windows so a 5-minute cron catches each exactly once
  // (dedup makes a second hit a no-op anyway).
  const windows: Array<{ key: '24h' | '1h'; from: number; to: number; title: string; body: (when: string) => string }> = [
    { key: '24h', from: now + 23.9 * 3600_000, to: now + 24.1 * 3600_000, title: 'Draft tomorrow', body: (w) => `Your draft is scheduled for ${w}.` },
    { key: '1h', from: now + 55 * 60_000, to: now + 65 * 60_000, title: 'Draft in 1 hour', body: (w) => `Your draft starts at ${w}. The room opens now.` },
  ];
  const out: Push[] = [];
  for (const w of windows) {
    const { data: drafts } = await sb
      .from('fantasy_drafts')
      .select('id, contest_id, scheduled_at, draft_type')
      .eq('status', 'scheduled')
      .gte('scheduled_at', new Date(w.from).toISOString())
      .lt('scheduled_at', new Date(w.to).toISOString())
      .limit(200);
    for (const d of drafts ?? []) {
      const contest = await contestInfo(sb, d.contest_id as string);
      if (!contest) continue;
      const members = await leagueMemberIds(sb, contest.leagueId);
      out.push({
        userIds: members,
        dedupId: `${d.id}:${w.key}`,
        category: 'draft_reminder',
        title: `${w.title} · ${contest.name}`,
        body: w.body(fmtWhen(d.scheduled_at as string)),
        data: { fantasy: 'draft', contestId: contest.id, draftId: d.id as string },
      });
    }
  }
  return out;
}

async function matchupPushes(sb: SupabaseClient, matchupIds: string[]): Promise<Push[]> {
  if (matchupIds.length === 0) return [];
  const { data: rows } = await sb
    .from('fantasy_matchups')
    .select('id, contest_id, period, stage, home_team_id, away_team_id, home_points, away_points, winner_team_id, scored')
    .in('id', matchupIds.slice(0, 500))
    .eq('scored', true)
    .not('away_team_id', 'is', null);
  if (!rows || rows.length === 0) return [];

  const teamIds = [...new Set(rows.flatMap((m) => [m.home_team_id as string, m.away_team_id as string]))];
  const owners = await teamOwners(sb, teamIds);
  const contests = new Map<string, Awaited<ReturnType<typeof contestInfo>>>();
  const out: Push[] = [];

  for (const m of rows) {
    const cid = m.contest_id as string;
    if (!contests.has(cid)) contests.set(cid, await contestInfo(sb, cid));
    const contest = contests.get(cid);
    if (!contest) continue;
    const home = owners.get(m.home_team_id as string);
    const away = owners.get(m.away_team_id as string);
    if (!home || !away) continue;
    const hp = Number(m.home_points ?? 0);
    const ap = Number(m.away_points ?? 0);
    const stage = m.stage as string;
    const label = stage === 'regular' ? periodLabel(m.period as string) : stage === 'third' ? 'Third-place game' : stage.charAt(0).toUpperCase() + stage.slice(1);

    for (const side of ['home', 'away'] as const) {
      const me = side === 'home' ? home : away;
      const opp = side === 'home' ? away : home;
      const myPts = side === 'home' ? hp : ap;
      const oppPts = side === 'home' ? ap : hp;
      const myTeamId = side === 'home' ? (m.home_team_id as string) : (m.away_team_id as string);
      const verdict = m.winner_team_id == null ? 'Tie' : m.winner_team_id === myTeamId ? 'You won' : 'You lost';
      out.push({
        userIds: [me.ownerId],
        dedupId: `${m.id}:${myTeamId}`,
        category: 'matchup_result',
        title: `${label} · ${contest.name}`,
        body: `${verdict}: ${me.teamName} ${myPts.toFixed(1)} – ${oppPts.toFixed(1)} ${opp.teamName}`,
        data: { fantasy: 'match', contestId: contest.id, period: m.period as string },
      });
    }
  }
  return out;
}

// ── Handler ──────────────────────────────────────────────────────────────────

async function authorized(req: Request, serviceKey: string): Promise<boolean> {
  if (!serviceKey) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(req.headers.get('Authorization') ?? '')),
    crypto.subtle.digest('SHA-256', enc.encode(`Bearer ${serviceKey}`)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!(await authorized(req, serviceKey))) return new Response('unauthorized', { status: 401 });
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', serviceKey);
  const dryRun = new URL(req.url).searchParams.get('dryRun') === '1';

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* empty ok */
  }

  try {
    let pushes: Push[] = [];
    const event = body.event as string | undefined;
    if (event === 'draft') {
      pushes = await draftPushes(sb, {
        draftId: String(body.draftId ?? ''),
        contestId: String(body.contestId ?? ''),
        status: String(body.status ?? ''),
        oldStatus: body.oldStatus == null ? undefined : String(body.oldStatus),
        currentOverall: Number(body.currentOverall ?? 0),
        oldOverall: body.oldOverall == null ? undefined : Number(body.oldOverall),
      });
    } else if (event === 'matchups') {
      const ids = Array.isArray(body.matchupIds) ? (body.matchupIds as unknown[]).map(String) : [];
      pushes = await matchupPushes(sb, ids);
    } else if (event === 'reminders') {
      pushes = await reminderPushes(sb, Date.now());
    } else {
      return Response.json({ ok: false, error: 'unknown event' }, { status: 400 });
    }
    const result = await deliver(sb, pushes, dryRun);
    return Response.json({ ok: true, dryRun, event, candidates: pushes.length, ...result });
  } catch (err) {
    console.error('[notify-fantasy] failed:', err);
    return Response.json({ ok: false, error: 'notify failed — see function logs' }, { status: 500 });
  }
});
