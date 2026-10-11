'use client';

// Jersey marketplace — client-side mutations.
//
// Convention (matches src/lib/feedback/data.ts): every function returns
// `string | null` — an error MESSAGE to show the user, or null on success.
// These never throw, so callers don't need try/catch around each one.
//
// MODERATION: we call moderateText() here for fast feedback, but unlike the
// rest of the app that is NOT the only guard — jersey text also passes a
// database trigger (ugc_text_is_clean), so a raw REST POST can't bypass it.
// Both let real player names through ("Evan Coon"), checked against our data,
// except in team/league names.
// The client list is broader; the DB list is the floor. See
// 20260802160000_jersey_listings_core.sql.

import { createClient } from '@/lib/supabase/client';
import { moderateName } from '@/lib/moderation';
import { moderateText } from '@/lib/moderation-players';
import {
  STORAGE_BUCKET,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  ALLOWED_PHOTO_MIME,
  PHOTO_MAX_EDGE,
  MAX_TITLE,
  MAX_DESCRIPTION,
} from './types';
import type { JerseyKind, JerseyCondition, ReportReason } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ListingDraft {
  kind: JerseyKind;
  title: string;
  description?: string | null;
  size?: string | null;
  condition?: JerseyCondition | null;
  priceCents?: number | null;
  league?: string | null;
  teamId?: string | null;
  teamName?: string | null;
  teamLogoUrl?: string | null;
  leagueName?: string | null;
  playerName?: string | null;
  year?: number | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  /** Event tags: either a real USAU event id, or a free-text name (+ date). */
  events?: { usauEventId?: string | null; name?: string | null; startsOn?: string | null }[];
}

function cleanText(v: string | null | undefined, max: number): string | null {
  if (!v) return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

// Team and league names are the user's own text, so they get no real-player
// exemption (same as the DB triggers).
function moderateField(value: string, label: string): Promise<string | null> {
  return label === 'Team' || label === 'League'
    ? Promise.resolve(moderateName(value, label))
    : moderateText(value, label);
}

/** Runs the client profanity filter over every free-text field a draft carries. */
async function moderateDraft(d: ListingDraft): Promise<string | null> {
  const checks: [string | null | undefined, string][] = [
    [d.title, 'Title'],
    [d.description, 'Description'],
    [d.teamName, 'Team'],
    [d.leagueName, 'League'],
    [d.playerName, 'Player'],
  ];
  for (const [value, label] of checks) {
    if (value) {
      const err = await moderateField(value, label);
      if (err) return err;
    }
  }
  for (const e of d.events ?? []) {
    if (e.name) {
      const err = await moderateText(e.name, 'Event');
      if (err) return err;
    }
  }
  return null;
}

export async function createListing(
  draft: ListingDraft,
): Promise<{ error: string | null; id: string | null }> {
  const title = cleanText(draft.title, MAX_TITLE);
  if (!title || title.length < 3) return { error: 'Give your listing a title.', id: null };

  const profanity = await moderateDraft(draft);
  if (profanity) return { error: profanity, id: null };

  const db = createClient() as any;
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: 'Sign in to post a listing.', id: null };

  const { data, error } = await db
    .from('jersey_listings')
    .insert({
      owner_id: user.id,
      kind: draft.kind,
      title,
      description: cleanText(draft.description, MAX_DESCRIPTION),
      size: cleanText(draft.size, 20),
      condition: draft.condition ?? null,
      price_cents: draft.priceCents ?? null,
      league: draft.league ?? null,
      team_id: draft.teamId ?? null,
      team_name: cleanText(draft.teamName, 120),
      team_logo_url: draft.teamLogoUrl ?? null,
      league_name: cleanText(draft.leagueName, 80),
      player_name: cleanText(draft.playerName, 120),
      year: draft.year ?? null,
      city: cleanText(draft.city, 100),
      state: cleanText(draft.state, 60),
      country: cleanText(draft.country, 60),
    })
    .select('id')
    .single();

  if (error) return { error: friendlyError(error.message), id: null };
  const id = String(data.id);

  const tagError = await replaceEventTags({ listingId: id, events: draft.events ?? [] });
  if (tagError) return { error: tagError, id };

  return { error: null, id };
}

