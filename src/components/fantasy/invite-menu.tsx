'use client';

// InviteMenu — the commissioner's league Invite button and its mini popup:
// Email invite or Text message (Hunter, 2026-10-09). Used by the join-code row
// (pill) and the league header (icon). Email invite calls the shared
// invite-email Edge Function (Playbook and the mobile app use it too), which
// creates the tokened invite and sends it; Text message opens an sms: draft.
// Both the code RPC and the function are commissioner-only server-side.
// Without a `code` prop the join code is read when the popup first opens.
// Phones get a bottom sheet over the nav bar (an anchored popup clipped off
// the screen edge from the header icon); wider screens get the popup.

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createClient } from '@/lib/supabase/client';
import { getLeagueCode, leagueInviteText } from '@/lib/fantasy/leagues';

const MENU_ITEM_CLASS = [
  'w-full flex items-center gap-3 px-3 py-2.5 min-h-[44px] rounded-card-sm text-left',
  'font-tight text-[14px] font-semibold text-ink no-underline',
  'hover:bg-ink/5 transition-colors duration-150 cursor-pointer',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
].join(' ');

const TRIGGER_CLASS = {
  pill: [
    'inline-flex items-center justify-center gap-2 px-5 py-3 rounded-full min-h-[44px]',
    'bg-accent text-accent-ink font-tight text-[12px] font-bold tracking-[0.06em] uppercase',
    'hover:opacity-90 transition-opacity duration-150 cursor-pointer',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
  ].join(' '),
  icon: [
    'w-9 h-9 flex items-center justify-center rounded-full cursor-pointer',
    'text-ink hover:text-accent hover:bg-ink/5 transition-colors duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
  ].join(' '),
};

