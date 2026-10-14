'use client';

// LeagueFeed — the feed route's body (app/fantasy/l/[contestId]/feed).
// Merged system activity + member chat, newest-first top-to-bottom (a normal
// scrolling div, not an inverted list — the web has no bottom-pinned keyboard
// to design around). Composer pinned above the timeline for signed-in
// members; realtime subscription + cleanup on unmount, no poll fallback (no
// AppState-equivalent backgrounding to guard against on web).
//
// Web port of the mobile app's LeagueFeed.tsx + FeedRow.tsx
// (altiusapps/mobileapp-thelayout · src/components/fantasy/).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth/auth-provider';
import { AuthModal } from '@/components/auth/auth-modal';
import { BlurredText } from '@/components/fantasy/blurred-text';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  getLeagueActivity,
  getLeagueMessages,
  sendLeagueMessage,
  deleteLeagueMessage,
  mergeFeed,
  activityText,
  subscribeLeagueFeed,
  unsubscribeLeagueFeed,
  type ActivityItem,
  type LeagueMessage,
} from '@/lib/fantasy/feed';
import { getLeagueMembers, getMyLeagueRole, type ContestView, type LeagueMember } from '@/lib/fantasy/leagues';

const ACTIVITY_LIMIT = 50;
const MAX_LEN = 500;

function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function activityHref(item: ActivityItem, contestId: string): string | null {
  if (item.kind.startsWith('draft_')) return `/fantasy/l/${contestId}/draft`;
  if (item.kind === 'matchup_final') return `/fantasy/l/${contestId}`;
  return null;
}

interface Props {
  contest: ContestView;
  outlined?: boolean;
  isOfficial?: boolean;
}

export function LeagueFeed({ contest, outlined = false, isOfficial = false }: Props) {
  // In the draft room's white sheet, cards are outlined instead of shadowed.
  const card = outlined ? 'bg-surface rounded-card-lg border border-hairline' : 'bg-surface rounded-card-lg shadow-card';
  const { user } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);

  const leagueId = contest.leagueId;

  const [role, setRole] = useState<string | null>(null);
  const isMember = role != null;
  const isCommissioner = role === 'commissioner';

  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [messages, setMessages] = useState<LeagueMessage[]>([]);
  const [members, setMembers] = useState<LeagueMember[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(() => {
    Promise.all([
      getLeagueActivity(leagueId, ACTIVITY_LIMIT).catch(() => []),
      user ? getLeagueMessages(leagueId).catch(() => []) : Promise.resolve([]),
    ]).then(([a, m]) => {
      setActivity(a);
      setMessages(m);
    });
  }, [leagueId, user]);

  useEffect(() => {
    if (!user) {
      setRole(null);
      return;
    }
    let cancelled = false;
    getMyLeagueRole(leagueId)
      .then((r) => !cancelled && setRole(r))
      .catch(() => !cancelled && setRole(null));
    return () => {
      cancelled = true;
    };
  }, [user, leagueId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getLeagueActivity(leagueId, ACTIVITY_LIMIT).catch(() => []),
      user ? getLeagueMessages(leagueId).catch(() => []) : Promise.resolve([]),
      // An official league can have thousands of members — never list them all.
      isOfficial ? Promise.resolve([]) : getLeagueMembers(leagueId).catch(() => []),
    ]).then(([a, m, mem]) => {
      if (cancelled) return;
      setActivity(a);
      setMessages(m);
      setMembers(mem);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [leagueId, user, isOfficial]);

  useEffect(() => {
    if (!leagueId) return;
    // An official league can have thousands of viewers: fold a burst of
    // realtime events into one refetch per 5 s per viewer.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = isOfficial
      ? () => {
          timer ??= setTimeout(() => {
            timer = null;
            refetch();
          }, 5000);
        }
      : refetch;
    const channel = subscribeLeagueFeed(leagueId, onChange);
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribeLeagueFeed(channel);
    };
  }, [leagueId, refetch, isOfficial]);

  // Official leagues: names for the people in the chat only, never the whole
  // league. Each id is asked for once (a member who left is never found).
  const askedNames = useRef(new Set<string>());
  useEffect(() => {
    if (!isOfficial) return;
    const missing = [...new Set(messages.map((m) => m.userId))].filter((id) => !askedNames.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) askedNames.current.add(id);
    // Not cancelled on re-run: a newer message batch mustn't drop these names.
    getLeagueMembers(leagueId, missing)
      .then((found) => setMembers((prev) => [...prev, ...found]))
      .catch(() => {});
  }, [isOfficial, leagueId, messages]);

  const nameByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) map.set(m.userId, m.displayName ?? m.username ?? 'Member');
    return map;
  }, [members]);

  const entries = useMemo(() => mergeFeed(activity, messages), [activity, messages]);

  // ── Composer ─────────────────────────────────────────────────────────────
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const canSend = isMember && draft.trim().length > 0 && !sending;

  const handleSend = useCallback(async () => {
    if (!user) {
      setAuthOpen(true);
      return;
    }
    if (!canSend) return;
    const body = draft.trim();
    setSending(true);
    setSendError(null);
    try {
      await sendLeagueMessage(leagueId, body);
      setDraft('');
      refetch();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not send that message.');
    } finally {
      setSending(false);
    }
  }, [user, canSend, draft, leagueId, refetch]);

  // ── Delete confirm ───────────────────────────────────────────────────────
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDeleteMessage = useCallback(async () => {
    if (pendingDeleteId == null) return;
    setDeleting(true);
    try {
      await deleteLeagueMessage(pendingDeleteId);
      refetch();
    } catch {
      // Silent — RLS no-op or transient; feed will just show it still.
    } finally {
      setDeleting(false);
      setPendingDeleteId(null);
    }
  }, [pendingDeleteId, refetch]);

  return (
    <>
    <div className="space-y-4">
      {isMember ? (
        <div className={`${card} p-4`}>
          {sendError && (
            <p className="text-[12px] text-accent font-tight mb-2" role="alert">
              {sendError}
            </p>
          )}
          <div className="flex items-end gap-2.5">
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setSendError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Message the league"
              maxLength={MAX_LEN}
              rows={1}
              aria-label="Message the league"
              className="flex-1 min-h-[44px] max-h-[120px] px-4 py-3 rounded-card bg-bg text-[14px] text-ink font-tight placeholder:text-faint resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={!canSend}
              aria-label="Send message"
              className="flex-shrink-0 w-11 h-11 rounded-full flex items-center justify-center bg-accent text-accent-ink disabled:opacity-30 hover:opacity-90 transition-opacity duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 12l16-8-6 16-2.5-6L4 12z" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
      ) : (
        <div className={`${card} p-4 flex items-center justify-between gap-4`}>
          <p className="text-muted font-tight text-[13px]">
            {user ? 'Join the league to chat.' : 'Sign in and join the league to chat.'}
          </p>
          {!user && (
            <button
              type="button"
              onClick={() => setAuthOpen(true)}
              className="flex-shrink-0 px-4 py-2 rounded-full bg-accent text-accent-ink font-tight text-[12px] font-bold tracking-[0.06em] uppercase hover:opacity-90 transition-opacity duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Sign in
            </button>
          )}
        </div>
      )}

      {loading && entries.length === 0 ? (
        <div className={`${card} p-10 text-center`}>
          <div className="inline-block w-5 h-5 rounded-full border-2 border-ink/15 border-t-accent animate-spin" aria-hidden="true" />
        </div>
      ) : entries.length === 0 ? (
        <div className={`${card} p-10 text-center`}>
          <p className="text-muted font-tight text-[14px]">No activity yet — say hi to your league.</p>
        </div>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <li key={`${entry.type}:${entry.item.id}`}>
              {entry.type === 'activity' ? (
                <ActivityRow item={entry.item} contestId={contest.id} />
              ) : (
                <MessageRow
                  message={entry.item}
                  authorName={nameByUserId.get(entry.item.userId) ?? 'Member'}
                  mine={entry.item.userId === user?.id}
                  canDelete={isCommissioner || entry.item.userId === user?.id || (isOfficial && user?.isAdmin === true)}
                  onDelete={() => setPendingDeleteId(entry.item.id)}
                />
              )}
            </li>
          ))}
        </ol>
      )}
    </div>

    {/* Outside the space-y stack: its sibling margin landed on these fixed
        overlays and started the scrim 16px low. */}
    <AuthModal
      open={authOpen}
      dismissible
      headline="Sign in to chat"
      subhead="Join the conversation with your league."
      onDismiss={() => setAuthOpen(false)}
    />

    <ConfirmDialog
      open={pendingDeleteId != null}
      title="Delete message?"
      body="This removes it for everyone in the league."
      confirmLabel="Delete"
      busyLabel="Deleting…"
      busy={deleting}
      onConfirm={handleDeleteMessage}
      onCancel={() => setPendingDeleteId(null)}
    />
    </>
  );
}

