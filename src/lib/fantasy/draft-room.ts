// Fantasy draft room — client contract (P2, 2026-08-27; auction + readiness/
// reschedule added 2026-09-08 — see below).
//
// This file is the AGREED INTERFACE between the DB layer (migrations + RPCs,
// built by the backend pass) and the draft-room UI. UI imports ONLY from
// here; the backend pass implements the RPCs these wrappers call and may
// adjust internals but NOT these signatures without updating both sides.
//
// Rules (Hunter, 2026-08-27): snake or auction (2026-09-08); rounds = team
// size, fixed by the game since 2026-10-07 (teamSize in competitions.ts):
// weekly 12 (7 starters + 5 bench), event 7 (no bench); 60s default pick
// clock for snake (commissioner-configurable);
// drafted leagues are owner-exclusive (a player belongs to ONE team per
// contest, tracked in fantasy_team_players — moves on add/drop).
//
// Clock model (snake): NO cron. The server stamps current_started_at per
// pick; clients render the countdown from it. When expired, ANY league
// member's client calls resolveDraftClock() — first caller wins, the RPC
// autopicks (queue first, then best-available) for every expired turn;
// concurrent callers no-op. Realtime keeps every open room in sync.
//
// Clock model (auction, 2026-09-08): current_overall doubles as the
// nomination counter; current_started_at is whichever clock (nomination or
// bidding) is currently running. An open fantasy_draft_nominations row means
// bidding is live (ends_at is its clock); no open row means the game is
// waiting on the next nominator. resolveAuction() is the auction equivalent
// of resolveDraftClock() — any league member may call it; it both closes
// expired nominations into picks and opens the next nomination when the
// nomination clock has expired.

import { createClient } from '@/lib/supabase/client';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

// fantasy_* tables/RPCs are deliberately NOT in the generated
// database.types.ts (repo convention — local interfaces + cast; see
// leagues.ts). Same untyped-client pattern here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;
function client(): AnyClient {
  return createClient() as unknown as AnyClient;
}

export type DraftStatus = 'scheduled' | 'live' | 'complete';

/** The snake pick clock and the auction nomination clock are both 90 seconds,
 *  fixed by the game (Hunter, 2026-10-08). The server ignores what's sent. */
export const DRAFT_CLOCK_SECONDS = 90;

/** The server resolves an expired clock only this long after it hits 0, so a
 *  client resolving right at 0 would always be told "not yet". */
export const CLOCK_GRACE_MS = 3000;
export type DraftType = 'snake' | 'auction';

export interface DraftRef {
  playerLeague: string; // 'ufa' | 'usau' | 'pul' | 'wul' | 'wfdf' | 'euf'
  playerId: string;
  playerName: string;
}

export interface Draft {
  id: string;
  contestId: string;
  status: DraftStatus;
  draftType: DraftType;
  rounds: number;
  pickSeconds: number;
  /** Team ids in round-1 order; snake reverses on even rounds. */
  draftOrder: string[];
  /** 1-based overall pick currently on the clock (or rounds*teams+1 when
   *  complete); for auction this doubles as the nomination counter. */
  currentOverall: number;
  /** When the current pick's clock started (ISO); null until live. */
  currentStartedAt: string | null;
  scheduledAt: string | null;
  /** auction only: per-team starting budget / clock lengths / bid floor. */
  budget: number;
  nominationSeconds: number;
  bidSeconds: number;
  minBid: number;
  /** The FIRST scheduled_at ever set (never moved by reschedule) — the
   *  anchor the missed-draft reschedule floor is measured from. */
  originalScheduledAt: string | null;
  rescheduleCount: number;
}

export interface DraftPick {
  overall: number;
  round: number;
  teamId: string;
  playerLeague: string;
  playerId: string;
  playerName: string;
  auto: boolean;
  /** auction only: the winning bid amount. */
  price: number | null;
}

export interface DraftReadiness {
  rostersReady: boolean;
  sourceLabel: string;
  earliestAt: string | null;
  lockAt: string | null;
  defaultAt: string | null;
  teamCount: number;
  minTeams: number;
  maxTeams: number | null;
  draftId: string | null;
  draftStatus: DraftStatus | null;
  draftType: DraftType | null;
  scheduledAt: string | null;
  originalScheduledAt: string | null;
  missed: boolean;
  rescheduleFloor: string | null;
}

