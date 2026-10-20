'use client';

// Login / register modal for The Playbook.
//
// Sign-in mode: email + password.
// Sign-up mode: email, handle (@identity, required), password, confirm password
//   — with a show/hide toggle for both password fields so users can verify what
//   they typed without retyping. (Display name + phone were removed to keep the
//   form short — handle doubles as the display identity.)
//
// Visual language matches CreatePlayDialog: dark scrim, single bg-bg card,
// uppercase tracked labels, accent button.

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/lib/auth/auth-provider';
import { OAuthButtons } from '@/components/auth/oauth-buttons';
import { isUsernameAvailable, USERNAME_RE } from '@/lib/fantasy/data';
import { moderateName } from '@/lib/moderation';

type Mode = 'signin' | 'signup' | 'reset';

interface AuthModalProps {
  open: boolean;
  initialMode?: Mode;
  dismissible?: boolean;
  onDismiss?: () => void;
  /** Optional headline override — the gate uses this to explain *why* you're
   *  being asked to sign in. */
  headline?: string;
  subhead?: string;
  /** Prefill the email field (e.g. the address a team invite was sent to).
   *  Used by the invite-accept flow so new users don't retype their email. */
  initialEmail?: string;
}

export function AuthModal({
  open,
  initialMode = 'signin',
  dismissible = false,
  onDismiss,
  headline,
  subhead,
  initialEmail,
}: AuthModalProps) {
  const { user, signIn, signUp, resetPassword } = useAuth();
  const [mode, setMode] = useState<Mode>(initialMode);
  // Tracks whether the reset-password email was successfully sent so we can
  // show the "check your inbox" confirmation state inside the modal.
  const [resetSent, setResetSent] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [handle, setHandle] = useState('');
  const [handleStatus, setHandleStatus] = useState<'idle' | 'checking' | 'ok' | 'taken' | 'format' | 'profanity'>('idle');
  const handleDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);
  // Portal target only exists in the browser; gate render until mounted.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Reset on open + focus the email field.
  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setEmail(initialEmail ?? '');
    setPassword('');
    setConfirmPassword('');
    setHandle('');
    setHandleStatus('idle');
    setShowPassword(false);
    setError(null);
    setInfo(null);
    setSubmitting(false);
    setResetSent(false);
    // Focus the email field — unless it's prefilled (invite flow), in which
    // case leave focus alone so the user lands on the next empty field.
    const t = setTimeout(() => {
      if (!initialEmail) emailRef.current?.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [open, initialMode, initialEmail]);

  // Self-close on successful auth. Some callers (e.g. the fantasy roster
  // builder) keep this modal mounted after sign-in — they open it on a write
  // attempt but have no way to know the AuthProvider listener has since set a
  // user. Once a user exists while we're open, the modal's job is done, so we
  // dismiss it ourselves rather than relying on the parent to notice. Callers
  // that unmount on sign-in (AccountChip) are unaffected — they never re-render
  // this while open. Guarded on `open` so we don't fire onDismiss spuriously.
  useEffect(() => {
    if (open && user) onDismiss?.();
  }, [open, user, onDismiss]);

  // Esc dismisses only when allowed.
  useEffect(() => {
    if (!open || !dismissible) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss?.();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, dismissible, onDismiss]);

  // Live-validate the handle: format → profanity → availability (debounced 400ms).
  const validateHandle = useCallback((raw: string) => {
    const u = raw.trim().toLowerCase();
    if (!u) { setHandleStatus('idle'); return; }
    if (!USERNAME_RE.test(u)) { setHandleStatus('format'); return; }
    const profanityError = moderateName(u, 'Handle');
    if (profanityError) { setHandleStatus('profanity'); return; }
    setHandleStatus('checking');
    if (handleDebounceRef.current) clearTimeout(handleDebounceRef.current);
    handleDebounceRef.current = setTimeout(async () => {
      try {
        const avail = await isUsernameAvailable(u);
        setHandleStatus(avail ? 'ok' : 'taken');
      } catch {
        setHandleStatus('idle');
      }
    }, 400);
  }, []);

  if (!open || !mounted) return null;

  const isSignup = mode === 'signup';
  const isReset = mode === 'reset';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setInfo(null);

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) {
      setError('Email is required.');
      return;
    }

    // Reset mode: validate email format, then send the link.
    if (isReset) {
      // Basic email format check before hitting the network.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
        setError('Please enter a valid email address.');
        return;
      }
      setSubmitting(true);
      const result = await resetPassword(trimmedEmail);
      setSubmitting(false);
      if (result.error) {
        setError(result.error);
        return;
      }
      // ANTI-ENUMERATION: always show the same generic message regardless of
      // whether the email is registered. Never say "we found your account".
      setResetSent(true);
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    if (isSignup) {
      if (password !== confirmPassword) {
        setError("Passwords don't match.");
        return;
      }

      // Handle is required on signup.
      const trimmedHandle = handle.trim().toLowerCase();
      if (!trimmedHandle) {
        setError('A handle is required. Choose your unique @identity.');
        return;
      }
      if (!USERNAME_RE.test(trimmedHandle)) {
        setError('Handle must be 3–30 characters: lowercase letters, numbers, underscores.');
        return;
      }
      if (handleStatus !== 'ok') {
        setError(
          handleStatus === 'taken'
            ? 'That handle is already taken. Please choose another.'
            : handleStatus === 'profanity'
            ? 'Handle contains language that isn\'t allowed.'
            : 'Please wait for handle availability to finish checking.',
        );
        return;
      }

      setSubmitting(true);
      const result = await signUp(trimmedEmail, password, {
        username: handle.trim().toLowerCase(),
      });
      setSubmitting(false);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.needsConfirmation) {
        setInfo('Check your inbox to confirm your email, then sign in.');
        setMode('signin');
        setPassword('');
        setConfirmPassword('');
      }
      // If session is returned immediately, the AuthProvider listener will
      // close the gate on its own — no further action needed here.
    } else {
      setSubmitting(true);
      const result = await signIn(trimmedEmail, password);
      setSubmitting(false);
      if (result.error) setError(result.error);
    }
  }

  // Portal to <body> so the overlay escapes the AppRail's stacking context
  // (the rail is sticky + backdrop-blur, which traps any z-index set on a
  // descendant — AccountChip, which renders this modal, lives inside it).
  // z-[100] sits above the rail's z-50 so the whole screen dims uniformly.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6 bg-black/40 backdrop-blur-sm"
      onPointerDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onDismiss?.();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-[440px] max-h-full overflow-y-auto bg-surface rounded-card-lg shadow-hero flex flex-col"
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex flex-col gap-2">
          <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-accent font-tight">
            The Playbook
          </span>
          <h2
            id="auth-modal-title"
            className="m-0 font-display italic font-bold text-[32px] leading-[0.95] tracking-[-0.03em] text-ink"
          >
            {headline ??
              (isReset
                ? 'Reset your password.'
                : isSignup
                  ? 'Make it yours.'
                  : 'Welcome back.')}
          </h2>
          <p className="text-[13px] text-muted font-tight leading-snug">
            {subhead ??
              (isReset
                ? "Enter your email and we'll send you a link to set a new password."
                : isSignup
                  ? 'Create an account to save plays, swap teams, and pick up where you left off.'
                  : 'Sign in to load your playbook and keep building from anywhere.')}
          </p>
        </div>

        {/* Mode toggle — hidden during reset flow */}
        {!isReset && (
          <div className="px-6 pb-2">
            <div className="grid grid-cols-2 gap-0 bg-ink/5 rounded-full overflow-hidden p-1">
              <ModeButton active={!isSignup} onClick={() => setMode('signin')}>
                Sign in
              </ModeButton>
              <ModeButton active={isSignup} onClick={() => setMode('signup')}>
                Create account
              </ModeButton>
            </div>
          </div>
        )}

        {/* OAuth (Google / Apple) — sign-in + sign-up only, not reset. Renders
            nothing (incl. the "or" divider) unless a provider flag is enabled. */}
        {!isReset && <OAuthButtons />}

        {/* Fields */}
        <div className="px-6 py-4 flex flex-col gap-3.5">
          {/* ── Reset mode: confirmation state (after link sent) ─────────── */}
          {isReset && resetSent ? (
            <>
              <div
                role="status"
                className="text-[13px] font-medium font-tight text-ink bg-ink/5 rounded-card-sm px-3.5 py-3 leading-snug"
              >
                Check your inbox — if{' '}
                <span className="font-bold">{email.trim().toLowerCase()}</span>{' '}
                has an account, we&apos;ve sent a reset link. It expires in 1 hour.
              </div>
              <button
                type="button"
                onClick={() => {
                  setMode('signin');
                  setResetSent(false);
                  setError(null);
                }}
                className="text-[12px] font-semibold font-tight text-muted hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm text-left"
              >
                ← Back to sign in
              </button>
            </>
          ) : (
            <>
              {/* ── Email (all modes) ───────────────────────────────────── */}
              <Field label="Email">
                <input
                  ref={emailRef}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                  spellCheck={false}
                  className="bg-ink/5 px-3.5 py-2.5 text-[14px] font-semibold text-ink font-tight rounded-card-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors"
                />
              </Field>

              {/* ── Handle (signup only) ─────────────────────────────────── */}
              {isSignup && (
                <div className="flex flex-col gap-1.5">
                  <label className="flex flex-col gap-1.5">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-[9px] font-bold tracking-[0.18em] uppercase text-faint font-tight">
                        Handle
                      </span>
                      <span className="text-[9px] font-medium text-faint font-tight normal-case tracking-normal">
                        required · your unique @identity
                      </span>
                    </span>
                    <div className="relative flex items-center">
                      <span className="absolute left-3 font-tight text-[14px] text-faint pointer-events-none select-none">
                        @
                      </span>
                      <input
                        type="text"
                        value={handle}
                        onChange={(e) => {
                          const cleaned = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
                          setHandle(cleaned);
                          validateHandle(cleaned);
                        }}
                        placeholder="your_handle"
                        autoComplete="username"
                        spellCheck={false}
                        maxLength={30}
                        className={[
                          'w-full bg-ink/5 pl-7 pr-10 py-2.5 text-[14px] font-semibold text-ink font-tight rounded-card-sm ring-1 ring-inset',
                          'focus-visible:outline-none focus-visible:ring-2 transition-colors',
                          handleStatus === 'ok'
                            ? 'ring-[#22c55e] focus-visible:ring-[#22c55e]'
                            : handleStatus === 'taken' || handleStatus === 'format' || handleStatus === 'profanity'
                            ? 'ring-live focus-visible:ring-live'
                            : 'ring-transparent focus-visible:ring-accent',
                        ].join(' ')}
                      />
                      {/* Status indicator — right side of input */}
                      <span className="absolute right-3 flex items-center" aria-hidden="true">
                        {handleStatus === 'checking' && (
                          <span className="w-4 h-4 rounded-full border-2 border-ink/15 border-t-accent animate-spin block" />
                        )}
                        {handleStatus === 'ok' && (
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M2.5 7l3.5 3.5 5.5-6" stroke="#22c55e" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                        {(handleStatus === 'taken' || handleStatus === 'format' || handleStatus === 'profanity') && (
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M3 3l8 8M11 3l-8 8" stroke="rgb(var(--live))" strokeWidth="1.8" strokeLinecap="round" />
                          </svg>
                        )}
                      </span>
                    </div>
                  </label>
                  {/* Inline feedback line */}
                  <span className="text-[11px] font-tight leading-snug">
                    {handleStatus === 'ok' && (
                      <span className="text-[#22c55e]">@{handle} is available</span>
                    )}
                    {handleStatus === 'taken' && (
                      <span className="text-live">That handle is already taken</span>
                    )}
                    {handleStatus === 'format' && (
                      <span className="text-live">3–30 chars · lowercase letters, numbers, underscores only</span>
                    )}
                    {handleStatus === 'profanity' && (
                      <span className="text-live">Handle contains language that isn&apos;t allowed</span>
                    )}
                    {(handleStatus === 'idle' || handleStatus === 'checking') && (
                      <span className="text-faint">Your unique @identity across the platform</span>
                    )}
                  </span>
                </div>
              )}

              {/* ── Password (signin + signup, not reset) ───────────────── */}
              {!isReset && (
                <div className="flex flex-col gap-1">
                  <Field
                    label="Password"
                    hint={isSignup ? '8+ characters' : undefined}
                  >
                    <PasswordInput
                      value={password}
                      onChange={setPassword}
                      placeholder={isSignup ? 'Pick something strong' : 'Your password'}
                      autoComplete={isSignup ? 'new-password' : 'current-password'}
                      show={showPassword}
                      onToggleShow={() => setShowPassword((v) => !v)}
                    />
                  </Field>
                  {/* Forgot password — signin only, right-aligned under the field */}
                  {!isSignup && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          setMode('reset');
                          setError(null);
                          setInfo(null);
                          setResetSent(false);
                        }}
                        className="text-[12px] text-muted hover:text-ink font-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm min-h-[44px] flex items-center"
                      >
                        Forgot password?
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ── Confirm password (signup only) ──────────────────────── */}
              {isSignup && (
                <Field label="Confirm password">
                  <PasswordInput
                    value={confirmPassword}
                    onChange={setConfirmPassword}
                    placeholder="Type it again"
                    autoComplete="new-password"
                    show={showPassword}
                    onToggleShow={() => setShowPassword((v) => !v)}
                    mismatch={confirmPassword.length > 0 && confirmPassword !== password}
                  />
                </Field>
              )}

              {/* ── Error / info banners ────────────────────────────────── */}
              {error && (
                <div
                  role="alert"
                  className="text-[12px] font-medium font-tight text-live bg-live/[0.08] rounded-card-sm px-3.5 py-2"
                >
                  {error}
                </div>
              )}
              {info && !error && (
                <div
                  role="status"
                  className="text-[12px] font-medium font-tight text-ink bg-ink/5 rounded-card-sm px-3.5 py-2"
                >
                  {info}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer / CTA — hidden once the reset email has been sent */}
        {!(isReset && resetSent) && (
          <div className="px-6 pb-6 flex flex-col gap-3">
            <button
              type="submit"
              disabled={submitting || (isSignup && handleStatus !== 'idle' && handleStatus !== 'ok' && handleStatus !== 'checking')}
              className={[
                'inline-flex items-center justify-center gap-2 w-full py-3 rounded-full cursor-pointer',
                'bg-accent text-accent-ink font-tight text-[12px] font-bold tracking-[0.16em] uppercase',
                'hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-opacity',
                'disabled:opacity-60 disabled:cursor-not-allowed',
              ].join(' ')}
            >
              {submitting
                ? isReset
                  ? 'Sending…'
                  : isSignup
                    ? 'Creating account…'
                    : 'Signing in…'
                : isReset
                  ? 'Send reset link'
                  : isSignup
                    ? 'Create account'
                    : 'Sign in'}
            </button>

            {/* Reset mode: show "back to sign in" link instead of mode toggle */}
            {isReset ? (
              <p className="text-center text-[11px] text-faint font-tight">
                <button
                  type="button"
                  onClick={() => {
                    setMode('signin');
                    setError(null);
                    setInfo(null);
                    setResetSent(false);
                  }}
                  className="text-ink font-semibold hover:text-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
                >
                  ← Back to sign in
                </button>
              </p>
            ) : (
              <p className="text-center text-[11px] text-faint font-tight">
                {isSignup ? 'Already have an account?' : "Don't have one yet?"}{' '}
                <button
                  type="button"
                  onClick={() => {
                    setMode(isSignup ? 'signin' : 'signup');
                    setError(null);
                    setInfo(null);
                  }}
                  className="text-ink font-semibold hover:text-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
                >
                  {isSignup ? 'Sign in' : 'Create one'}
                </button>
              </p>
            )}

            {dismissible && (
              <button
                type="button"
                onClick={onDismiss}
                className="text-[10px] font-bold tracking-[0.16em] uppercase text-faint hover:text-ink font-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
              >
                Maybe later
              </button>
            )}
          </div>
        )}
      </form>
    </div>,
    document.body,
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'py-2 rounded-full text-[11px] font-bold tracking-[0.16em] uppercase font-tight transition-colors cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        active ? 'bg-ink text-bg' : 'text-muted hover:text-ink',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  hint,
  optional,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[9px] font-bold tracking-[0.18em] uppercase text-faint font-tight">
          {label}
          {optional && <span className="text-faint/70 ml-1.5 normal-case tracking-normal">· optional</span>}
        </span>
        {hint && (
          <span className="text-[9px] font-medium text-faint font-tight normal-case tracking-normal">
            {hint}
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

// Password input with show/hide eye toggle. The toggle flips both the new
// and confirm fields at once (shared `show` state owned by the parent) so
// users only have to click once to verify both.
function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete,
  show,
  onToggleShow,
  mismatch,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoComplete: string;
  show: boolean;
  onToggleShow: () => void;
  mismatch?: boolean;
}) {
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required
        minLength={8}
        className={[
          'w-full bg-ink/5 px-3.5 py-2.5 pr-10 text-[14px] font-semibold text-ink font-tight rounded-card-sm ring-1 ring-inset',
          'focus-visible:outline-none focus-visible:ring-2 transition-colors',
          mismatch
            ? 'ring-live focus-visible:ring-live'
            : 'ring-transparent focus-visible:ring-accent',
        ].join(' ')}
      />
      <button
        type="button"
        onClick={onToggleShow}
        aria-label={show ? 'Hide password' : 'Show password'}
        aria-pressed={show}
        tabIndex={-1}
        className={[
          'absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center',
          'w-8 h-8 rounded text-muted hover:text-ink cursor-pointer transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        ].join(' ')}
      >
        {show ? <EyeOffGlyph /> : <EyeGlyph />}
      </button>
    </div>
  );
}

function EyeGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 8s2.6-4.5 6.5-4.5S14.5 8 14.5 8 11.9 12.5 8 12.5 1.5 8 1.5 8Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function EyeOffGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 3.5l11 9M3 8.5C4.2 6.6 6 4.5 8 4.5c1 0 1.9.3 2.7.7M12.7 6.5C13.6 7.3 14.3 8.2 14.5 8.5c-.6 1-2.5 4-6.5 4-.9 0-1.7-.2-2.4-.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 9.5a2 2 0 0 0 3-2.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