function ActivityRow({ item, contestId }: { item: ActivityItem; contestId: string }) {
  const href = activityHref(item, contestId);
  const text = (
    <span className="font-tight text-[12.5px] text-faint text-center">
      <BlurredText text={activityText(item)} /> <span className="text-[11px]">· {relativeTime(item.createdAt)}</span>
    </span>
  );

  if (!href) {
    return <div className="flex items-center justify-center py-2 px-3">{text}</div>;
  }
  return (
    <Link
      href={href}
      className="flex items-center justify-center py-2 px-3 no-underline hover:opacity-80 transition-opacity duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-card-sm"
    >
      {text}
    </Link>
  );
}

function MessageRow({
  message,
  authorName,
  mine,
  canDelete,
  onDelete,
}: {
  message: { id: number; userId: string; body: string; createdAt: string };
  authorName: string;
  mine: boolean;
  canDelete: boolean;
  onDelete: () => void;
}) {
  return (
    <div className={['flex py-0.5', mine ? 'justify-end' : 'justify-start'].join(' ')}>
      <div
        className={[
          'group relative max-w-[78%] rounded-card px-3.5 py-2.5 flex flex-col gap-0.5',
          mine ? 'bg-accent/[0.12] rounded-br-md' : 'bg-surface rounded-bl-md',
        ].join(' ')}
      >
        {!mine && <span className="font-tight text-[11px] font-bold tracking-[0.02em] text-accent">{authorName}</span>}
        <span className="font-tight text-[14px] leading-snug text-ink break-words">
          <BlurredText text={message.body} />
        </span>
        <div className="flex items-center gap-2 self-end">
          <span className="font-tight text-[10px] text-faint">{relativeTime(message.createdAt)}</span>
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              aria-label="Delete message"
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-[10px] font-tight text-faint hover:text-accent transition-opacity duration-150 focus-visible:outline-none"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default LeagueFeed;