export interface DraftNomination {
  id: string;
  overall: number;
  teamId: string;
  playerLeague: string;
  playerId: string;
  playerName: string;
  openedAt: string;
  endsAt: string;
  highBid: number;
  highTeamId: string;
  status: 'open' | 'won';
  auto: boolean;
}

export interface DraftBid {
  nominationId: string;
  teamId: string;
  amount: number;
  createdAt: string;
}

export interface DraftPrice extends DraftRef {
  price: number;
}

export interface AuctionTeamState {
  teamId: string;
  spent: number;
  remaining: number;
  openSlots: number;
  maxBid: number;
}

/** Snake math shared by UI + server (server is authoritative; this mirrors
 *  it for rendering). overall is 1-based. */
export function teamOnClock(draft: Pick<Draft, 'draftOrder' | 'currentOverall'>): string | null {
  const n = draft.draftOrder.length;
  if (n === 0) return null;
  const idx0 = draft.currentOverall - 1;
  const round = Math.floor(idx0 / n); // 0-based
  const pos = idx0 % n;
  return draft.draftOrder[round % 2 === 0 ? pos : n - 1 - pos] ?? null;
}

export function roundOf(overall: number, teamCount: number): number {
  return Math.floor((overall - 1) / Math.max(teamCount, 1)) + 1;
}

/** Auction nominator = draft_order[(currentOverall-1) mod n]. Mirrors
 *  fantasy_auction_team_to_nominate on the server — but that RPC additionally
 *  skips teams with no open slots / insufficient budget (server-authoritative
 *  for who can actually nominate); this is display-only. */
export function teamToNominate(draft: Pick<Draft, 'draftOrder' | 'currentOverall'>): string | null {
  const n = draft.draftOrder.length;
  if (n === 0) return null;
  const idx0 = draft.currentOverall - 1;
  return draft.draftOrder[((idx0 % n) + n) % n] ?? null;
}

/** Client-side mirror of fantasy_auction_team_state — spent/remaining/
 *  open-slot/max-bid math for one team, from picks already on the board.
 *  Server is authoritative (used to validate bids); this is for rendering. */
export function auctionTeamState(
  draft: Pick<Draft, 'budget' | 'rounds' | 'minBid'>,
  picks: Pick<DraftPick, 'teamId' | 'price'>[],
  teamId: string,
): AuctionTeamState {
  const mine = picks.filter((p) => p.teamId === teamId);
  const spent = mine.reduce((acc, p) => acc + (p.price ?? 0), 0);
  const remaining = draft.budget - spent;
  const openSlots = draft.rounds - mine.length;
  const maxBid = remaining - Math.max(openSlots - 1, 0) * draft.minBid;
  return { teamId, spent, remaining, openSlots, maxBid };
}

// ── RPC wrappers ────────────────────────────────────────────────────────────

function mapDraft(row: Record<string, unknown>): Draft {
  return {
    id: row.id as string,
    contestId: row.contest_id as string,
    status: row.status as DraftStatus,
    draftType: (row.draft_type as DraftType) ?? 'snake',
    rounds: row.rounds as number,
    pickSeconds: row.pick_seconds as number,
    draftOrder: (row.draft_order as string[]) ?? [],
    currentOverall: row.current_overall as number,
    currentStartedAt: (row.current_started_at as string | null) ?? null,
    scheduledAt: (row.scheduled_at as string | null) ?? null,
    budget: (row.budget as number) ?? 200,
    nominationSeconds: (row.nomination_seconds as number) ?? 30,
    bidSeconds: (row.bid_seconds as number) ?? 15,
    minBid: (row.min_bid as number) ?? 1,
    originalScheduledAt: (row.original_scheduled_at as string | null) ?? null,
    rescheduleCount: (row.reschedule_count as number) ?? 0,
  };
}

function mapPick(row: Record<string, unknown>): DraftPick {
  return {
    overall: row.overall as number,
    round: row.round as number,
    teamId: row.team_id as string,
    playerLeague: row.player_league as string,
    playerId: row.player_id as string,
    playerName: row.player_name as string,
    auto: row.auto as boolean,
    price: (row.price as number | null) ?? null,
  };
}