export async function updateListing(id: string, draft: ListingDraft): Promise<string | null> {
  const title = cleanText(draft.title, MAX_TITLE);
  if (!title || title.length < 3) return 'Give your listing a title.';

  const profanity = await moderateDraft(draft);
  if (profanity) return profanity;

  const db = createClient() as any;
  const { error } = await db
    .from('jersey_listings')
    .update({
      kind: draft.kind,
      title,
      description: cleanText(draft.description, MAX_DESCRIPTION),
      size: cleanText(draft.size, 20),
      condition: draft.condition ?? null,
      price_cents: draft.priceCents ?? null,
      league: draft.league ?? null,
      team_id: draft.teamId ?? null,
      team_name: cleanText(draft.teamName, 120),
      team_logo_url: draft.teamLogoUrl ?? null,
      league_name: cleanText(draft.leagueName, 80),
      player_name: cleanText(draft.playerName, 120),
      year: draft.year ?? null,
      city: cleanText(draft.city, 100),
      state: cleanText(draft.state, 60),
      country: cleanText(draft.country, 60),
    })
    .eq('id', id);

  if (error) return friendlyError(error.message);
  return replaceEventTags({ listingId: id, events: draft.events ?? [] });
}

/** Mark a listing sold/traded or pull it down. Both are user-driven — there is
 *  no admin approval state in this feature. */
export async function setListingStatus(
  id: string,
  status: 'active' | 'completed' | 'withdrawn',
): Promise<string | null> {
  const db = createClient() as any;
  const { error } = await db.from('jersey_listings').update({ status }).eq('id', id);
  return error ? friendlyError(error.message) : null;
}

export async function deleteListing(id: string): Promise<string | null> {
  const db = createClient() as any;
  // Photos cascade in the DB; also clear the storage objects so the bucket
  // doesn't accumulate orphans.
  const { data: photos } = await db
    .from('jersey_photos')
    .select('storage_path')
    .eq('listing_id', id);
  const paths = ((photos ?? []) as any[]).map((p) => String(p.storage_path));

  const { error } = await db.from('jersey_listings').delete().eq('id', id);
  if (error) return friendlyError(error.message);

  if (paths.length > 0) {
    await db.storage.from(STORAGE_BUCKET).remove(paths).catch(() => {});
  }
  return null;
}

// ── Wants ───────────────────────────────────────────────────────────────────

export interface WantDraft {
  league?: string | null;
  teamId?: string | null;
  teamName?: string | null;
  teamLogoUrl?: string | null;
  leagueName?: string | null;
  playerName?: string | null;
  year?: number | null;
  size?: string | null;
  note?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  events?: { usauEventId?: string | null; name?: string | null; startsOn?: string | null }[];
}

export async function createWant(
  draft: WantDraft,
): Promise<{ error: string | null; id: string | null }> {
  const hasTarget =
    draft.teamId || draft.teamName || draft.playerName || draft.year || draft.leagueName;
  if (!hasTarget) {
    return { error: 'Say what you’re looking for — a team, player, league, or year.', id: null };
  }

  for (const [v, label] of [
    [draft.note, 'Note'],
    [draft.teamName, 'Team'],
    [draft.leagueName, 'League'],
    [draft.playerName, 'Player'],
  ] as [string | null | undefined, string][]) {
    if (v) {
      const err = await moderateField(v, label);
      if (err) return { error: err, id: null };
    }
  }

  const db = createClient() as any;
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: 'Sign in to post what you’re looking for.', id: null };

  const { data, error } = await db
    .from('jersey_wants')
    .insert({
      user_id: user.id,
      league: draft.league ?? null,
      team_id: draft.teamId ?? null,
      team_name: cleanText(draft.teamName, 120),
      team_logo_url: draft.teamLogoUrl ?? null,
      league_name: cleanText(draft.leagueName, 80),
      player_name: cleanText(draft.playerName, 120),
      year: draft.year ?? null,
      size: cleanText(draft.size, 20),
      note: cleanText(draft.note, MAX_DESCRIPTION),
      city: cleanText(draft.city, 100),
      state: cleanText(draft.state, 60),
      country: cleanText(draft.country, 60),
    })
    .select('id')
    .single();

  if (error) return { error: friendlyError(error.message), id: null };
  const id = String(data.id);
  const tagError = await replaceEventTags({ wantId: id, events: draft.events ?? [] });
  return { error: tagError, id };
}

