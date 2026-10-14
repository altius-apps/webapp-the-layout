'use client';

// Contest Roster Builder — client component.
// Typeahead w/ 200ms debounce, slot cards, lock banner and auth-gated save,
// across a contest's settings-driven shape:
//   weekly-stats mode → offenders+defenders slot groups + period selector
//   event mode        → single flat flex list, no roles, one 'event' period
//
// Player names link to /players/{id} only for ufa (the only league with a
// profile route); other leagues render plain text.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth/auth-provider';
import { AuthModal } from '@/components/auth/auth-modal';
import { revalidateFantasyLeague } from '@/app/fantasy/leagues/actions';
import {
  getContestPeriods,
  getMyContestTeam,
  getRosteredPct,
  periodsToWeeks,
  type ContestView,
  type ContestPeriod,
} from '@/lib/fantasy/leagues';
import {
  searchContestPlayers,
  getContestTeamRoster,
  saveContestRoster,
  previewContestPlayerPoints,
  type ContestRole,
} from '@/lib/fantasy/draft';
import type { FantasyPlayerHit } from '@/lib/fantasy/data';
import type { FantasyWeek } from '@/lib/fantasy/weeks';
import { formatWeekLabel } from '@/lib/fantasy/weeks';
import { getProjections, projectedPoints, projectionKey, type ProjectionMap } from '@/lib/fantasy/projections';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SlotState {
  role: ContestRole;
  player: FantasyPlayerHit | null;
  preview: number | null;
}

function buildSlots(contest: ContestView): SlotState[] {
  const s = contest.settings;
  if (s.mode === 'weekly-stats') {
    const off = Array.from({ length: s.offenders }, () => ({ role: 'offender' as const, player: null, preview: null }));
    const def = Array.from({ length: s.defenders }, () => ({ role: 'defender' as const, player: null, preview: null }));
    return [...off, ...def];
  }
  return Array.from({ length: s.flex }, () => ({ role: 'flex' as const, player: null, preview: null }));
}

interface ContestRosterBuilderProps {
  contest: ContestView;
  /** When present, the slot typeahead filters this pool locally (substring
   *  match; whole pool on focus) instead of calling searchContestPlayers —
   *  used by the Team tab for drafted contests to restrict lineups to a
   *  team's owned players. Web port of the mobile app's RosterBuilder pool
   *  mode (altiusapps/mobileapp-thelayout ·
   *  src/components/fantasy/RosterBuilder.tsx). */
  pool?: FantasyPlayerHit[];
  /** Official leagues: show each search result's league-wide rostered %. */
  showRosteredPct?: boolean;
}

