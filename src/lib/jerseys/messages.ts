'use client';

// Jersey marketplace — messaging mutations.
//
// Threads are SCOPED: one per (listing, requester). Opening a conversation
// twice returns the existing thread rather than fragmenting the history, which
// is why openThread() looks before it inserts.
//
// You cannot cold-DM anyone: RLS requires the thread's owner_id to genuinely
// match the parent listing/want's poster, and the parent must be active.

import { createClient } from '@/lib/supabase/client';
import { moderateText } from '@/lib/moderation-players';
import { MAX_MESSAGE } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Get or create the thread between the signed-in user and a listing's owner.
 * Returns the thread id, or an error message.
 */
export async function openThread(args: {
  listingId?: string;
  wantId?: string;
  ownerId: string;
}): Promise<{ error: string | null; threadId: string | null }> {
  const db = createClient() as any;
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: 'Sign in to send a message.', threadId: null };
  if (user.id === args.ownerId) {
    return { error: 'That’s your own post.', threadId: null };
  }

  const col = args.listingId ? 'listing_id' : 'want_id';
  const parentId = args.listingId ?? args.wantId;
  if (!parentId) return { error: 'Nothing to message about.', threadId: null };

  // Reuse an existing conversation if there is one.
  const { data: existing } = await db
    .from('jersey_threads')
    .select('id')
    .eq(col, parentId)
    .eq('requester_id', user.id)
    .maybeSingle();
  if (existing) return { error: null, threadId: String(existing.id) };

  const { data, error } = await db
    .from('jersey_threads')
    .insert({
      listing_id: args.listingId ?? null,
      want_id: args.wantId ?? null,
      owner_id: args.ownerId,
      requester_id: user.id,
    })
    .select('id')
    .single();

  if (error) {
    if (/row-level security/i.test(error.message)) {
      return { error: 'That post is no longer available.', threadId: null };
    }
    return { error: error.message, threadId: null };
  }
  return { error: null, threadId: String(data.id) };
}

export async function sendMessage(threadId: string, body: string): Promise<string | null> {
  const text = body.trim().slice(0, MAX_MESSAGE);
  if (!text) return null;

  const profanity = await moderateText(text, 'Message');
  if (profanity) return profanity;

  const db = createClient() as any;
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return 'Sign in to send a message.';

  const { error } = await db
    .from('jersey_messages')
    .insert({ thread_id: threadId, sender_id: user.id, body: text });

  if (error) {
    if (/Too many messages/i.test(error.message)) {
      return 'Too many messages in the last hour. Try again shortly.';
    }
    if (/isn.t allowed/i.test(error.message)) {
      return 'That message isn’t allowed. Please reword it.';
    }
    if (/row-level security/i.test(error.message)) return 'You’re not part of this conversation.';
    return error.message;
  }
  return null;
}

/** Mark the thread read up to now, for whichever side we are. */
export async function markThreadRead(threadId: string): Promise<void> {
  const db = createClient() as any;
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return;

  const { data: t } = await db
    .from('jersey_threads')
    .select('owner_id, requester_id')
    .eq('id', threadId)
    .maybeSingle();
  if (!t) return;

  const column = String(t.owner_id) === user.id ? 'owner_last_read_at' : 'requester_last_read_at';
  // A thread's other columns are immutable from the client (guarded by a
  // trigger) — only these read receipts can move.
  await db
    .from('jersey_threads')
    .update({ [column]: new Date().toISOString() })
    .eq('id', threadId);
}

/** Live updates for an open thread. Returns an unsubscribe fn.
 *
 * The channel name is made UNIQUE per call. supabase-js caches channels by
 * name, so a fixed name meant a remount (React StrictMode double-invokes
 * effects) got the already-subscribed instance back, and `.on()` after
 * `subscribe()` throws — which unwound the whole page into the error boundary.
 */
export function subscribeToThread(threadId: string, onMessage: () => void): () => void {
  const db = createClient() as any;
  const channel = db
    .channel(`jersey_thread_${threadId}_${Math.random().toString(36).slice(2)}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'jersey_messages', filter: `thread_id=eq.${threadId}` },
      () => onMessage(),
    )
    .subscribe();
  return () => {
    db.removeChannel(channel);
  };
}
