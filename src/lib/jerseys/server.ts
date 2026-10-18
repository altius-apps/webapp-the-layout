import 'server-only';

// Jersey marketplace — server-side reads for RSC pages.
//
// RLS does the access control (active rows are world-readable; withdrawn ones
// only to their owner), so these read with the caller's session and simply
// render whatever comes back. Reads return [] / null on error rather than
// throwing — a marketplace page should degrade, not 500.
//
// PRIVACY: seller identity comes from the `profiles` embed but we only ever
// project display_name / username / avatar_*. Never select email or phone.

import { createClient } from '@/lib/supabase/server';
import { STORAGE_BUCKET } from './types';
import type {
  JerseyListing,
  JerseyWant,
  JerseyPhoto,
  JerseyEventTag,
  JerseyPoster,
  JerseyThread,
  JerseyMessage,
} from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const POSTER_COLS = 'id, display_name, username, avatar_url, avatar_icon';

const LISTING_COLS = `
  id, owner_id, kind, title, description, size, condition, price_cents,
  league, team_id, team_name, team_logo_url, league_name, player_name, year,
  city, state, country, status, created_at, updated_at,
  owner:profiles!jersey_listings_owner_id_fkey(${POSTER_COLS}),
  jersey_photos(id, storage_path, sort_order),
  jersey_listing_events(id, usau_event_id, event_name, event_starts_on,
                        usau_events(usau_slug, name, start_date, series_group_key, series_group_name))
`;

const WANT_COLS = `
  id, user_id, size, note,
  league, team_id, team_name, team_logo_url, league_name, player_name, year,
  city, state, country, status, created_at, updated_at,
  user:profiles!jersey_wants_user_id_fkey(${POSTER_COLS}),
  jersey_listing_events(id, usau_event_id, event_name, event_starts_on,
                        usau_events(usau_slug, name, start_date, series_group_key, series_group_name))
`;

function mapPoster(row: any): JerseyPoster | null {
  if (!row) return null;
  return {
    id: String(row.id),
    displayName: row.display_name ?? null,
    username: row.username ?? null,
    avatarUrl: row.avatar_url ?? null,
    avatarIcon: row.avatar_icon ?? null,
  };
}

