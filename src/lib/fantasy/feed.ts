// League feed — system activity + member chat for one league.
//
// fantasy_league_activity: append-only, trigger-written (member joined, team
// created, draft scheduled/live/pick/complete, add/drop, matchup final).
// fantasy_league_messages: chat; members read/post, author or commissioner
// deletes. Both tables are in the realtime publication — subscribeLeagueFeed
// fires on every insert/delete so an open feed stays live. Display names for
// messages come from the league members list (denormalized, public), so the
// feed never reads profiles directly.
//
// Session browser client throughout: activity and messages are both
// members-only under RLS.
//
// Web port of the mobile app's src/lib/fantasy/feed.ts
// (altiusapps/mobileapp-thelayout).

import { createClient as createSessionClient } from '@/lib/supabase/client';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { moderateText } from '@/lib/moderation-players';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

function sessionClient(): AnyClient {
  return createSessionClient() as unknown as AnyClient;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type ActivityKind =
  | 'member_joined'
  | 'team_created'
  | 'draft_scheduled'
  | 'draft_live'
  | 'draft_pick'
  | 'draft_complete'
  | 'add_drop'
  | 'matchup_final'
  | 'trade_proposed'
  | 'trade_accepted'
  | 'trade_executed'
  | 'trade_vetoed'
  | 'trade_rejected';

export interface ActivityItem {
  id: number;
  leagueId: string;
  contestId: string | null;
  kind: ActivityKind;
  actorUserId: string | null;
  teamId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface LeagueMessage {
  id: number;
  leagueId: string;
  userId: string;
  body: string;
  createdAt: string;
}

export type FeedEntry = { type: 'activity'; at: string; item: ActivityItem } | { type: 'message'; at: string; item: LeagueMessage };

function mapActivity(r: Record<string, unknown>): ActivityItem {
  return {
    id: Number(r.id),
    leagueId: r.league_id as string,
    contestId: (r.contest_id as string | null) ?? null,
    kind: r.kind as ActivityKind,
    actorUserId: (r.actor_user_id as string | null) ?? null,
    teamId: (r.team_id as string | null) ?? null,
    payload: (r.payload as Record<string, unknown>) ?? {},
    createdAt: r.created_at as string,
  };
}

function mapMessage(r: Record<string, unknown>): LeagueMessage {
  return {
    id: Number(r.id),
    leagueId: r.league_id as string,
    userId: r.user_id as string,
    body: r.body as string,
    createdAt: r.created_at as string,
  };
}

/** Newest first. Members only (rows carry trade contents + FAAB bids). */
export async function getLeagueActivity(leagueId: string, limit = 50): Promise<ActivityItem[]> {
  const { data, error } = await sessionClient()
    .from('fantasy_league_activity')
    .select('*')
    .eq('league_id', leagueId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(mapActivity);
}

/** Newest first. Members only (RLS) — non-members get []. */
export async function getLeagueMessages(leagueId: string, limit = 100): Promise<LeagueMessage[]> {
  const { data, error } = await sessionClient()
    .from('fantasy_league_messages')
    .select('*')
    .eq('league_id', leagueId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(mapMessage);
}

/** Post a chat message. Client moderation for the instant error; the DB
 *  trigger (ugc_text_is_clean) is the backstop; 30 per 10 min per league. */
export async function sendLeagueMessage(leagueId: string, body: string): Promise<LeagueMessage> {
  const text = body.trim();
  if (text.length < 1) throw new Error('Write something first.');
  if (text.length > 500) throw new Error('Keep it under 500 characters.');
  const bad = await moderateText(text, 'Message');
  if (bad) throw new Error(bad);
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Sign in to chat.');
  const { data, error } = await supabase
    .from('fantasy_league_messages')
    .insert({ league_id: leagueId, user_id: user.id, body: text })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return mapMessage(data as Record<string, unknown>);
}

/** Author or commissioner (RLS decides; a silent no-op otherwise). */
export async function deleteLeagueMessage(id: number): Promise<void> {
  const { error } = await sessionClient().from('fantasy_league_messages').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/** Merge activity + messages into one newest-first timeline. */
export function mergeFeed(activity: ActivityItem[], messages: LeagueMessage[]): FeedEntry[] {
  const entries: FeedEntry[] = [
    ...activity.map((item) => ({ type: 'activity' as const, at: item.createdAt, item })),
    ...messages.map((item) => ({ type: 'message' as const, at: item.createdAt, item })),
  ];
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** One-line copy for a system event. */
export function activityText(item: ActivityItem): string {
  const p = item.payload;
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  switch (item.kind) {
    case 'member_joined':
      return `${s('name') || 'Someone'} joined the league${p.role === 'commissioner' ? ' as commissioner' : ''}.`;
    case 'team_created':
      return `${s('owner') || 'Someone'} created ${s('teamName') || 'a team'}.`;
    case 'draft_scheduled':
      return `Draft scheduled${p.scheduledAt ? ` for ${fmtWhen(s('scheduledAt'))}` : ''} · ${p.draftType === 'auction' ? 'auction' : 'snake'}, ${p.rounds ?? ''} rounds.`;
    case 'draft_live':
      return 'The draft is live.';
    case 'draft_pick':
      return `${s('teamName') || 'A team'} ${p.price != null ? `won ${s('playerName')} for $${p.price}` : `picked ${s('playerName')}`}${p.auto ? ' (auto)' : ''} · #${p.overall ?? ''}`;
    case 'draft_complete':
      return 'The draft is complete — rosters are set.';
    case 'add_drop':
      return `${s('teamName') || 'A team'} added ${s('added')} and dropped ${s('dropped')}.`;
    case 'matchup_final':
      return `${s('label') || 'Result'}: ${s('homeName')} ${p.homePoints ?? ''} – ${p.awayPoints ?? ''} ${s('awayName')}${p.tie ? ' (tie)' : ''}`;
    case 'trade_proposed':
      return `${s('proposer') || 'A team'} proposed a trade to ${s('receiver') || 'a team'}.`;
    case 'trade_accepted':
      return `${s('receiver') || 'A team'} accepted a trade from ${s('proposer') || 'a team'} — executes in 24h unless vetoed.`;
    case 'trade_executed':
      return `Trade: ${s('proposer') || 'A team'} sent ${tradeList(p.give)} to ${s('receiver') || 'a team'} for ${tradeList(p.get)}.`;
    case 'trade_vetoed':
      return `The commissioner vetoed the ${s('proposer') || 'a team'}–${s('receiver') || 'a team'} trade.`;
    case 'trade_rejected':
      return `${s('receiver') || 'A team'} rejected a trade from ${s('proposer') || 'a team'}.`;
    default:
      return 'League update.';
  }
}

function tradeList(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return 'nothing';
  return v.filter((x): x is string => typeof x === 'string').join(', ');
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ── Realtime ────────────────────────────────────────────────────────────────

/** Subscribe to a league's feed: fires on every new activity row and on
 *  message insert/delete. Caller refetches via getLeagueActivity/
 *  getLeagueMessages on events. Returns the channel; caller must clean up
 *  with unsubscribeLeagueFeed() on unmount. Same stale-channel cleanup as
 *  draft-room.ts's subscribeDraft. */
export function subscribeLeagueFeed(leagueId: string, onChange: () => void): RealtimeChannel {
  const supabase = sessionClient();
  const topic = `league-feed:${leagueId}`;
  const stale = supabase.getChannels().find((ch) => ch.topic === `realtime:${topic}`);
  if (stale) supabase.removeChannel(stale);
  return supabase
    .channel(topic)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'fantasy_league_activity', filter: `league_id=eq.${leagueId}` }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'fantasy_league_messages', filter: `league_id=eq.${leagueId}` }, onChange)
    .subscribe();
}

/** Tear down a feed subscription — removeChannel so the singleton client
 *  drops its cached instance and the next mount can subscribe cleanly. */
export function unsubscribeLeagueFeed(channel: RealtimeChannel): void {
  sessionClient().removeChannel(channel);
}