export async function updateWant(id: string, draft: WantDraft): Promise<string | null> {
  const hasTarget =
    draft.teamId || draft.teamName || draft.playerName || draft.year || draft.leagueName;
  if (!hasTarget) {
    return 'Say what you’re looking for — a team, player, league, or year.';
  }

  for (const [v, label] of [
    [draft.note, 'Note'],
    [draft.teamName, 'Team'],
    [draft.leagueName, 'League'],
    [draft.playerName, 'Player'],
  ] as [string | null | undefined, string][]) {
    if (v) {
      const err = await moderateField(v, label);
      if (err) return err;
    }
  }

  const db = createClient() as any;
  const { error } = await db
    .from('jersey_wants')
    .update({
      league: draft.league ?? null,
      team_id: draft.teamId ?? null,
      team_name: cleanText(draft.teamName, 120),
      team_logo_url: draft.teamLogoUrl ?? null,
      league_name: cleanText(draft.leagueName, 80),
      player_name: cleanText(draft.playerName, 120),
      year: draft.year ?? null,
      size: cleanText(draft.size, 20),
      note: cleanText(draft.note, MAX_DESCRIPTION),
      city: cleanText(draft.city, 100),
      state: cleanText(draft.state, 60),
      country: cleanText(draft.country, 60),
    })
    .eq('id', id);

  if (error) return friendlyError(error.message);
  return replaceEventTags({ wantId: id, events: draft.events ?? [] });
}

export async function setWantStatus(
  id: string,
  status: 'active' | 'completed' | 'withdrawn',
): Promise<string | null> {
  const db = createClient() as any;
  const { error } = await db.from('jersey_wants').update({ status }).eq('id', id);
  return error ? friendlyError(error.message) : null;
}

export async function deleteWant(id: string): Promise<string | null> {
  const db = createClient() as any;
  const { error } = await db.from('jersey_wants').delete().eq('id', id);
  return error ? friendlyError(error.message) : null;
}

// ── Event tags ──────────────────────────────────────────────────────────────

/** Replace all event tags for a listing OR want. Simplest correct approach for
 *  a handful of tags — delete then insert, rather than diffing. */
async function replaceEventTags(args: {
  listingId?: string;
  wantId?: string;
  events: { usauEventId?: string | null; name?: string | null; startsOn?: string | null }[];
}): Promise<string | null> {
  const db = createClient() as any;
  const col = args.listingId ? 'listing_id' : 'want_id';
  const parentId = args.listingId ?? args.wantId;
  if (!parentId) return null;

  await db.from('jersey_listing_events').delete().eq(col, parentId);

  type TagRow = {
    listing_id?: string;
    want_id?: string;
    usau_event_id: string | null;
    event_name: string | null;
    event_starts_on: string | null;
  };

  const rows = args.events
    .map((e): TagRow | null => {
      const name = cleanText(e.name, 160);
      if (!e.usauEventId && !name) return null;
      return {
        [col]: parentId,
        usau_event_id: e.usauEventId ?? null,
        // When a real event is linked, its name comes from usau_events on read.
        event_name: e.usauEventId ? null : name,
        event_starts_on: e.usauEventId ? null : (e.startsOn ?? null),
      } as TagRow;
    })
    .filter((r): r is TagRow => r !== null);

  if (rows.length === 0) return null;
  const { error } = await db.from('jersey_listing_events').insert(rows);
  return error ? friendlyError(error.message) : null;
}

// ── Photos ──────────────────────────────────────────────────────────────────

/**
 * Resize + upload one photo, then record it. Object path is
 * `{uid}/{listingId}/{uuid}.webp` — the first segment MUST be the uid or the
 * storage policy rejects it.
 *
 * We resize on the CLIENT and serve plain /object/ URLs: Supabase image
 * transforms are metered and we blew that quota once already.
 */
export async function uploadListingPhoto(
  listingId: string,
  file: File,
  sortOrder: number,
): Promise<string | null> {
  if (!ALLOWED_PHOTO_MIME.includes(file.type as (typeof ALLOWED_PHOTO_MIME)[number])) {
    return 'Photos must be JPEG, PNG, or WebP.';
  }
  if (file.size > MAX_PHOTO_BYTES) return 'That photo is over 5 MB.';

  const db = createClient() as any;
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return 'Sign in to add photos.';

  const { count } = await db
    .from('jersey_photos')
    .select('id', { count: 'exact', head: true })
    .eq('listing_id', listingId);
  if ((count ?? 0) >= MAX_PHOTOS) return `Up to ${MAX_PHOTOS} photos per listing.`;

  let blob: Blob;
  try {
    blob = await resizeImage(file, PHOTO_MAX_EDGE);
  } catch {
    blob = file; // resize is an optimization, not a requirement
  }

  const objectPath = `${user.id}/${listingId}/${crypto.randomUUID()}.webp`;
  const { error: upErr } = await db.storage
    .from(STORAGE_BUCKET)
    .upload(objectPath, blob, { cacheControl: '3600', contentType: 'image/webp' });
  if (upErr) return upErr.message;

  const { error } = await db
    .from('jersey_photos')
    .insert({ listing_id: listingId, storage_path: objectPath, sort_order: sortOrder });

  if (error) {
    // Roll back the object so a failed insert doesn't orphan it.
    await db.storage.from(STORAGE_BUCKET).remove([objectPath]).catch(() => {});
    return friendlyError(error.message);
  }
  return null;
}