function mapReadiness(row: Record<string, unknown>): DraftReadiness {
  return {
    rostersReady: row.rosters_ready as boolean,
    sourceLabel: row.source_label as string,
    earliestAt: (row.earliest_at as string | null) ?? null,
    lockAt: (row.lock_at as string | null) ?? null,
    defaultAt: (row.default_at as string | null) ?? null,
    teamCount: row.team_count as number,
    minTeams: row.min_teams as number,
    maxTeams: (row.max_teams as number | null) ?? null,
    draftId: (row.draft_id as string | null) ?? null,
    draftStatus: (row.draft_status as DraftStatus | null) ?? null,
    draftType: (row.draft_type as DraftType | null) ?? null,
    scheduledAt: (row.scheduled_at as string | null) ?? null,
    originalScheduledAt: (row.original_scheduled_at as string | null) ?? null,
    missed: Boolean(row.missed),
    rescheduleFloor: (row.reschedule_floor as string | null) ?? null,
  };
}

function mapNomination(row: Record<string, unknown>): DraftNomination {
  return {
    id: row.id as string,
    overall: row.overall as number,
    teamId: row.team_id as string,
    playerLeague: row.player_league as string,
    playerId: row.player_id as string,
    playerName: row.player_name as string,
    openedAt: row.opened_at as string,
    endsAt: row.ends_at as string,
    highBid: row.high_bid as number,
    highTeamId: row.high_team_id as string,
    status: row.status as 'open' | 'won',
    auto: row.auto as boolean,
  };
}

function mapBid(row: Record<string, unknown>): DraftBid {
  return {
    nominationId: row.nomination_id as string,
    teamId: row.team_id as string,
    amount: row.amount as number,
    createdAt: row.created_at as string,
  };
}

