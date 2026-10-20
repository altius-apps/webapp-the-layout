'use client';

// Global search overlay. Triggered by the search icon in the desktop
// topbar and the mobile header. Same search() function as the old
// sidebar widget — debounced, grouped Teams/Players results, arrow-keys
// + Enter to navigate.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { type SearchResult, resultHref } from '@/lib/usau/search-nav';
import { SearchResultIcon } from '@/components/search-result-icon';
import { FLIGHT_LABELS } from '@/lib/usau/flights';
import { searchAll } from '@/lib/ufa/search-actions';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SearchModal({ open, onClose }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Portal target only exists in the browser; gate render until mounted so
  // SSR/first paint stays safe.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Reset when the modal closes so reopen starts fresh.
  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setLoading(false);
      setHighlight(0);
    } else {
      // Focus the input on open.
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  // Debounced search, aborting stale renders.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await searchAll(q, 8);
        if (!cancelled) {
          setResults(r);
          setHighlight(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, open]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  function goTo(r: SearchResult) {
    onClose();
    router.push(resultHref(r));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = results[highlight];
      if (target) goTo(target);
    }
  }

  if (!open || !mounted) return null;

  const teamResults = results.filter((r) => r.kind === 'team');
  const playerResults = results.filter((r) => r.kind === 'player');
  const tournamentResults = results.filter((r) => r.kind === 'tournament');

  // Order the GROUPS by their best match quality, not a fixed Teams-first rule.
  // A full-word query like "hunter" makes "Hunter May" (player, whole-word tier
  // 1) beat "Hunt for Drunk October" (team, weaker match) — so the Players group
  // renders first here. Teams still win ties (same best rank) via the tiebreak,
  // preserving the "we prioritize teams" default when match quality is equal.
  const KIND_TIEBREAK: Record<'team' | 'player' | 'tournament', number> = {
    team: 0,
    player: 1,
    tournament: 2,
  };
  const bestRank = (rs: SearchResult[]): number =>
    rs.reduce((m, r) => Math.min(m, r.matchRank ?? 3), Infinity);
  const groups = (
    [
      { kind: 'team' as const, label: 'Teams', items: teamResults },
      { kind: 'player' as const, label: 'Players', items: playerResults },
      { kind: 'tournament' as const, label: 'Tournaments', items: tournamentResults },
    ] as const
  )
    .filter((g) => g.items.length > 0)
    .sort((a, b) => {
      const ra = bestRank(a.items);
      const rb = bestRank(b.items);
      if (ra !== rb) return ra - rb;
      return KIND_TIEBREAK[a.kind] - KIND_TIEBREAK[b.kind];
    });

  // Portal to <body> so the overlay escapes the app rail's stacking context
  // (the rail is sticky + backdrop-blur, which traps any z-index set on a
  // descendant). Rendered at the body root, z-[100] reliably covers the rail.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search teams and players"
      // z-[100] sits ABOVE the app rail (sticky z-50). If the backdrop shared
      // the rail's z-index, the rail floated above the dim layer and its own
      // backdrop-blur re-sampled the darkened page behind it — the muddy black
      // band across the nav. Covering the whole screen (rail included) fixes it.
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] px-4"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close search"
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm cursor-default"
      />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-[560px] bg-bg border border-border rounded-lg shadow-2xl overflow-hidden">
        <div className="relative border-b border-hairline">
          <span
            aria-hidden="true"
            className="absolute left-4 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
          >
            <SearchGlyph size={16} />
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search teams, players…"
            aria-label="Search teams and players"
            className={[
              'w-full bg-transparent',
              'pl-11 pr-12 py-4 text-[15px] text-ink font-tight placeholder:text-faint',
              'focus-visible:outline-none',
            ].join(' ')}
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-7 h-7 rounded-md text-faint hover:text-ink hover:bg-surface transition-colors cursor-pointer"
          >
            <CloseGlyph />
          </button>
        </div>

        <div className="max-h-[55vh] overflow-y-auto">
          {query.trim().length < 2 ? (
            <div className="px-4 py-6 text-[12px] text-faint font-tight">
              Type at least 2 characters to search.
            </div>
          ) : loading && results.length === 0 ? (
            <div className="px-4 py-6 text-[12px] text-faint font-tight">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-4 py-6 text-[12px] text-faint font-tight">No matches.</div>
          ) : (
            <>
              {groups.map((g) => (
                <Group key={g.kind} label={g.label}>
                  {g.items.map((r) => {
                    const i = results.indexOf(r);
                    return (
                      <ResultRow
                        key={`${r.league ?? ''}:${r.kind}:${r.id}:${r.name}`}
                        result={r}
                        active={i === highlight}
                        onClick={() => goTo(r)}
                      />
                    );
                  })}
                </Group>
              ))}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="px-4 pt-3 pb-1.5 text-[9px] font-bold tracking-[0.18em] uppercase text-faint font-tight">
        {label}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function ResultRow({
  result,
  active,
  onClick,
}: {
  result: SearchResult;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={[
        'flex items-center gap-3 px-4 py-2.5 text-left transition-colors cursor-pointer',
        'focus-visible:outline-none',
        active ? 'bg-surface' : 'hover:bg-surface',
      ].join(' ')}
    >
      <SearchResultIcon result={result} />
      <span className="flex-1 min-w-0">
        <span className="block text-[14px] font-semibold text-ink font-tight leading-tight truncate">
          {result.name}
        </span>
        {result.hint && (
          <span className="block text-[11px] font-medium text-faint font-tight truncate mt-0.5">
            {result.hint}
          </span>
        )}
      </span>
      {result.flight && (
        <span className="shrink-0 text-[9px] font-bold tracking-[0.14em] uppercase font-tight text-accent border border-accent/40 rounded px-1.5 py-0.5">
          {FLIGHT_LABELS[result.flight]}
        </span>
      )}
    </button>
  );
}

export function SearchGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
