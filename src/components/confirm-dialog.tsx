'use client';

// App dialogs — in-app replacements for window.confirm / alert / prompt, which
// render unstyled browser chrome, can't carry our copy or fonts, and on mobile
// read as a site error rather than part of the app.
//
//   ConfirmDialog — two buttons, for "are you sure?" on a destructive action.
//   AlertDialog   — one button, for "that worked" / "that's invalid".
//   PromptDialog  — a text field, for "rename this to…".
//
// All three share DialogShell: bottom sheet on a phone (thumb reach), centered
// card on desktop, Escape + backdrop to dismiss, Tab cycling kept inside the
// panel, and focus restored to the trigger on close. ConfirmDialog focuses
// CANCEL on open so a stray Enter can't confirm a delete.

import { useCallback, useEffect, useId, useRef, useState } from 'react';

const PANEL_CLASS =
  'relative z-10 w-full sm:max-w-md bg-bg rounded-t-card-lg sm:rounded-card-lg shadow-hero flex flex-col';

const BUTTON_BASE =
  'flex-1 inline-flex items-center justify-center min-h-[48px] rounded-full text-[12px] font-bold tracking-[0.06em] uppercase font-tight cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

const CANCEL_CLASS = `${BUTTON_BASE} bg-ink/5 text-ink hover:bg-ink/10 motion-safe:transition-colors`;
const PRIMARY_CLASS = `${BUTTON_BASE} bg-accent text-accent-ink hover:opacity-90 motion-safe:transition-opacity focus-visible:ring-offset-2 focus-visible:ring-offset-bg`;

/**
 * The modal shell every dialog here shares. `initialFocusRef` decides what is
 * focused on open — the cancel button for a destructive confirm, the input for
 * a prompt.
 */
function DialogShell({
  open,
  title,
  body,
  error,
  onDismiss,
  dismissible = true,
  initialFocusRef,
  children,
}: {
  open: boolean;
  title: string;
  body?: React.ReactNode;
  error?: string | null;
  onDismiss: () => void;
  /** False while an action is in flight, so a half-done delete isn't abandoned. */
  dismissible?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** The button row. */
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const uid = useId();
  const titleId = `dlg-title-${uid}`;
  const bodyId = `dlg-body-${uid}`;

  const dismiss = useCallback(() => {
    if (!dismissible) return;
    onDismiss();
  }, [dismissible, onDismiss]);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    initialFocusRef?.current?.focus();
    return () => restoreRef.current?.focus?.();
  }, [open, initialFocusRef]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismiss();
        return;
      }
      // Keep Tab inside the dialog rather than pulling in a focus-trap dep.
      if (e.key !== 'Tab') return;
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, dismiss]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40 motion-safe:animate-fade-in"
        onClick={dismiss}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={body ? bodyId : undefined}
        className={PANEL_CLASS}
      >
        <div className="p-5 flex flex-col gap-2.5">
          <span id={titleId} className="font-display italic text-2xl font-bold text-ink">
            {title}
          </span>
          {body && (
            <div id={bodyId} className="text-[13px] text-muted font-tight leading-snug break-words">
              {body}
            </div>
          )}
          {error && (
            <p className="text-[12px] text-accent font-tight" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="p-4 pt-0 flex gap-2">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  busyLabel,
  cancelLabel = 'Cancel',
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  /** Plain copy, or nodes when the body needs a link or a selectable value. */
  body?: React.ReactNode;
  confirmLabel: string;
  /** Shown on the confirm button while the action is in flight. */
  busyLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  return (
    <DialogShell
      open={open}
      title={title}
      body={body}
      error={error}
      onDismiss={onCancel}
      dismissible={!busy}
      initialFocusRef={cancelRef}
    >
      <button
        ref={cancelRef}
        type="button"
        onClick={onCancel}
        disabled={busy}
        className={CANCEL_CLASS}
      >
        {cancelLabel}
      </button>
      <button type="button" onClick={onConfirm} disabled={busy} className={PRIMARY_CLASS}>
        {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
      </button>
    </DialogShell>
  );
}

/** One button. Replaces alert() — a result to acknowledge, nothing to decide. */
export function AlertDialog({
  open,
  title,
  body,
  closeLabel = 'OK',
  onClose,
}: {
  open: boolean;
  title: string;
  body?: React.ReactNode;
  closeLabel?: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  return (
    <DialogShell open={open} title={title} body={body} onDismiss={onClose} initialFocusRef={closeRef}>
      <button ref={closeRef} type="button" onClick={onClose} className={PRIMARY_CLASS}>
        {closeLabel}
      </button>
    </DialogShell>
  );
}

/** A single text field. Replaces prompt(). Submits on Enter. */
export function PromptDialog({
  open,
  title,
  body,
  label,
  initialValue = '',
  placeholder,
  maxLength,
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  busy = false,
  error,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: string;
  body?: React.ReactNode;
  label: string;
  initialValue?: string;
  placeholder?: string;
  maxLength?: number;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(initialValue);
  const uid = useId();

  // Reset to the incoming value each time it opens, so reopening on a different
  // row doesn't show the previous row's text.
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    onSubmit(trimmed);
  }, [value, busy, onSubmit]);

  return (
    <DialogShell
      open={open}
      title={title}
      body={
        <div className="flex flex-col gap-2">
          {body}
          <label
            htmlFor={`dlg-input-${uid}`}
            className="text-[10.5px] font-bold tracking-[0.12em] uppercase text-muted font-tight"
          >
            {label}
          </label>
          <input
            id={`dlg-input-${uid}`}
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={placeholder}
            maxLength={maxLength}
            disabled={busy}
            className="w-full px-3 min-h-[44px] rounded-card bg-surface shadow-card text-[13.5px] text-ink font-tight placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </div>
      }
      error={error}
      onDismiss={onCancel}
      dismissible={!busy}
      initialFocusRef={inputRef}
    >
      <button type="button" onClick={onCancel} disabled={busy} className={CANCEL_CLASS}>
        {cancelLabel}
      </button>
      <button
        type="button"
        onClick={submit}
        disabled={busy || !value.trim()}
        className={PRIMARY_CLASS}
      >
        {confirmLabel}
      </button>
    </DialogShell>
  );
}