export function InviteMenu({
  leagueId,
  code: codeProp,
  trigger,
}: {
  leagueId: string;
  code?: string;
  trigger: 'pill' | 'icon';
}) {
  const [loadedCode, setLoadedCode] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [view, setView] = useState<'menu' | 'email'>('menu');
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const firstItemRef = useRef<HTMLElement | null>(null);
  const emailId = useId();

  const code = codeProp ?? loadedCode;

  useEffect(() => {
    if (!open || codeProp !== undefined || loadedCode) return;
    let cancelled = false;
    getLeagueCode(leagueId)
      .then((c) => !cancelled && setLoadedCode(c))
      .catch((err) => !cancelled && setCodeError(err instanceof Error ? err.message : 'Could not load the join code.'));
    return () => {
      cancelled = true;
    };
  }, [open, codeProp, loadedCode, leagueId]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setView('menu');
    setSendResult(null);
    setCodeError(null);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    if (view === 'menu') firstItemRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !panelRef.current?.contains(t)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, view, code]);

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setSending(true);
    setSendResult(null);
    const { error } = await createClient().functions.invoke('invite-email', {
      body: { kind: 'fantasy', leagueId, email: trimmed },
    });
    if (error) {
      // 4xx bodies carry curated copy ({ error }); anything else stays generic.
      const res = (error as { context?: Response }).context;
      const body = res && res.status < 500 ? await res.json().catch(() => null) : null;
      setSendResult({ ok: false, message: body?.error ?? 'Could not send the invite.' });
    } else {
      setSendResult({ ok: true, message: `Invite sent to ${trimmed}.` });
      setEmail('');
    }
    setSending(false);
  };

  const setFirstItem = (el: HTMLElement | null) => {
    firstItemRef.current = el;
  };

  const panel = (
    <>
      {!code ? (
        <p role={codeError ? 'alert' : 'status'} className={`m-0 p-3 font-tight text-[13px] ${codeError ? 'text-live' : 'text-muted'}`}>
          {codeError ?? 'Loading…'}
        </p>
      ) : view === 'menu' ? (
        <div role="menu" aria-label="Invite to this league">
          <button ref={setFirstItem} type="button" role="menuitem" onClick={() => setView('email')} className={MENU_ITEM_CLASS}>
            <MailGlyph />
            Email invite
          </button>
          <a
            role="menuitem"
            href={`sms:?&body=${encodeURIComponent(leagueInviteText(code))}`}
            onClick={() => close(false)}
            className={MENU_ITEM_CLASS}
          >
            <TextGlyph />
            Text message
          </a>
        </div>
      ) : (
        <form onSubmit={handleSendInvite} className="p-2 space-y-2.5">
          <label
            htmlFor={emailId}
            className="block text-[10.5px] font-bold tracking-[0.14em] uppercase text-faint font-tight"
          >
            Invite by email
          </label>
          <input
            id={emailId}
            type="email"
            value={email}
            autoFocus
            onChange={(e) => {
              setEmail(e.target.value);
              setSendResult(null);
            }}
            placeholder="friend@example.com"
            className={[
              'w-full px-3.5 py-2.5 rounded-card-sm bg-ink/5 min-h-[44px]',
              'font-tight text-[14px] text-ink placeholder:text-faint',
              'focus:outline-none focus:ring-2 focus:ring-accent',
            ].join(' ')}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setView('menu');
                setSendResult(null);
              }}
              className={[
                'flex-1 inline-flex items-center justify-center min-h-[44px] rounded-full',
                'bg-ink/5 text-ink font-tight text-[12px] font-bold tracking-[0.06em] uppercase',
                'hover:bg-ink/10 transition-colors duration-150 cursor-pointer',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              ].join(' ')}
            >
              Back
            </button>
            <button
              type="submit"
              disabled={sending || !email.trim()}
              className={[
                'flex-1 inline-flex items-center justify-center min-h-[44px] rounded-full',
                'font-tight text-[12px] font-bold tracking-[0.06em] uppercase transition-colors duration-150',
                sending || !email.trim()
                  ? 'bg-ink/[0.08] text-faint cursor-not-allowed'
                  : 'bg-accent text-accent-ink hover:opacity-90 cursor-pointer',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              ].join(' ')}
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
          {sendResult && (
            <p
              role={sendResult.ok ? 'status' : 'alert'}
              className={`m-0 font-tight text-[12px] ${sendResult.ok ? 'text-ink' : 'text-live'}`}
            >
              {sendResult.message}
            </p>
          )}
        </form>
      )}
    </>
  );

  return (
    <div ref={wrapRef} className="relative flex-shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (open) return close(false);
          setSheet(window.matchMedia('(max-width: 639px)').matches);
          setOpen(true);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={trigger === 'icon' ? 'Invite to this league' : undefined}
        className={TRIGGER_CLASS[trigger]}
      >
        {trigger === 'pill' ? (
          'Invite'
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M15 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM19 8v6M16 11h6"
              stroke="currentColor"
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>

      {open &&
        (sheet
          ? createPortal(
              <div className="fixed inset-0 z-[100] flex items-end bg-black/40">
                <div
                  ref={panelRef}
                  className="w-full bg-surface rounded-t-card-lg shadow-hero p-3 pb-[max(env(safe-area-inset-bottom),12px)]"
                >
                  {panel}
                </div>
              </div>,
              document.body,
            )
          : (
              <div
                ref={panelRef}
                className="absolute right-0 top-full mt-2 z-30 w-72 bg-surface rounded-card-lg shadow-hero p-2"
              >
                {panel}
              </div>
            ))}
    </div>
  );
}

function MailGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="flex-shrink-0 text-muted">
      <rect x="2.5" y="4.5" width="15" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 5.5l7 5 7-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TextGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="flex-shrink-0 text-muted">
      <path
        d="M4.5 3.5h11a2 2 0 012 2v6.5a2 2 0 01-2 2H9l-3.5 3v-3h-1a2 2 0 01-2-2V5.5a2 2 0 012-2z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