export async function deleteListingPhoto(photoId: string, storagePath: string): Promise<string | null> {
  const db = createClient() as any;
  const { error } = await db.from('jersey_photos').delete().eq('id', photoId);
  if (error) return friendlyError(error.message);
  await db.storage.from(STORAGE_BUCKET).remove([storagePath]).catch(() => {});
  return null;
}

/** Canvas downscale to WEBP. Mirrors avatar-upload-modal.tsx's approach. */
async function resizeImage(file: File, maxEdge: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/webp', 0.85),
  );
}

// ── Reports ─────────────────────────────────────────────────────────────────

export async function reportContent(args: {
  listingId?: string;
  wantId?: string;
  threadId?: string;
  reportedUserId?: string | null;
  reason: ReportReason;
  detail?: string | null;
}): Promise<string | null> {
  const db = createClient() as any;
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return 'Sign in to report.';

  const { error } = await db.from('jersey_reports').insert({
    reporter_id: user.id,
    listing_id: args.listingId ?? null,
    want_id: args.wantId ?? null,
    thread_id: args.threadId ?? null,
    reported_user_id: args.reportedUserId ?? null,
    reason: args.reason,
    detail: cleanText(args.detail, 2000),
    status: 'new',
  });

  if (error) {
    if (/duplicate key/i.test(error.message)) return 'You already reported this. Thanks — we’ll look at it.';
    return friendlyError(error.message);
  }
  return null;
}

/** Turn Postgres constraint noise into something a person can act on. */
function friendlyError(msg: string): string {
  if (/jersey_listings_cap|20 active listings/i.test(msg)) {
    return 'You already have 20 active listings. Close one first.';
  }
  if (/20 active wanted/i.test(msg)) return 'You already have 20 active wanted posts.';
  if (/isn.t allowed/i.test(msg)) return 'That text isn’t allowed. Please reword it.';
  if (/row-level security/i.test(msg)) return 'You can’t edit that.';
  if (/jersey_wants_has_a_target/i.test(msg)) {
    return 'Say what you’re looking for — a team, player, league, or year.';
  }
  return msg;
}

// ── Blocking ────────────────────────────────────────────────────────────────
//
// Enforced in the DATABASE (policies + a message trigger), not just here — a
// blocked user can't reach you via raw REST either. These are just the client
// entry points. See 20260802170000_jersey_blocks.sql.
//
// Effect is symmetric: blocking someone hides both directions and stops
// messages both ways. Existing threads stay readable (evidence survives) but
// go read-only. The blocked person is never told.

export async function blockUser(userId: string, reason?: string | null): Promise<string | null> {
  const db = createClient() as any;
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return 'Sign in first.';
  if (user.id === userId) return 'You can’t block yourself.';

  const { error } = await db
    .from('jersey_blocks')
    .insert({ blocker_id: user.id, blocked_id: userId, reason: cleanText(reason, 200) });
  if (error) {
    if (/duplicate key/i.test(error.message)) return null; // already blocked — idempotent
    return friendlyError(error.message);
  }
  return null;
}

export async function unblockUser(userId: string): Promise<string | null> {
  const db = createClient() as any;
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return 'Sign in first.';
  const { error } = await db
    .from('jersey_blocks')
    .delete()
    .eq('blocker_id', user.id)
    .eq('blocked_id', userId);
  return error ? friendlyError(error.message) : null;
}

/** Is this person blocked by me? (Only ever answers about MY own list.) */
export async function isBlockedByMe(userId: string): Promise<boolean> {
  const db = createClient() as any;
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return false;
  const { data } = await db
    .from('jersey_blocks')
    .select('blocked_id')
    .eq('blocker_id', user.id)
    .eq('blocked_id', userId)
    .maybeSingle();
  return Boolean(data);
}
