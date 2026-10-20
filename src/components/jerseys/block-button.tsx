'use client';

// BlockButton — stop someone contacting you.
//
// Blocking is enforced in the DATABASE, so this isn't cosmetic: after this, the
// other person can't message you or see your posts, and you won't see theirs.
// They are NOT told. Existing conversation history stays readable to both sides
// (so evidence survives) but goes read-only.
//
// Distinct from Report: report escalates to an admin, block just severs contact.
// Most harassment situations want both, so the confirm copy nudges toward that.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { blockUser, unblockUser } from '@/lib/jerseys/data';

export function BlockButton({
  userId,
  displayName,
  initiallyBlocked = false,
  signedIn,
}: {
  userId: string;
  displayName: string | null;
  initiallyBlocked?: boolean;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [blocked, setBlocked] = useState(initiallyBlocked);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setBlocked(initiallyBlocked), [initiallyBlocked]);

  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirming(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirming]);

  if (!signedIn) return null;

  const who = displayName || 'this person';

  async function doBlock() {
    setBusy(true);
    setError(null);
    const err = await blockUser(userId);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setBlocked(true);
    setConfirming(false);
    router.refresh();
  }

  async function doUnblock() {
    setBusy(true);
    setError(null);
    const err = await unblockUser(userId);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setBlocked(false);
    router.refresh();
  }

  if (blocked) {
    return (
      <button
        type="button"
        onClick={doUnblock}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 min-h-[36px] rounded-full bg-ink/5 text-[11px] font-semibold text-muted hover:text-ink font-tight cursor-pointer disabled:opacity-50 motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {busy ? 'Unblocking…' : 'Unblock'}
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="inline-flex items-center gap-1.5 px-3 min-h-[36px] rounded-full text-[11px] font-semibold text-faint hover:text-ink font-tight cursor-pointer motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <BlockGlyph />
        Block
      </button>

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40 motion-safe:animate-fade-in"
            onClick={() => setConfirming(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Block ${who}`}
            className="relative z-10 w-full sm:max-w-md bg-bg rounded-t-card-lg sm:rounded-card-lg shadow-hero flex flex-col"
          >
            <div className="p-5 flex flex-col gap-3">
              <span className="font-display italic text-2xl font-bold text-ink">Block {who}?</span>
              <ul className="flex flex-col gap-1.5 text-[13px] text-muted font-tight">
                <li>· They won&rsquo;t be able to message you.</li>
                <li>· You won&rsquo;t see each other&rsquo;s listings or wants.</li>
                <li>· Your existing conversation stays visible to you, but nobody can add to it.</li>
                <li>· They aren&rsquo;t told that you blocked them.</li>
              </ul>
              <p className="text-[11.5px] text-faint font-tight">
                If they did something wrong, please report them too — blocking only affects you.
              </p>
              {error && (
                <p className="text-[12px] text-accent font-tight" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="p-4 pt-0 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="flex-1 inline-flex items-center justify-center min-h-[48px] rounded-full bg-ink/5 text-ink text-[12px] font-bold tracking-[0.06em] uppercase font-tight cursor-pointer hover:bg-ink/10"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={doBlock}
                disabled={busy}
                className="flex-1 inline-flex items-center justify-center min-h-[48px] rounded-full bg-accent text-accent-ink text-[12px] font-bold tracking-[0.06em] uppercase font-tight cursor-pointer hover:opacity-90 disabled:opacity-60"
              >
                {busy ? 'Blocking…' : 'Block'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function BlockGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.8 2.8l6.4 6.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
