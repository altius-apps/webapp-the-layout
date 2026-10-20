'use client';

// Delete-account settings — the "danger zone" card + confirm modal.
//
// Deletion itself is done SERVER-SIDE by the `delete-account` Supabase Edge
// Function (it needs the service-role key to remove the auth user). This
// component only: (1) confirms in a modal, (2) invokes the function with the
// user's own access token, (3) on success signs out and sends the user home.
// Being signed in is the only proof asked for (Hunter, 2026-10-07 — the
// password re-auth is gone). Full data cascade (profile, favorites, fantasy
// team, playbook, uploads) is handled by the function + DB ON DELETE CASCADEs.
//
// The function's documented responses drive the UI copy:
//   200 { deleted: true }
//   401 { error: 'unauthenticated' }
//   409 { error: 'draft_in_progress', leagues: [{id,name,contestId}] }
//   409 { error: 'ownership_transfer_required', teams: [{id,name}] }
//   429 { error: 'rate_limited' }
//
// A live fantasy draft blocks deletion until it's over. Before showing the
// delete button we ask the DB (fantasy_drafts_blocking_account_deletion); the
// function's draft_in_progress 409 is the backstop for a draft that went live
// after that check. Owned leagues don't block — the DB hands each one to
// another member.

import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/lib/auth/auth-provider';
import { getDraftsBlockingAccountDeletion, type DraftBlockingDeletion } from '@/lib/fantasy/leagues';

type Phase = 'idle' | 'submitting' | 'error';
type PreflightPhase = 'checking' | 'ready' | 'error';

interface OwnedTeam {
  id: string;
  name: string;
}

export function DeleteAccountSettings() {
  const [open, setOpen] = useState(false);

  return (
    <div className="bg-surface rounded-card-lg shadow-card overflow-hidden ring-1 ring-inset ring-live/15">
      <div className="px-5 py-4 border-b border-hairline">
        <h2 className="m-0 font-tight text-[11px] font-bold tracking-[0.18em] uppercase text-live">
          Danger zone
        </h2>
        <p className="mt-1 text-[12px] text-faint font-tight leading-snug">
          Permanently delete your account and all associated data — your profile,
          favorites, fantasy team, and any playbooks you solely own. This cannot be
          undone.
        </p>
      </div>

      <div className="px-5 py-5">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={[
            'inline-flex items-center justify-center px-4 py-2.5 rounded-card-sm cursor-pointer',
            'text-[12px] font-bold tracking-[0.08em] uppercase font-tight',
            'bg-live/[0.08] text-live ring-1 ring-inset ring-live/25',
            'hover:bg-live/[0.14] transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live',
          ].join(' ')}
        >
          Delete account
        </button>
      </div>

      {open && <ConfirmDeleteModal onClose={() => setOpen(false)} />}
    </div>
  );
}

// ─── Confirm modal ──────────────────────────────────────────────────────────

function ConfirmDeleteModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { signOut } = useAuth();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [blockedTeams, setBlockedTeams] = useState<OwnedTeam[] | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Live-draft pre-flight — runs once on open, and again if the delete call
  // itself comes back 409 draft_in_progress. `ready` + an empty list means
  // nothing blocks deletion.
  const [preflight, setPreflight] = useState<PreflightPhase>('checking');
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [liveDrafts, setLiveDrafts] = useState<DraftBlockingDeletion[]>([]);
  const isClear = preflight === 'ready' && liveDrafts.length === 0;
  const hasTeamBlock = !!blockedTeams && blockedTeams.length > 0;

  const runPreflight = useCallback(() => {
    setPreflight('checking');
    setPreflightError(null);
    getDraftsBlockingAccountDeletion()
      .then((drafts) => {
        setLiveDrafts(drafts);
        setPreflight('ready');
      })
      .catch((err) => {
        setPreflight('error');
        setPreflightError(err instanceof Error ? err.message : 'Could not check your drafts.');
      });
  }, []);

  useEffect(() => {
    runPreflight();
  }, [runPreflight]);

  // Focus starts on Cancel, the safe choice in a destructive dialog.
  useEffect(() => {
    const t = setTimeout(() => cancelRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  // Close on Esc (unless mid-submit).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && phase !== 'submitting') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, phase]);

  const handleDelete = useCallback(async () => {
    if (phase === 'submitting') return;
    setPhase('submitting');
    setError(null);
    setBlockedTeams(null);

    const supabase = createClient();
    // The Edge Function reads the caller from their Bearer token — supabase-js
    // attaches the current session's access token to functions.invoke. We
    // never send a user id.
    const { data, error: invokeErr } = await supabase.functions.invoke('delete-account');

    // On a 2xx, supabase-js returns the parsed JSON in `data`. On a non-2xx it
    // returns a FunctionsHttpError in `invokeErr` whose `.context` is the raw
    // Response — our structured error body lives there, so we read both.
    const payload = (data ?? null) as
      | { deleted?: boolean; error?: string; teams?: OwnedTeam[] }
      | null;

    let code = payload?.error ?? null;
    let teams = payload?.teams ?? null;
    if (invokeErr) {
      try {
        const ctx = (invokeErr as { context?: Response }).context;
        if (ctx && typeof ctx.json === 'function') {
          const body = await ctx.json();
          code = body?.error ?? code;
          teams = body?.teams ?? teams;
        }
      } catch {
        /* fall through to generic error below */
      }
    }

    if (payload?.deleted) {
      // Success — clear the session and go home (signed-out state).
      await signOut();
      router.replace('/');
      router.refresh();
      return;
    }

    // Map the function's documented error codes to human copy.
    setPhase('error');
    switch (code) {
      case 'rate_limited':
        setError('Too many attempts. Please wait a minute and try again.');
        break;
      case 'ownership_transfer_required':
        setBlockedTeams(teams ?? []);
        setError(null);
        break;
      case 'draft_in_progress':
        // A draft went live after the pre-flight. Re-run it (the source of
        // truth) so the same "finish your draft" block shows.
        setPhase('idle');
        setError(null);
        runPreflight();
        break;
      case 'unauthenticated':
        setError('Your session expired. Please sign in again.');
        break;
      default:
        setError('Something went wrong. Please try again.');
    }
  }, [phase, signOut, router, runPreflight]);

  const showBody = !isClear || hasTeamBlock || !!error;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-account-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6 bg-black/40 backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && phase !== 'submitting') onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleDelete();
        }}
        className="w-full max-w-[440px] max-h-full overflow-y-auto bg-surface rounded-card-lg shadow-hero flex flex-col"
      >
        <div className="px-5 py-4 border-b border-hairline">
          <h2
            id="delete-account-title"
            className="font-display italic text-[24px] font-bold tracking-[-0.02em] leading-[0.95] text-live m-0"
          >
            Are you sure?
          </h2>
          <p className="mt-2 text-[12.5px] text-muted font-tight leading-snug">
            This permanently deletes your account and all its data. This can&apos;t be
            undone.
          </p>
        </div>

        {showBody && (
          <div className="px-5 py-5 flex flex-col gap-4">
            {/* Live-draft pre-flight — the delete button never renders until it clears. */}
            {preflight === 'checking' && (
              <div className="flex items-center gap-2.5 text-[12.5px] text-muted font-tight py-1">
                <span
                  className="w-3.5 h-3.5 rounded-full border-2 border-current/30 border-t-current animate-spin flex-shrink-0"
                  aria-hidden="true"
                />
                Checking your fantasy drafts…
              </div>
            )}

            {preflight === 'error' && (
              <div className="px-4 py-3 rounded-card-sm bg-live/[0.08] text-[12.5px] font-tight leading-snug">
                <p className="m-0 font-bold text-live mb-1">Couldn&apos;t check your drafts</p>
                <p className="m-0 text-muted">
                  {preflightError ?? 'Something went wrong. Please try again.'}
                </p>
                <button
                  type="button"
                  onClick={() => runPreflight()}
                  className={[
                    'mt-2.5 inline-flex items-center min-h-[44px] text-[11px] font-bold tracking-[0.08em] uppercase',
                    'text-live underline underline-offset-2 cursor-pointer',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live rounded-sm',
                  ].join(' ')}
                >
                  Try again
                </button>
              </div>
            )}

            {preflight === 'ready' && liveDrafts.length > 0 && (
              <div className="px-4 py-3 rounded-card-sm bg-live/[0.08] text-[12.5px] text-ink font-tight leading-snug">
                <p className="m-0 font-bold text-live mb-1">Finish your draft first</p>
                <p className="m-0 text-muted">
                  You have a team in a draft that&apos;s live right now. You can delete
                  your account once it&apos;s over.
                </p>
                <ul className="mt-2 mb-0 pl-4 list-disc text-ink">
                  {liveDrafts.map((d) => (
                    <li key={d.contestId}>
                      <Link
                        href={`/fantasy/l/${d.contestId}/draft`}
                        className="font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live rounded-sm"
                      >
                        {d.leagueName}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Ownership-transfer block — the one non-generic failure worth its own copy. */}
            {isClear && hasTeamBlock && (
              <div className="px-4 py-3 rounded-card-sm bg-live/[0.08] text-[12.5px] text-ink font-tight leading-snug">
                <p className="m-0 font-bold text-live mb-1">Transfer team ownership first</p>
                <p className="m-0 text-muted">
                  You own {blockedTeams!.length === 1 ? 'a team' : 'teams'} with other
                  members. Transfer ownership (or remove the other members) before
                  deleting your account:
                </p>
                <ul className="mt-2 mb-0 pl-4 list-disc text-ink">
                  {blockedTeams!.map((t) => (
                    <li key={t.id} className="font-semibold">{t.name}</li>
                  ))}
                </ul>
              </div>
            )}

            {isClear && error && (
              <p role="alert" className="m-0 text-[12px] font-medium text-live font-tight">{error}</p>
            )}
          </div>
        )}

        <div className="px-5 py-4 border-t border-hairline flex items-center justify-end gap-2.5">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={phase === 'submitting'}
            className={[
              'px-4 py-2.5 rounded-card-sm cursor-pointer text-[12px] font-bold tracking-[0.08em] uppercase font-tight',
              'text-muted hover:text-ink transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              'disabled:opacity-60',
            ].join(' ')}
          >
            Cancel
          </button>
          {/* Hide the destructive submit until drafts are clear and no
              ownership block is showing — nothing to submit until then. */}
          {isClear && !hasTeamBlock && (
            <button
              type="submit"
              disabled={phase === 'submitting'}
              className={[
                'px-4 py-2.5 rounded-card-sm cursor-pointer text-[12px] font-bold tracking-[0.08em] uppercase font-tight',
                'bg-live text-white ring-1 ring-inset ring-live',
                'hover:opacity-90 transition-opacity duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              ].join(' ')}
            >
              {phase === 'submitting' ? 'Deleting…' : 'Yes, delete my account'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