export function ContestRosterBuilder({ contest, pool, showRosteredPct = false }: ContestRosterBuilderProps) {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [authOpen, setAuthOpen] = useState(false);

  const [periods, setPeriods] = useState<ContestPeriod[]>([]);
  const [periodsLoading, setPeriodsLoading] = useState(true);
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(null);

  const [myTeam, setMyTeam] = useState<{ id: string; teamName: string } | null>(null);
  const [teamLoading, setTeamLoading] = useState(true);

  const [slots, setSlots] = useState<SlotState[]>(() => buildSlots(contest));
  const [rosterLoading, setRosterLoading] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  const isEventMode = contest.settings.mode === 'event';

  const [rosteredPct, setRosteredPct] = useState<Map<string, number> | undefined>(undefined);
  useEffect(() => {
    if (!showRosteredPct || !selectedPeriod) return;
    let cancelled = false;
    getRosteredPct(contest.id, selectedPeriod)
      .then((m) => !cancelled && setRosteredPct(m))
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [contest.id, showRosteredPct, selectedPeriod]);

  const [projections, setProjections] = useState<ProjectionMap | undefined>(undefined);
  useEffect(() => {
    if (isEventMode) {
      setProjections(undefined);
      return;
    }
    let cancelled = false;
    getProjections(contest.id)
      .then((m) => !cancelled && setProjections(m))
      .catch(() => !cancelled && setProjections(undefined));
    return () => {
      cancelled = true;
    };
  }, [contest.id, isEventMode]);

  // ── Load periods (schedule) ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setPeriodsLoading(true);
    getContestPeriods(contest.id)
      .then((rows) => {
        if (cancelled) return;
        setPeriods(rows);
        const weeks = periodsToWeeks(rows);
        const active = pickActivePeriod(weeks, isEventMode);
        setSelectedPeriod(active);
      })
      .catch(() => {
        if (!cancelled) setPeriods([]);
      })
      .finally(() => {
        if (!cancelled) setPeriodsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [contest.id, isEventMode]);

  // ── Load my team ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) {
      setMyTeam(null);
      setTeamLoading(false);
      return;
    }
    let cancelled = false;
    setTeamLoading(true);
    getMyContestTeam(contest.id)
      .then((t) => {
        if (!cancelled) setMyTeam(t);
      })
      .catch(() => {
        if (!cancelled) setMyTeam(null);
      })
      .finally(() => {
        if (!cancelled) setTeamLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, contest.id]);

  // ── Load roster for the selected period once we have a team ────────────
  useEffect(() => {
    if (!myTeam || !selectedPeriod) {
      setSlots(buildSlots(contest));
      return;
    }
    let cancelled = false;
    setRosterLoading(true);
    getContestTeamRoster(contest, myTeam.id, selectedPeriod)
      .then((roster) => {
        if (cancelled) return;
        if (roster.length === 0) {
          setSlots(buildSlots(contest));
          return;
        }
        setSlots(fillSlotsFromRoster(contest, roster));
      })
      .catch(() => {
        if (!cancelled) setSlots(buildSlots(contest));
      })
      .finally(() => {
        if (!cancelled) setRosterLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTeam, selectedPeriod, contest.id]);

  const weeks = periodsToWeeks(periods);
  const activeWeekInfo = weeks.find((w) => w.week === selectedPeriod) ?? null;
  const isLocked = activeWeekInfo?.locked ?? false;

  const filledCount = slots.filter((s) => s.player !== null).length;
  const isComplete = filledCount === slots.length;
  const usedPlayerIds = new Set(slots.filter((s) => s.player !== null).map((s) => s.player!.playerId));

  const handleSelectPlayer = useCallback(
    async (slotIndex: number, player: FantasyPlayerHit) => {
      setSlots((prev) => {
        const next = [...prev];
        next[slotIndex] = { ...next[slotIndex], player, preview: null };
        return next;
      });
      if (isEventMode) return; // no preview in event mode
      const role = slots[slotIndex].role;
      if (role === 'flex') return;
      try {
        const pts = await previewContestPlayerPoints(contest, player.playerId, role);
        setSlots((prev) => {
          const next = [...prev];
          if (next[slotIndex].player?.playerId === player.playerId) {
            next[slotIndex] = { ...next[slotIndex], preview: pts };
          }
          return next;
        });
      } catch {
        // preview is non-critical
      }
    },
    [slots, contest, isEventMode],
  );

  const handleClearPlayer = useCallback((slotIndex: number) => {
    setSlots((prev) => {
      const next = [...prev];
      next[slotIndex] = { ...next[slotIndex], player: null, preview: null };
      return next;
    });
  }, []);

  const handleSave = async () => {
    if (!user) {
      setAuthOpen(true);
      return;
    }
    if (!myTeam) return;
    if (!isComplete || isLocked || !selectedPeriod) return;

    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      const rosterSlots = slots
        .filter((s) => s.player !== null)
        .map((s) => ({ playerId: s.player!.playerId, role: s.role }));
      await saveContestRoster(contest, myTeam.id, selectedPeriod, rosterSlots);
      await revalidateFantasyLeague(contest.leagueId, contest.id).catch(() => null);
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (authLoading || teamLoading || periodsLoading) {
    return <BuilderSkeleton />;
  }

  if (!myTeam) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-8 text-center">
        <p className="text-muted font-tight text-[14px]">
          Create a team on the contest page before building a roster.
        </p>
        <Link
          href={
            `/fantasy/l/${contest.id}`
          }
          className="inline-flex items-center gap-1.5 mt-4 text-accent font-tight text-[13px] font-bold hover:opacity-80 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
        >
          Back to contest
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-8">
        {/* Current period — NOT selectable. You edit the week that's open now,
            the one pickActivePeriod resolved; past weeks are locked and future
            ones aren't editable yet, so a dropdown only ever offered dead ends
            (Hunter, 2026-08-27). Read-only label. */}
        {!isEventMode && selectedPeriod && (
          <div className="flex items-center gap-3">
            <span className="text-[10.5px] font-bold tracking-[0.14em] uppercase text-faint font-tight">
              Period
            </span>
            <span className="font-tight text-[13px] font-bold tracking-[0.04em] uppercase text-ink">
              {formatWeekLabel(selectedPeriod)}
            </span>
          </div>
        )}

        <LockBanner
          isEventMode={isEventMode}
          week={activeWeekInfo}
          periods={periods}
        />

        {rosterLoading ? (
          <BuilderSkeleton />
        ) : isEventMode ? (
          <FlexSlotGroup
            contest={contest}
            slots={slots}
            usedPlayerIds={usedPlayerIds}
            onSelect={handleSelectPlayer}
            onClear={handleClearPlayer}
            disabled={isLocked}
            pool={pool}
            rosteredPct={rosteredPct}
          />
        ) : (
          <>
            <RoleSlotGroup
              contest={contest}
              role="offender"
              slots={slots}
              usedPlayerIds={usedPlayerIds}
              onSelect={handleSelectPlayer}
              onClear={handleClearPlayer}
              disabled={isLocked}
              pool={pool}
              rosteredPct={rosteredPct}
              projections={projections}
            />
            <RoleSlotGroup
              contest={contest}
              role="defender"
              slots={slots}
              usedPlayerIds={usedPlayerIds}
              onSelect={handleSelectPlayer}
              onClear={handleClearPlayer}
              disabled={isLocked}
              pool={pool}
              rosteredPct={rosteredPct}
              projections={projections}
            />
          </>
        )}

        <RosterSummaryBar filledCount={filledCount} total={slots.length} isEventMode={isEventMode} />

        {saveError && (
          <div className="px-4 py-3 rounded-card-sm bg-live/[0.08]">
            <span className="font-tight text-[13px] text-ink">{saveError}</span>
          </div>
        )}
        {saveOk && (
          <div className="px-4 py-3 rounded-card-sm bg-accent/[0.08]">
            <span className="font-tight text-[13px] text-ink">Roster saved.</span>
          </div>
        )}

        <SaveBar
          user={!!user}
          isLocked={isLocked}
          isComplete={isComplete}
          filledCount={filledCount}
          total={slots.length}
          saving={saving}
          onSave={handleSave}
        />
      </div>

      <AuthModal
        open={authOpen}
        initialMode="signin"
        dismissible
        onDismiss={() => setAuthOpen(false)}
        headline="Sign in to build your roster"
        subhead="Your roster is saved to your account."
      />
    </>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** The week the user is actually editing: the first whose lock hasn't arrived.
 *
 *  NOT `find(w => !w.locked)`. `locked` is true only INSIDE [lockAt, unlockAt),
 *  so once a week's unlock passes it reads unlocked again — and that predicate
 *  returned WEEK 1 for the whole season outside game windows. A week whose lock
 *  has passed is over; unlockAt opens the NEXT week, it never reopens that one.
 *  Falls back to the last week (which renders as locked) when the season's done. */
function pickActivePeriod(weeks: FantasyWeek[], isEventMode: boolean): string | null {
  if (weeks.length === 0) return isEventMode ? 'event' : null;
  const now = Date.now();
  const editable = weeks.find((w) => !w.lockAt || new Date(w.lockAt).getTime() > now);
  return (editable ?? weeks[weeks.length - 1]).week;
}

function fillSlotsFromRoster(
  contest: ContestView,
  roster: Awaited<ReturnType<typeof getContestTeamRoster>>,
): SlotState[] {
  const base = buildSlots(contest);
  const toHit = (r: (typeof roster)[number]): FantasyPlayerHit => ({
    playerId: r.playerId,
    fullName: r.fullName,
    teamId: null,
    teamName: r.teamName,
  });
  if (contest.settings.mode === 'event') {
    roster.slice(0, base.length).forEach((r, i) => {
      base[i] = { role: 'flex', player: toHit(r), preview: null };
    });
    return base;
  }
  const offenders = roster.filter((r) => r.role === 'offender');
  const defenders = roster.filter((r) => r.role === 'defender');
  const offCount = contest.settings.offenders;
  offenders.slice(0, offCount).forEach((r, i) => {
    base[i] = { role: 'offender', player: toHit(r), preview: null };
  });
  defenders.slice(0, contest.settings.defenders).forEach((r, i) => {
    base[offCount + i] = { role: 'defender', player: toHit(r), preview: null };
  });
  return base;
}

// "Fri, Jul 10, 7:00 PM ET" for a lock instant.
function formatLock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'first game';
  const s = d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  });
  return `${s} ET`;
}

function formatReopen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Monday';
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}

function formatEventStart(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'the event start';
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

// ─── Lock banner ────────────────────────────────────────────────────────────────

function LockBanner({
  isEventMode,
  week,
  periods,
}: {
  isEventMode: boolean;
  week: FantasyWeek | null;
  periods: ContestPeriod[];
}) {
  if (isEventMode) {
    const eventPeriod = periods.find((p) => p.period === 'event');
    if (!eventPeriod) return null;
    if (eventPeriod.complete) {
      return (
        <BannerShell tone="neutral">
          This event has finished — final scores are in.
        </BannerShell>
      );
    }
    if (week?.locked) {
      return (
        <BannerShell tone="live">
          Roster is locked — the event has started.
        </BannerShell>
      );
    }
    return (
      <BannerShell tone="quiet">
        Locks when the event starts
        {eventPeriod.lockAt ? ` — ${formatEventStart(eventPeriod.lockAt)}` : ''}. Edit any time before then.
      </BannerShell>
    );
  }

  if (!week) {
    return (
      <BannerShell tone="quiet">
        No active period found. Check back once the schedule is published.
      </BannerShell>
    );
  }

  if (week.locked) {
    return (
      <BannerShell tone="live">
        {formatWeekLabel(week.week)} is locked for the weekend
        {week.unlockAt ? ` — editing reopens ${formatReopen(week.unlockAt)}` : ' — roster changes are disabled'}.
      </BannerShell>
    );
  }

  return (
    <BannerShell tone="quiet">
      {week.lockAt
        ? `Locks at first game — ${formatLock(week.lockAt)}. Edit any time before then.`
        : 'Edit your roster any time before games start.'}
    </BannerShell>
  );
}

function BannerShell({ tone, children }: { tone: 'live' | 'quiet' | 'neutral'; children: React.ReactNode }) {
  const bg = tone === 'live' ? 'bg-live/[0.08]' : tone === 'neutral' ? 'bg-ink/[0.04]' : 'bg-ink/[0.04]';
  return (
    <div className={`flex items-center gap-3 px-4 py-3 rounded-card-sm ${bg}`}>
      {tone === 'live' && (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="flex-shrink-0 text-live">
          <rect x="3" y="7" width="10" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5 7V5a3 3 0 116 0v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
      <span className="font-tight text-[13px] font-medium text-ink">{children}</span>
    </div>
  );
}

// ─── Player Typeahead ─────────────────────────────────────────────────────────

interface TypeaheadProps {
  contest: ContestView;
  slotIndex: number;
  role: ContestRole;
  currentPlayer: FantasyPlayerHit | null;
  usedPlayerIds: Set<string>;
  onSelect: (slotIndex: number, player: FantasyPlayerHit) => void;
  onClear: (slotIndex: number) => void;
  disabled?: boolean;
  /** When present, search filters this pool locally instead of calling
   *  searchContestPlayers — see ContestRosterBuilderProps.pool above. */
  pool?: FantasyPlayerHit[];
  rosteredPct?: Map<string, number>;
}

function PlayerTypeahead({
  contest,
  slotIndex,
  role,
  currentPlayer,
  usedPlayerIds,
  onSelect,
  onClear,
  disabled = false,
  pool,
  rosteredPct,
}: TypeaheadProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FantasyPlayerHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeq = useRef(0);

  const search = useCallback(async (q: string) => {
    if (pool) {
      // Pool mode: filter locally (case-insensitive substring); an empty
      // query shows the whole pool while the field is focused.
      const needle = q.trim().toLowerCase();
      const hits = needle ? pool.filter((p) => p.fullName.toLowerCase().includes(needle)) : pool;
      setResults(hits.filter((h) => !usedPlayerIds.has(h.playerId)));
      setOpen(true);
      return;
    }
    // Responses can land out of order; only the latest search may write.
    const seq = ++searchSeq.current;
    if (q.length < 2) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const hits = await searchContestPlayers(contest, q, 12);
      if (seq !== searchSeq.current) return;
      setResults(hits.filter((h) => !usedPlayerIds.has(h.playerId)));
      setOpen(true);
    } catch {
      if (seq === searchSeq.current) setResults([]);
    } finally {
      if (seq === searchSeq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contest, usedPlayerIds, pool]);

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (pool) {
      void search(val); // local filter — no debounce needed
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 200);
  };

  const handleFocus = () => {
    if (pool) void search(query);
  };

  const handleSelect = (player: FantasyPlayerHit) => {
    onSelect(slotIndex, player);
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  const handleClear = () => {
    onClear(slotIndex);
    setQuery('');
    setResults([]);
    setOpen(false);
    inputRef.current?.focus();
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        inputRef.current &&
        !inputRef.current.contains(e.target as Node) &&
        listRef.current &&
        !listRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const roleLabel = role === 'offender' ? 'O' : role === 'defender' ? 'D' : 'F';
  const roleColor = role === 'offender' ? 'text-ink' : role === 'defender' ? 'text-accent' : 'text-ink';
  const isUfa = contest.competitionDef.playerLeague === 'ufa';

  if (currentPlayer) {
    return (
      <div className="flex items-center gap-3 px-3.5 py-2.5 rounded-card-sm bg-ink/5 min-h-[44px]">
        <span
          className="flex-shrink-0 w-5 h-5 rounded-full text-[9px] font-bold flex items-center justify-center bg-surface font-tight"
          style={{ color: undefined }}
        >
          <span className={roleColor}>{roleLabel}</span>
        </span>
        <span className="flex-1 min-w-0">
          {isUfa ? (
            <Link
              href={`/players/${currentPlayer.playerId}`}
              prefetch={false}
              className="block font-tight text-[14px] font-semibold text-ink truncate hover:text-accent transition-colors duration-150 focus-visible:outline-none focus-visible:underline"
            >
              {currentPlayer.fullName}
            </Link>
          ) : (
            <span className="block font-tight text-[14px] font-semibold text-ink truncate">
              {currentPlayer.fullName}
            </span>
          )}
          {currentPlayer.teamName && (
            <span className="block font-tight text-[11px] text-muted truncate">{currentPlayer.teamName}</span>
          )}
        </span>
        {!disabled && (
          <button
            type="button"
            onClick={handleClear}
            aria-label={`Remove ${currentPlayer.fullName}`}
            className={[
              'flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center',
              'text-faint hover:text-ink hover:bg-ink/10',
              'transition-colors duration-150 cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            ].join(' ')}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="relative flex items-center">
        <span
          className={[
            'absolute left-3 flex-shrink-0 w-5 h-5 rounded-full text-[9px] font-bold flex items-center justify-center',
            'bg-surface font-tight pointer-events-none',
            roleColor,
          ].join(' ')}
          aria-hidden="true"
        >
          {roleLabel}
        </span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleInput}
          onFocus={() => (pool ? handleFocus() : query.length >= 2 && setOpen(true))}
          disabled={disabled}
          placeholder={`Search ${role === 'offender' ? 'offender' : role === 'defender' ? 'defender' : 'player'}…`}
          aria-label={`Search for a player to add as ${role}`}
          aria-autocomplete="list"
          aria-expanded={open}
          className={[
            'w-full pl-10 pr-4 py-2.5 rounded-card-sm bg-ink/5',
            'font-tight text-[14px] text-ink placeholder:text-faint',
            'transition-colors duration-150',
            'focus:outline-none focus:ring-2 focus:ring-accent',
            'min-h-[44px]',
            disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-text',
          ].join(' ')}
        />
        {loading && (
          <div
            className="absolute right-3 w-4 h-4 rounded-full border-2 border-ink/15 border-t-accent animate-spin"
            aria-hidden="true"
          />
        )}
      </div>

      {open && results.length > 0 && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Player search results"
          className={[
            'absolute top-full left-0 right-0 z-20 mt-1.5',
            'bg-surface rounded-card shadow-lift overflow-hidden',
            'max-h-[240px] overflow-y-auto',
          ].join(' ')}
        >
          {results.map((hit) => (
            <li
              key={hit.playerId}
              role="option"
              aria-selected="false"
              className={[
                'flex items-center',
                'hover:bg-surface-hi transition-colors duration-150',
                'border-t border-hairline first:border-t-0',
              ].join(' ')}
            >
              <button
                type="button"
                onClick={() => handleSelect(hit)}
                className={[
                  'flex-1 min-w-0 flex items-center gap-3 px-4 py-2.5 text-left',
                  'cursor-pointer',
                  'focus-visible:outline-none focus-visible:bg-surface-hi',
                ].join(' ')}
              >
                <span className="flex-1 min-w-0">
                  <span className="block font-tight text-[13px] font-semibold text-ink truncate">
                    {hit.fullName}
                  </span>
                  {hit.teamName && (
                    <span className="block font-tight text-[11px] text-muted truncate">{hit.teamName}</span>
                  )}
                </span>
                {rosteredPct && (rosteredPct.get(`${contest.competitionDef.playerLeague}:${hit.playerId}`) ?? 0) > 0 && (
                  <span className="flex-shrink-0 font-tight text-[10.5px] text-faint">
                    Rostered {rosteredPct.get(`${contest.competitionDef.playerLeague}:${hit.playerId}`)}%
                  </span>
                )}
              </button>
              {isUfa && (
                <Link
                  href={`/players/${hit.playerId}`}
                  prefetch={false}
                  onMouseDown={(e) => e.stopPropagation()}
                  aria-label={`View ${hit.fullName}'s profile`}
                  title="View profile"
                  className={[
                    'flex-shrink-0 flex items-center justify-center w-9 h-9 mr-1.5 rounded-full',
                    'text-faint hover:text-accent hover:bg-ink/5',
                    'transition-colors duration-150',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  ].join(' ')}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M6 3l5 5-5 5"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      {open && !loading && results.length === 0 && query.length >= 2 && (
        <div className="absolute top-full left-0 right-0 z-20 mt-1.5 bg-surface rounded-card shadow-lift px-4 py-3">
          <span className="font-tight text-[13px] text-faint">No players found for &ldquo;{query}&rdquo;</span>
        </div>
      )}
    </div>
  );
}

function PreviewBadge({ points, projPoints }: { points: number | null; projPoints?: number | null }) {
  if (points === null && projPoints == null) return null;
  return (
    <div className="flex items-center gap-1 mt-1.5 pl-8 flex-wrap" aria-label={`Season preview: ${points} points`}>
      {points !== null && (
        <>
          <span className="font-tight text-[11px] text-faint">Season preview:</span>
          <span className="font-tight text-[11px] font-bold text-ink tabular">{points} pts</span>
        </>
      )}
      {projPoints != null && (
        <span className="font-tight text-[11px] text-faint tabular">
          {points !== null ? ' · ' : ''}
          {`Proj ${projPoints}`}
        </span>
      )}
    </div>
  );
}

// ─── Slot groups ────────────────────────────────────────────────────────────────

function RoleSlotGroup({
  contest,
  role,
  slots,
  usedPlayerIds,
  onSelect,
  onClear,
  disabled,
  pool,
  rosteredPct,
  projections,
}: {
  contest: ContestView;
  role: 'offender' | 'defender';
  slots: SlotState[];
  usedPlayerIds: Set<string>;
  onSelect: (slotIndex: number, player: FantasyPlayerHit) => void;
  onClear: (slotIndex: number) => void;
  disabled: boolean;
  pool?: FantasyPlayerHit[];
  rosteredPct?: Map<string, number>;
  projections?: ProjectionMap;
}) {
  const roleSlots = slots.filter((s) => s.role === role);
  const filled = roleSlots.filter((s) => s.player !== null).length;
  const playerLeague = contest.competitionDef.playerLeague;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span
            className={[
              'inline-flex items-center justify-center w-5 h-5 rounded-full text-[9px] font-bold font-tight',
              'bg-ink/[0.08]',
              role === 'offender' ? 'text-ink' : 'text-accent',
            ].join(' ')}
            aria-hidden="true"
          >
            {role === 'offender' ? 'O' : 'D'}
          </span>
          <span className="text-[11px] font-bold tracking-[0.18em] uppercase text-muted font-tight">
            {role === 'offender' ? 'Offense' : 'Defense'}
          </span>
          <span className="text-[11px] font-bold text-faint font-tight">
            ({filled}/{roleSlots.length})
          </span>
        </div>
      </div>
      <div className="space-y-2">
        {slots.map((slot, idx) => {
          if (slot.role !== role) return null;
          return (
            <div key={idx}>
              <PlayerTypeahead
                contest={contest}
                slotIndex={idx}
                role={role}
                currentPlayer={slot.player}
                usedPlayerIds={usedPlayerIds}
                onSelect={onSelect}
                onClear={onClear}
                disabled={disabled}
                pool={pool}
                rosteredPct={rosteredPct}
              />
              {slot.player && (
                <PreviewBadge
                  points={slot.preview}
                  projPoints={
                    projections ? projectedPoints(projections.get(projectionKey(playerLeague, slot.player.playerId)), role) : null
                  }
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FlexSlotGroup({
  contest,
  slots,
  usedPlayerIds,
  onSelect,
  onClear,
  disabled,
  pool,
  rosteredPct,
}: {
  contest: ContestView;
  slots: SlotState[];
  usedPlayerIds: Set<string>;
  onSelect: (slotIndex: number, player: FantasyPlayerHit) => void;
  onClear: (slotIndex: number) => void;
  disabled: boolean;
  pool?: FantasyPlayerHit[];
  rosteredPct?: Map<string, number>;
}) {
  const filled = slots.filter((s) => s.player !== null).length;
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold tracking-[0.18em] uppercase text-muted font-tight">
            Roster
          </span>
          <span className="text-[11px] font-bold text-faint font-tight">
            ({filled}/{slots.length})
          </span>
        </div>
      </div>
      <div className="space-y-2">
        {slots.map((slot, idx) => (
          <PlayerTypeahead
            key={idx}
            contest={contest}
            slotIndex={idx}
            role="flex"
            currentPlayer={slot.player}
            usedPlayerIds={usedPlayerIds}
            onSelect={onSelect}
            onClear={onClear}
            disabled={disabled}
            pool={pool}
            rosteredPct={rosteredPct}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Summary + save ───────────────────────────────────────────────────────────

function RosterSummaryBar({
  filledCount,
  total,
  isEventMode,
}: {
  filledCount: number;
  total: number;
  isEventMode: boolean;
}) {
  return (
    <div className="flex items-center gap-2 py-2">
      {Array.from({ length: total }).map((_, i) => {
        const filled = i < filledCount;
        return (
          <div
            key={i}
            aria-hidden="true"
            className={[
              'h-1 flex-1 rounded-full transition-colors duration-200',
              filled ? (isEventMode ? 'bg-accent' : 'bg-ink') : 'bg-ink/[0.12]',
            ].join(' ')}
          />
        );
      })}
      <span className="flex-shrink-0 font-tight text-[11px] text-faint ml-1">
        {filledCount}/{total}
      </span>
    </div>
  );
}

function SaveBar({
  user,
  isLocked,
  isComplete,
  filledCount,
  total,
  saving,
  onSave,
}: {
  user: boolean;
  isLocked: boolean;
  isComplete: boolean;
  filledCount: number;
  total: number;
  saving: boolean;
  onSave: () => void;
}) {
  const canSave = isComplete && !isLocked && !saving;
  const remaining = total - filledCount;

  return (
    <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center pt-2">
      <button
        type="button"
        onClick={onSave}
        disabled={!canSave && !!user}
        aria-label={
          !user
            ? 'Sign in to save your roster'
            : isLocked
            ? 'This roster is locked'
            : !isComplete
            ? `Select ${remaining} more player${remaining !== 1 ? 's' : ''}`
            : 'Save roster'
        }
        className={[
          'inline-flex items-center justify-center gap-2',
          'px-6 py-3 rounded-full min-h-[44px]',
          'font-tight text-[13px] font-bold tracking-[0.06em] uppercase',
          'transition-all duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
          canSave || !user
            ? 'bg-accent text-accent-ink hover:opacity-90 cursor-pointer'
            : 'bg-ink/[0.08] text-faint cursor-not-allowed',
        ].join(' ')}
      >
        {saving ? (
          <>
            <div className="w-4 h-4 rounded-full border-2 border-current/30 border-t-current animate-spin" aria-hidden="true" />
            Saving…
          </>
        ) : !user ? (
          'Sign in to save'
        ) : isLocked ? (
          'Roster locked'
        ) : !isComplete ? (
          `${remaining} slot${remaining !== 1 ? 's' : ''} remaining`
        ) : (
          'Save roster'
        )}
      </button>

      {user && !isComplete && !isLocked && (
        <span className="font-tight text-[12px] text-faint">Fill every slot to save.</span>
      )}
    </div>
  );
}

function BuilderSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-11 rounded-card-sm bg-ink/[0.06] animate-pulse" aria-hidden="true" />
      ))}
    </div>
  );
}