function mapPhotos(rows: any[], publicUrlFor: (p: string) => string): JerseyPhoto[] {
  return (rows ?? [])
    .map((p) => ({
      id: String(p.id),
      storagePath: String(p.storage_path),
      publicUrl: publicUrlFor(String(p.storage_path)),
      sortOrder: Number(p.sort_order ?? 0),
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** An event tag resolves its display name from the linked USAU event when there
 *  is one, else from the free text the user typed. */
function mapEvents(rows: any[]): JerseyEventTag[] {
  return (rows ?? [])
    .map((e) => {
      const linked = e.usau_events ?? null;
      // A Sectional/Regional division row shows (and links) as its merged event.
      const name = linked?.series_group_name ?? linked?.name ?? e.event_name ?? null;
      if (!name) return null;
      return {
        id: String(e.id),
        usauEventId: e.usau_event_id ? String(e.usau_event_id) : null,
        usauEventSlug: linked?.series_group_key ?? linked?.usau_slug ?? null,
        name: String(name),
        startsOn: linked?.start_date ?? e.event_starts_on ?? null,
      };
    })
    .filter((e): e is JerseyEventTag => e !== null)
    .sort((a, b) => (a.startsOn ?? '9999').localeCompare(b.startsOn ?? '9999'));
}

function mapTargetAndLocation(row: any) {
  return {
    league: row.league ?? null,
    teamId: row.team_id ?? null,
    teamName: row.team_name ?? null,
    teamLogoUrl: row.team_logo_url ?? null,
    leagueName: row.league_name ?? null,
    playerName: row.player_name ?? null,
    year: row.year != null ? Number(row.year) : null,
    city: row.city ?? null,
    state: row.state ?? null,
    country: row.country ?? null,
  };
}

export interface BrowseFilters {
  /** Free-text across title / team / player / league. */
  q?: string;
  kind?: 'trade' | 'sell';
  state?: string;
  country?: string;
  /** Only listings tagged to this USAU event. */
  usauEventId?: string;
  limit?: number;
}

// Search text goes into a raw PostgREST .or() string, where , . : ( ) are
// filter grammar, so typed text could add filter clauses. A double-quoted
// value (with " and \ escaped) is always read as a value.
function ilikeAny(columns: string[], text: string): string {
  const value = `"%${text.replace(/["\\]/g, '\\$&')}%"`;
  return columns.map((c) => `${c}.ilike.${value}`).join(',');
}

export async function listJerseyListings(filters: BrowseFilters = {}): Promise<JerseyListing[]> {
  const supabase = createClient() as any;
  const bucket = supabase.storage.from(STORAGE_BUCKET);
  const publicUrlFor = (p: string) => bucket.getPublicUrl(p).data.publicUrl as string;

  let query = supabase
    .from('jersey_listings')
    .select(LISTING_COLS)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(Math.min(filters.limit ?? 60, 200));

  if (filters.kind === 'trade') query = query.in('kind', ['trade', 'both']);
  if (filters.kind === 'sell') query = query.in('kind', ['sell', 'both']);
  if (filters.state) query = query.eq('state', filters.state);
  if (filters.country) query = query.eq('country', filters.country);
  if (filters.q && filters.q.trim().length > 1) {
    query = query.or(ilikeAny(['title', 'team_name', 'player_name', 'league_name'], filters.q.trim()));
  }

  const { data, error } = await query;
  if (error) {
    console.error('[jerseys] listJerseyListings', error.message);
    return [];
  }

  let rows = (data ?? []) as any[];
  // Event filtering is done here rather than in SQL: it's a filter on an
  // embedded child, which PostgREST can't express without an inner-join hint
  // that would also drop untagged listings.
  if (filters.usauEventId) {
    rows = rows.filter((r) =>
      (r.jersey_listing_events ?? []).some((e: any) => e.usau_event_id === filters.usauEventId),
    );
  }

  return rows.map((r) => ({
    id: String(r.id),
    ownerId: String(r.owner_id),
    owner: mapPoster(r.owner),
    kind: r.kind,
    title: String(r.title),
    description: r.description ?? null,
    size: r.size ?? null,
    condition: r.condition ?? null,
    priceCents: r.price_cents != null ? Number(r.price_cents) : null,
    status: r.status,
    photos: mapPhotos(r.jersey_photos, publicUrlFor),
    events: mapEvents(r.jersey_listing_events),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    ...mapTargetAndLocation(r),
  }));
}

export async function getJerseyListing(id: string): Promise<JerseyListing | null> {
  const supabase = createClient() as any;
  const bucket = supabase.storage.from(STORAGE_BUCKET);
  const publicUrlFor = (p: string) => bucket.getPublicUrl(p).data.publicUrl as string;

  const { data, error } = await supabase
    .from('jersey_listings')
    .select(LISTING_COLS)
    .eq('id', id)
    .maybeSingle();

  if (error || !data) return null;
  const r = data as any;
  return {
    id: String(r.id),
    ownerId: String(r.owner_id),
    owner: mapPoster(r.owner),
    kind: r.kind,
    title: String(r.title),
    description: r.description ?? null,
    size: r.size ?? null,
    condition: r.condition ?? null,
    priceCents: r.price_cents != null ? Number(r.price_cents) : null,
    status: r.status,
    photos: mapPhotos(r.jersey_photos, publicUrlFor),
    events: mapEvents(r.jersey_listing_events),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    ...mapTargetAndLocation(r),
  };
}

export async function listJerseyWants(filters: BrowseFilters = {}): Promise<JerseyWant[]> {
  const supabase = createClient() as any;
  let query = supabase
    .from('jersey_wants')
    .select(WANT_COLS)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(Math.min(filters.limit ?? 60, 200));

  if (filters.state) query = query.eq('state', filters.state);
  if (filters.country) query = query.eq('country', filters.country);
  if (filters.q && filters.q.trim().length > 1) {
    query = query.or(ilikeAny(['team_name', 'player_name', 'league_name', 'note'], filters.q.trim()));
  }

  const { data, error } = await query;
  if (error) {
    console.error('[jerseys] listJerseyWants', error.message);
    return [];
  }

  return ((data ?? []) as any[]).map((r) => ({
    id: String(r.id),
    userId: String(r.user_id),
    user: mapPoster(r.user),
    size: r.size ?? null,
    note: r.note ?? null,
    status: r.status,
    events: mapEvents(r.jersey_listing_events),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    ...mapTargetAndLocation(r),
  }));
}

export async function getJerseyWant(id: string): Promise<JerseyWant | null> {
  const supabase = createClient() as any;
  const { data, error } = await supabase
    .from('jersey_wants')
    .select(WANT_COLS)
    .eq('id', id)
    .maybeSingle();

  if (error || !data) return null;
  const r = data as any;
  return {
    id: String(r.id),
    userId: String(r.user_id),
    user: mapPoster(r.user),
    size: r.size ?? null,
    note: r.note ?? null,
    status: r.status,
    events: mapEvents(r.jersey_listing_events),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    ...mapTargetAndLocation(r),
  };
}

/** Listings + wants the signed-in user posted (any status). */
export async function getMyJerseyPosts(): Promise<{ listings: JerseyListing[]; wants: JerseyWant[] }> {
  const supabase = createClient() as any;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { listings: [], wants: [] };

  const bucket = supabase.storage.from(STORAGE_BUCKET);
  const publicUrlFor = (p: string) => bucket.getPublicUrl(p).data.publicUrl as string;

  const [{ data: l }, { data: w }] = await Promise.all([
    supabase
      .from('jersey_listings')
      .select(LISTING_COLS)
      .eq('owner_id', user.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('jersey_wants')
      .select(WANT_COLS)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
  ]);

  return {
    listings: ((l ?? []) as any[]).map((r) => ({
      id: String(r.id),
      ownerId: String(r.owner_id),
      owner: mapPoster(r.owner),
      kind: r.kind,
      title: String(r.title),
      description: r.description ?? null,
      size: r.size ?? null,
      condition: r.condition ?? null,
      priceCents: r.price_cents != null ? Number(r.price_cents) : null,
      status: r.status,
      photos: mapPhotos(r.jersey_photos, publicUrlFor),
      events: mapEvents(r.jersey_listing_events),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      ...mapTargetAndLocation(r),
    })),
    wants: ((w ?? []) as any[]).map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      user: mapPoster(r.user),
      size: r.size ?? null,
      note: r.note ?? null,
      status: r.status,
      events: mapEvents(r.jersey_listing_events),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      ...mapTargetAndLocation(r),
    })),
  };
}

// ── Messaging ───────────────────────────────────────────────────────────────

/** My inbox. RLS already restricts this to threads I'm a participant in. */
export async function getMyThreads(): Promise<JerseyThread[]> {
  const supabase = createClient() as any;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('jersey_threads')
    .select(`
      id, listing_id, want_id, owner_id, requester_id, last_message_at,
      owner_last_read_at, requester_last_read_at, created_at,
      owner:profiles!jersey_threads_owner_id_fkey(${POSTER_COLS}),
      requester:profiles!jersey_threads_requester_id_fkey(${POSTER_COLS}),
      jersey_listings(title),
      jersey_wants(team_name, player_name)
    `)
    .order('last_message_at', { ascending: false, nullsFirst: false });

  if (error) {
    console.error('[jerseys] getMyThreads', error.message);
    return [];
  }

  return ((data ?? []) as any[]).map((t) => {
    const iAmOwner = String(t.owner_id) === user.id;
    const lastRead = iAmOwner ? t.owner_last_read_at : t.requester_last_read_at;
    const subject =
      t.jersey_listings?.title ??
      [t.jersey_wants?.team_name, t.jersey_wants?.player_name].filter(Boolean).join(' · ') ??
      'Jersey';
    return {
      id: String(t.id),
      listingId: t.listing_id ? String(t.listing_id) : null,
      wantId: t.want_id ? String(t.want_id) : null,
      otherParty: mapPoster(iAmOwner ? t.requester : t.owner),
      iAmOwner,
      subject: subject || 'Jersey',
      lastMessageAt: t.last_message_at ?? null,
      unread: Boolean(
        t.last_message_at && (!lastRead || new Date(t.last_message_at) > new Date(lastRead)),
      ),
      createdAt: String(t.created_at),
    };
  });
}

export async function getThreadMessages(
  threadId: string,
): Promise<{ thread: JerseyThread | null; messages: JerseyMessage[] }> {
  const supabase = createClient() as any;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { thread: null, messages: [] };

  const threads = await getMyThreads();
  const thread = threads.find((t) => t.id === threadId) ?? null;
  if (!thread) return { thread: null, messages: [] };

  const { data, error } = await supabase
    .from('jersey_messages')
    .select('id, thread_id, sender_id, body, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[jerseys] getThreadMessages', error.message);
    return { thread, messages: [] };
  }

  return {
    thread,
    messages: ((data ?? []) as any[]).map((m) => ({
      id: String(m.id),
      threadId: String(m.thread_id),
      senderId: String(m.sender_id),
      body: String(m.body),
      createdAt: String(m.created_at),
      mine: String(m.sender_id) === user.id,
    })),
  };
}

/** Unread thread count, for the nav badge. */
export async function getUnreadThreadCount(): Promise<number> {
  const threads = await getMyThreads();
  return threads.filter((t) => t.unread).length;
}

// ── Blocking ────────────────────────────────────────────────────────────────

/** User ids the signed-in user has blocked. Used to render Block/Unblock state
 *  without a client round trip. Only ever returns OUR OWN list — RLS makes it
 *  impossible to read anyone else's. */
export async function getMyBlockedIds(): Promise<Set<string>> {
  const supabase = createClient() as any;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Set();

  const { data, error } = await supabase
    .from('jersey_blocks')
    .select('blocked_id')
    .eq('blocker_id', user.id);
  if (error) return new Set();
  return new Set(((data ?? []) as any[]).map((r) => String(r.blocked_id)));
}

/** Blocked people with enough identity to render a manage-list. */
export async function getMyBlockedUsers(): Promise<
  { id: string; displayName: string | null; username: string | null; createdAt: string }[]
> {
  const supabase = createClient() as any;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('jersey_blocks')
    .select(`blocked_id, created_at, blocked:profiles!jersey_blocks_blocked_id_fkey(id, display_name, username)`)
    .eq('blocker_id', user.id)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[jerseys] getMyBlockedUsers', error.message);
    return [];
  }
  return ((data ?? []) as any[]).map((r) => ({
    id: String(r.blocked_id),
    displayName: r.blocked?.display_name ?? null,
    username: r.blocked?.username ?? null,
    createdAt: String(r.created_at),
  }));
}
