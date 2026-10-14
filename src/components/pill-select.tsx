'use client';

// PillSelect — branded dropdown that replaces native <select> so the
// popover matches the rest of the chrome. The trigger looks identical
// to the previous pill-style native selects (same padding, font, etc.)
// so existing layouts continue to work; the difference is the menu —
// it's a styled <ul> popover instead of the OS-rendered list.
//
// Used by YearSelector, UsauDivisionSelect, and the USAU team-history
// year picker. Keep this primitive small and dependency-free — it's a
// shared chrome component touched by many pages.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

export interface PillSelectOption<V extends string | number> {
  value: V;
  label: string;
  /** Optional small secondary line (e.g. "soon"). */
  hint?: string;
  /** Disabled options render greyed out and are not focusable. */
  disabled?: boolean;
}

interface Props<V extends string | number> {
  value: V;
  options: PillSelectOption<V>[];
  onChange: (next: V) => void;
  /** Accessibility label for the trigger button. */
  ariaLabel: string;
  /** Optional className extension on the trigger button (e.g. min-w-[X]). */
  className?: string;
  /** Anchor the popover to the trigger's left (default) or right edge. */
  align?: 'left' | 'right';
  /** Max-height class for the menu (default max-h-[60vh]); it scrolls past that. */
  menuHeightClass?: string;
}

export function PillSelect<V extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
  align = 'left',
  menuHeightClass = 'max-h-[60vh]',
}: Props<V>) {
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState<number>(-1);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const listId = useId();

  const enabledIndexes = useMemo(
    () => options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0),
    [options],
  );
  // Fall back to the first option's label if `value` isn't among the options
  // (e.g. a restricted option set that doesn't include the shared/default
  // value) — otherwise the trigger renders as a bare chevron with no label.
  const currentLabel = useMemo(
    () => options.find((o) => o.value === value)?.label ?? options[0]?.label ?? '',
    [options, value],
  );

  // Sync the highlighted index whenever the menu opens — start on the
  // currently selected option so Enter works without arrow-keying first.
  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value);
    setFocusIdx(idx >= 0 && !options[idx].disabled ? idx : enabledIndexes[0] ?? -1);
  }, [open, options, value, enabledIndexes]);

  // Scroll a menu option into view (centered) when it's outside the visible
  // part of a scrolling menu. Moves the list only, never the page.
  const keepInView = useCallback((idx: number) => {
    const list = listRef.current;
    const item = list?.children[idx] as HTMLElement | undefined;
    if (!list || !item) return;
    if (item.offsetTop < list.scrollTop || item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = item.offsetTop - (list.clientHeight - item.offsetHeight) / 2;
    }
  }, []);

  // Open on the selected option, not the top of a long list.
  useEffect(() => {
    if (open) keepInView(options.findIndex((o) => o.value === value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Outside click + Escape close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const select = useCallback(
    (v: V) => {
      onChange(v);
      setOpen(false);
      // Restore focus so keyboard users don't lose their place.
      requestAnimationFrame(() => triggerRef.current?.focus());
    },
    [onChange],
  );

  function onTriggerKey(e: React.KeyboardEvent) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const pos = enabledIndexes.indexOf(focusIdx);
      const next =
        pos < 0
          ? enabledIndexes[0]
          : enabledIndexes[(pos + dir + enabledIndexes.length) % enabledIndexes.length];
      setFocusIdx(next);
      keepInView(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = options[focusIdx];
      if (opt && !opt.disabled) select(opt.value);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setFocusIdx(enabledIndexes[0] ?? -1);
      keepInView(enabledIndexes[0] ?? -1);
    } else if (e.key === 'End') {
      e.preventDefault();
      setFocusIdx(enabledIndexes[enabledIndexes.length - 1] ?? -1);
      keepInView(enabledIndexes[enabledIndexes.length - 1] ?? -1);
    }
  }

  return (
    <div ref={wrapRef} className="relative inline-flex items-center">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKey}
        className={[
          'inline-flex items-center gap-2 pl-3.5 pr-2.5 py-[7px] rounded-full min-h-[36px]',
          'text-[11px] font-bold tracking-[0.14em] uppercase font-tight',
          'bg-ink/5 text-ink cursor-pointer',
          'hover:bg-ink/10 transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          'whitespace-nowrap',
          className,
        ].join(' ')}
      >
        <span>{currentLabel}</span>
        <Chevron open={open} />
      </button>

      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          className={[
            'absolute top-full mt-1.5 z-30 min-w-[--pill-w] py-1.5',
            'bg-surface rounded-card shadow-lift',
            menuHeightClass,
            'overflow-y-auto',
            align === 'right' ? 'right-0' : 'left-0',
          ].join(' ')}
          style={
            // Match trigger width so the menu doesn't look orphaned for
            // short option lists.
            { ['--pill-w' as string]: `${triggerRef.current?.offsetWidth ?? 120}px` } as React.CSSProperties
          }
        >
          {options.map((o, i) => {
            const selected = o.value === value;
            const focused = focusIdx === i;
            return (
              <li key={String(o.value)} role="option" aria-selected={selected}>
                <button
                  type="button"
                  disabled={o.disabled}
                  onMouseEnter={() => !o.disabled && setFocusIdx(i)}
                  onClick={() => !o.disabled && select(o.value)}
                  className={[
                    'w-[calc(100%-12px)] text-left px-3.5 py-2 mx-1.5 rounded-full flex items-center justify-between gap-3',
                    'text-[12px] font-bold tracking-[0.12em] uppercase font-tight transition-colors duration-100',
                    o.disabled
                      ? 'text-faint cursor-not-allowed'
                      : focused
                        ? 'bg-ink/5 text-ink cursor-pointer'
                        : 'text-muted hover:text-ink cursor-pointer',
                  ].join(' ')}
                >
                  <span className="flex items-center gap-2">
                    {selected && (
                      <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full bg-accent" />
                    )}
                    <span className={selected && !o.disabled ? 'text-ink' : undefined}>
                      {o.label}
                    </span>
                  </span>
                  {o.hint && (
                    <span className="text-[9px] tracking-[0.18em] text-faint">{o.hint}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={[
        'text-muted transition-transform duration-150',
        open ? 'rotate-180' : '',
      ].join(' ')}
    >
      <path
        d="M3 4.5L6 7.5L9 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