/** The contest's draft, or null when none is scheduled. Public read. */
export async function getDraft(contestId: string): Promise<Draft | null> {
  const supabase = client();
  const { data, error } = await supabase
    .from('fantasy_drafts')
    .select('*')
    .eq('contest_id', contestId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapDraft(data as Record<string, unknown>) : null;
}

/** All picks so far, overall ascending. Public read (spectatable board). */
export async function getDraftPicks(draftId: string): Promise<DraftPick[]> {
  const supabase = client();
  const { data, error } = await supabase
    .from('fantasy_draft_picks')
    .select('*')
    .eq('draft_id', draftId)
    .order('overall', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(mapPick);
}

/** Commissioner: create/schedule the contest's draft. */
export async function scheduleDraft(input: {
  contestId: string;
  at: string | null; // ISO; null = "manual start whenever"
  rounds?: number;
}): Promise<Draft> {
  const supabase = client();
  const { data, error } = await supabase.rpc('fantasy_schedule_draft', {
    p_contest: input.contestId,
    p_at: input.at,
    p_pick_seconds: DRAFT_CLOCK_SECONDS,
    p_rounds: input.rounds ?? 12,
  });
  if (error) throw error;
  return mapDraft(data as Record<string, unknown>);
}

/** Commissioner: go live (shuffles/locks the order server-side). */
export async function startDraft(draftId: string): Promise<Draft> {
  const supabase = client();
  const { data, error } = await supabase.rpc('fantasy_start_draft', { p_draft: draftId });
  if (error) throw error;
  return mapDraft(data as Record<string, unknown>);
}

/** Make the pick for the caller's team (must be on the clock). */
export async function makeDraftPick(draftId: string, player: DraftRef): Promise<DraftPick> {
  const supabase = client();
  const { data, error } = await supabase.rpc('fantasy_make_pick', {
    p_draft: draftId,
    p_player_league: player.playerLeague,
    p_player_id: player.playerId,
    p_player_name: player.playerName,
  });
  if (error) throw error;
  return mapPick(data as Record<string, unknown>);
}

/** Resolve expired clocks (autopick). Any league member may call; returns the
 *  number of autopicks applied (0 = clock wasn't expired / already resolved). */
export async function resolveDraftClock(draftId: string): Promise<number> {
  const supabase = client();
  const { data, error } = await supabase.rpc('fantasy_resolve_clock', { p_draft: draftId });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** Save the caller's private pick queue (ordered). Owner-only via RLS. */
export async function saveDraftQueue(draftId: string, entries: DraftRef[]): Promise<void> {
  const supabase = client();
  const { error } = await supabase.rpc('fantasy_set_queue', {
    p_draft: draftId,
    p_entries: entries,
  });
  if (error) throw error;
}

/** Teams in the contest on autodraft: picked for (or nominate) the moment
 *  they're up. A missed pick turns it on; a manager can toggle their own. */
export async function getAutodraftTeamIds(contestId: string): Promise<Set<string>> {
  const { data, error } = await client()
    .from('fantasy_teams')
    .select('id')
    .eq('contest_id', contestId)
    .eq('autodraft', true);
  if (error) throw error;
  return new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
}

/** Put the caller's own team on or off autodraft. Turning it on while the team
 *  is on the clock picks (or nominates) right away. */
export async function setAutodraft(draftId: string, on: boolean): Promise<boolean> {
  const { data, error } = await client().rpc('fantasy_set_autodraft', { p_draft: draftId, p_on: on });
  if (error) throw error;
  return Boolean(data);
}

/** The caller's queue ([] when none). */
export async function getMyDraftQueue(draftId: string): Promise<DraftRef[]> {
  const supabase = client();
  const { data, error } = await supabase
    .from('fantasy_draft_queues')
    .select('entries')
    .eq('draft_id', draftId)
    .maybeSingle();
  if (error) throw error;
  return ((data?.entries ?? []) as DraftRef[]) || [];
}

// ── Readiness / reschedule ──────────────────────────────────────────────────

/** Draft-window state for a contest: whether rosters exist yet, the earliest
 *  allowed start, the current lock, a suggested default time, team-count
 *  limits, and (once scheduled) the draft's own status/missed/reschedule
 *  info. Authenticated only. */
export async function getDraftReadiness(contestId: string): Promise<DraftReadiness> {
  const supabase = client();
  const { data, error } = await supabase.rpc('fantasy_draft_readiness', { p_contest: contestId });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown>;
  return mapReadiness(row);
}

/** Commissioner: move a scheduled draft's start time. A missed draft
 *  (scheduled_at already passed) must be rescheduled at least 2 days out. */
export async function rescheduleDraft(draftId: string, at: string): Promise<Draft> {
  const supabase = client();
  const { data, error } = await supabase.rpc('fantasy_reschedule_draft', { p_draft: draftId, p_at: at });
  if (error) throw error;
  return mapDraft(data as Record<string, unknown>);
}

// ── Auction ──────────────────────────────────────────────────────────────────

/** Commissioner: create/schedule an AUCTION draft for the contest. */
export async function scheduleAuctionDraft(input: {
  contestId: string;
  at: string | null;
  rounds?: number;
  budget?: number;
  bidSeconds?: number;
  minBid?: number;
}): Promise<Draft> {
  const supabase = client();
  const { data, error } = await supabase.rpc('fantasy_schedule_auction_draft', {
    p_contest: input.contestId,
    p_at: input.at,
    p_rounds: input.rounds ?? 12,
    p_budget: input.budget ?? 200,
    p_nomination_seconds: DRAFT_CLOCK_SECONDS,
    p_bid_seconds: input.bidSeconds ?? 15,
    p_min_bid: input.minBid ?? 1,
  });
  if (error) throw error;
  return mapDraft(data as Record<string, unknown>);
}

/** Commissioner: set suggested opening bids for an auction draft (pre-start only). */
export async function setDraftPrices(draftId: string, prices: DraftPrice[]): Promise<number> {
  const supabase = client();
  const { data, error } = await supabase.rpc('fantasy_set_draft_prices', {
    p_draft: draftId,
    p_prices: prices.map((p) => ({ playerLeague: p.playerLeague, playerId: p.playerId, price: p.price })),
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** The commissioner-set opening bids for an auction draft. Public read. */
export async function getDraftPrices(draftId: string): Promise<DraftPrice[]> {
  const supabase = client();
  const { data, error } = await supabase
    .from('fantasy_draft_prices')
    .select('player_league, player_id, price')
    .eq('draft_id', draftId);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    playerLeague: r.player_league as string,
    playerId: r.player_id as string,
    playerName: r.player_id as string,
    price: r.price as number,
  }));
}

/** Put a player up for auction. Caller's team must be the current nominator. */
export async function nominatePlayer(draftId: string, player: DraftRef, opening?: number): Promise<DraftNomination> {
  const supabase = client();
  const { data, error } = await supabase.rpc('fantasy_nominate', {
    p_draft: draftId,
    p_player_league: player.playerLeague,
    p_player_id: player.playerId,
    p_player_name: player.playerName,
    p_opening: opening ?? null,
  });
  if (error) throw error;
  return mapNomination(data as Record<string, unknown>);
}

/** Bid on the currently open nomination. */
export async function placeBid(draftId: string, amount: number): Promise<DraftNomination> {
  const supabase = client();
  const { data, error } = await supabase.rpc('fantasy_bid', { p_draft: draftId, p_amount: amount });
  if (error) throw error;
  return mapNomination(data as Record<string, unknown>);
}

/** Resolve expired auction clocks (close won nominations, open the next
 *  nomination). Any league member may call; returns the number of state
 *  transitions applied (0 = nothing was expired). */
export async function resolveAuction(draftId: string): Promise<number> {
  const supabase = client();
  const { data, error } = await supabase.rpc('fantasy_resolve_auction', { p_draft: draftId });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** The currently open nomination, or null when none is open. */
export async function getOpenNomination(draftId: string): Promise<DraftNomination | null> {
  const supabase = client();
  const { data, error } = await supabase.rpc('fantasy_get_open_nomination', { p_draft: draftId });
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  if (!row.id) return null;
  return mapNomination(row);
}

/** Every nomination for a draft (won + open), newest first — the auction's
 *  results ticker. Public read. */
export async function getNominations(draftId: string): Promise<DraftNomination[]> {
  const supabase = client();
  const { data, error } = await supabase
    .from('fantasy_draft_nominations')
    .select('*')
    .eq('draft_id', draftId)
    .order('overall', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(mapNomination);
}

/** Bid history for one nomination, oldest first. */
export async function getNominationBids(nominationId: string): Promise<DraftBid[]> {
  const supabase = client();
  const { data, error } = await supabase.rpc('fantasy_get_nomination_bids', { p_nomination: nominationId });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(mapBid);
}

/** Subscribe to an auction's nominations + bids. Same cleanup contract as
 *  subscribeDraft — caller must unsubscribeDraft() on unmount. */
export function subscribeAuction(draftId: string, onChange: () => void): RealtimeChannel {
  const supabase = client();
  const stale = supabase.getChannels().find((c) => c.topic === `realtime:auction:${draftId}`);
  if (stale) supabase.removeChannel(stale);
  return supabase
    .channel(`auction:${draftId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'fantasy_draft_nominations', filter: `draft_id=eq.${draftId}` },
      onChange,
    )
    .subscribe();
}

// ── Realtime ────────────────────────────────────────────────────────────────

/** Subscribe a draft room: fires on every new pick and on draft-row updates
 *  (status/clock advance). Caller refetches via getDraft/getDraftPicks on
 *  events (payloads are notifications, not the source of truth). Returns the
 *  channel; caller must clean up with unsubscribeDraft() on unmount. */
export function subscribeDraft(
  draftId: string,
  onChange: () => void,
): RealtimeChannel {
  const supabase = client();
  // The browser client is a singleton and caches channels by topic. A prior
  // mount's channel (unsubscribed or not) is returned as-is by channel(), and
  // adding .on() to a once-subscribed channel throws — remove any stale
  // instance first so re-entering the room (or a dev double-mount) works.
  const stale = supabase.getChannels().find((c) => c.topic === `realtime:draft:${draftId}`);
  if (stale) supabase.removeChannel(stale);
  return supabase
    .channel(`draft:${draftId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'fantasy_draft_picks', filter: `draft_id=eq.${draftId}` },
      onChange,
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'fantasy_drafts', filter: `id=eq.${draftId}` },
      onChange,
    )
    .subscribe();
}

/** Tear down a room subscription — removeChannel (not bare unsubscribe) so
 *  the singleton client drops its cached instance and the next mount can
 *  subscribe cleanly. */
export function unsubscribeDraft(channel: RealtimeChannel): void {
  client().removeChannel(channel);
}
