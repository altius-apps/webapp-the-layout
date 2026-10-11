'use client';

// Required display-name step (Hunter, 2026-10-11). Two cases:
// - The name fails the app's check (same moderateName as Settings, so the
//   rules never differ): required app-wide; Sign out is the only other way out.
// - No name at all (signup no longer defaults to the email prefix): required
//   in Fantasy only, where other players see it; "Leave Fantasy" goes home.
// Not dismissible otherwise.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-provider';
import { moderateName } from '@/lib/moderation';
import { setDisplayName } from '@/lib/fantasy/data';

export default function DisplayNamePrompt() {
  const { user, refreshProfile, signOut } = useAuth();
  const pathname = usePathname();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the save lands so the dialog closes right away.
  const [savedName, setSavedName] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const current = (savedName ?? user?.profile?.display_name)?.trim() || null;
  const badName = !!current && !!moderateName(current);
  // Join/invite pages show which league it is first; the prompt follows.
  const inFantasy =
    pathname.startsWith('/fantasy') &&
    !pathname.startsWith('/fantasy/join') &&
    !pathname.startsWith('/fantasy/invite');
  const needsName = !!user?.profile && (badName || (!current && inFantasy));
  // Auth callback and password reset own the screen until they finish.
  const onAuthRoute = pathname.startsWith('/auth') || pathname.startsWith('/reset-password');
  if (!mounted || !needsName || onAuthRoute) return null;

  const trimmed = name.trim();
  const nameErr = trimmed ? moderateName(trimmed, 'Display name') : null;
  const canSave = trimmed.length >= 1 && trimmed.length <= 60 && !nameErr && !saving;

  const secondaryClass = [
    'inline-flex items-center justify-center px-3 min-h-[44px] rounded-full cursor-pointer',
    'text-[11px] font-bold tracking-[0.14em] uppercase font-tight text-muted',
    'hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
  ].join(' ');

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await setDisplayName(trimmed);
      setSavedName(trimmed);
      // The rest of the app (fantasy's auto team) waits on the new name.
      if (!(await refreshProfile())) window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your name.');
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="display-name-prompt-title"
      className="fixed inset-0 z-[110] flex items-center justify-center px-4 py-6 bg-ink/40 backdrop-blur-sm"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="w-full max-w-[420px] bg-surface rounded-card-lg shadow-hero flex flex-col"
      >
        <div className="px-6 pt-6 pb-4 flex flex-col gap-2 border-b border-hairline">
          <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-accent font-tight">
            {badName ? 'One more step' : 'Fantasy'}
          </span>
          <h2
            id="display-name-prompt-title"
            className="m-0 font-display italic text-[24px] font-bold tracking-[-0.02em] leading-[0.95] text-ink"
          >
            Choose a display name
          </h2>
          <p className="text-[13px] text-muted font-tight leading-snug m-0">
            {badName
              ? 'Your current name can’t be used. Pick the name other players will see in leagues and standings.'
              : 'Other players see this name in your leagues and standings.'}
          </p>
        </div>

        <div className="px-6 py-5">
          <label htmlFor="display-name-prompt-input" className="sr-only">
            Display name
          </label>
          <input
            id="display-name-prompt-input"
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            maxLength={60}
            placeholder="What should we call you?"
            autoComplete="name"
            autoFocus
            spellCheck={false}
            className={[
              'w-full bg-ink/5 px-3.5 py-2.5 text-[14px] font-semibold text-ink font-tight rounded-card-sm ring-1 ring-inset ring-transparent',
              'focus-visible:outline-none focus-visible:ring-2 transition-colors min-h-[44px]',
              nameErr ? 'ring-live focus-visible:ring-live' : 'focus-visible:ring-accent',
            ].join(' ')}
          />
          {(nameErr || error) && (
            <p role="alert" className="text-[11px] font-tight text-live mt-1 mb-0">
              {nameErr ?? error}
            </p>
          )}
        </div>

        <div className="px-6 py-4 border-t border-hairline flex items-center justify-between gap-3">
          {badName ? (
            <button type="button" onClick={() => void signOut()} className={secondaryClass}>
              Sign out
            </button>
          ) : (
            <Link href="/" className={secondaryClass}>
              Leave Fantasy
            </Link>
          )}
          <button
            type="submit"
            disabled={!canSave}
            className={[
              'inline-flex items-center justify-center px-6 min-h-[44px] rounded-full cursor-pointer',
              'bg-accent text-accent-ink font-tight text-[11px] font-bold tracking-[0.14em] uppercase',
              'hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            ].join(' ')}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
