'use client';

// PlayersPanel — the "Players" tab body. Search (200ms debounce, min 2
// chars) + filter (All | Available | My team) + rows (name · team · season
// preview points (UFA only) · ownership label). Drafted weekly-stats
// contests with a complete draft and a signed-in team get an Add action on
// available rows → modal to pick who to drop, and a View team link on other
// teams' rostered rows → that team's profile, where trades are proposed
// (Hunter, 2026-10-09). Web port of the mobile app's PlayersList.tsx
// (altiusapps/mobileapp-thelayout · src/components/fantasy/PlayersList.tsx).
//
// Event contests with player ratings (USAU Nationals) list the ranked players
// when nothing is typed (All / Available), and open on My team once the draft
// completes and rosters exist, with the pro team kept from the rating. Every
// rated row shows rank + Proj (src/lib/fantasy/ratings.ts). While a draft
// runs, its picks mark players as owned, so Available drops them live.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { useAuth } from '@/lib/auth/auth-provider';
import {
  getMyContestTeam,
  getContestPeriods,
  getRosteredPct,
  periodsToWeeks,
  getTeamPlayers,
  addDrop,
  getWaiverPlayers,
  waiverSettings,
  type ContestView,
} from '@/lib/fantasy/leagues';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { getDraft, getDraftPicks, subscribeDraft, unsubscribeDraft, type DraftPick } from '@/lib/fantasy/draft-room';
import { searchContestPlayers } from '@/lib/fantasy/draft';
import { playerSeasonPreview } from '@/lib/fantasy/data';
import type { FantasyPlayerHit } from '@/lib/fantasy/data';
import { revalidateFantasyLeague } from '@/app/fantasy/leagues/actions';
import { WaiverClaimDialog } from '@/components/fantasy/waivers/waiver-claim-dialog';
import {
  RANKED_PAGE_SIZE,
  RankingsHeader,
  RatingLine,
  ShowMoreButton,
  ratingToHit,
} from '@/components/fantasy/player-rating';
import { getProjections, projectedPoints, projectionKey, type ProjectionMap } from '@/lib/fantasy/projections';
import { getContestRatings, ratingKey, toRatingMap, type PlayerRating } from '@/lib/fantasy/ratings';
import { contestDivision, divisionLabel } from '@/lib/fantasy/competitions';

type Filter = 'all' | 'available' | 'mine';

function waiverClearsLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Waivers';
  return `Waivers · clears ${d.toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: d.getMinutes() === 0 ? undefined : '2-digit',
  })}`;
}

interface Row {
  playerId: string;
  fullName: string;
  teamName: string | null;
  ownerLabel: string;
  isMine: boolean;
  isAvailable: boolean;
  ownerTeamId: string | null;
  waiverAvailableAt: string | null;
  rating: PlayerRating | undefined;
}

export function PlayersPanel({ contest, isOfficial = false }: { contest: ContestView; isOfficial?: boolean }) {
  const { user } = useAuth();
  const isUfa = contest.competitionDef.playerLeague === 'ufa';
  const isDrafted = contest.settings.draft === true;
  const isWeekly = contest.settings.mode === 'weekly-stats';
  const isEvent = contest.settings.mode === 'event';

  const [rosteredPct, setRosteredPct] = useState<Map<string, number> | undefined>(undefined);
  useEffect(() => {
    if (!isOfficial) return;
    let cancelled = false;
    const period = isEvent
      ? Promise.resolve('event')
      : getContestPeriods(contest.id).then((periods) => {
          const weeks = periodsToWeeks(periods);
          const nowMs = Date.now();
          const upcoming = weeks.find((w) => w.lockAt == null || new Date(w.lockAt).getTime() > nowMs);
          return (upcoming ?? weeks[weeks.length - 1])?.week ?? null;
        });
    period
      .then((p) => (p ? getRosteredPct(contest.id, p) : null))
      .then((m) => m && !cancelled && setRosteredPct(m))
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [contest.id, isOfficial, isEvent]);

  const [projections, setProjections] = useState<ProjectionMap | undefined>(undefined);
  useEffect(() => {
    if (!isWeekly) {
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
  }, [contest.id, isWeekly]);

  const [ratings, setRatings] = useState<PlayerRating[]>([]);
  useEffect(() => {
    if (!isEvent) {
      setRatings([]);
      return;
    }
    let cancelled = false;
    getContestRatings(contest)
      .then((r) => !cancelled && setRatings(r))
      .catch(() => !cancelled && setRatings([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contest.id, isEvent]);
  const ratingMap = useMemo(() => toRatingMap(ratings), [ratings]);
  const [rankedShown, setRankedShown] = useState(RANKED_PAGE_SIZE);

  const [myTeam, setMyTeam] = useState<{ id: string; teamName: string } | null>(null);
  const [allOwnership, setAllOwnership] = useState<{ playerId: string; teamId: string }[]>([]);
  const [myOwnership, setMyOwnership] = useState<{ playerId: string; playerName: string }[]>([]);
  const [draftComplete, setDraftComplete] = useState(false);
  // Rosters are only seeded when the draft completes, so until then ownership
  // comes from the picks, kept live while the draft runs.
  const [draftPicks, setDraftPicks] = useState<DraftPick[]>([]);

  useEffect(() => {
    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    if (isDrafted) {
      getTeamPlayers(contest.id)
        .then((rows) => !cancelled && setAllOwnership(rows.map((r) => ({ playerId: r.playerId, teamId: r.teamId }))))
        .catch(() => !cancelled && setAllOwnership([]));
    }
    getDraft(contest.id)
      .then((d) => {
        if (cancelled) return;
        setDraftComplete(d?.status === 'complete');
        if (!d || d.status === 'complete') return;
        const loadPicks = () =>
          getDraftPicks(d.id)
            .then((p) => !cancelled && setDraftPicks(p))
            .catch(() => {});
        loadPicks();
        // Completion flips draftComplete, which re-runs this effect (and the
        // My team one) to read the seeded rosters instead.
        channel = subscribeDraft(d.id, () => {
          loadPicks();
          getDraft(contest.id)
            .then((nd) => !cancelled && nd?.status === 'complete' && setDraftComplete(true))
            .catch(() => {});
        });
      })
      .catch(() => !cancelled && setDraftComplete(false));
    return () => {
      cancelled = true;
      if (channel) unsubscribeDraft(channel);
    };
  }, [contest.id, isDrafted, draftComplete]);

  useEffect(() => {
    if (!user) {
      setMyTeam(null);
      return;
    }
    let cancelled = false;
    getMyContestTeam(contest.id)
      .then((t) => !cancelled && setMyTeam(t))
      .catch(() => !cancelled && setMyTeam(null));
    return () => {
      cancelled = true;
    };
  }, [user, contest.id]);

  useEffect(() => {
    if (!myTeam || !isDrafted) {
      setMyOwnership([]);
      return;
    }
    let cancelled = false;
    getTeamPlayers(contest.id, myTeam.id)
      .then((rows) => !cancelled && setMyOwnership(rows.map((r) => ({ playerId: r.playerId, playerName: r.playerName }))))
      .catch(() => !cancelled && setMyOwnership([]));
    return () => {
      cancelled = true;
    };
  }, [contest.id, myTeam, isDrafted, draftComplete]);

  const canAddDrop = isWeekly && isDrafted && draftComplete && Boolean(myTeam);
  const canViewOwner = isWeekly && isDrafted && draftComplete;

  const isFaab = waiverSettings(contest.settings).mode === 'faab';
  const [waiverByPlayer, setWaiverByPlayer] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!isFaab || !canAddDrop) {
      setWaiverByPlayer(new Map());
      return;
    }
    let cancelled = false;
    getWaiverPlayers(contest.id)
      .then((rows) => {
        if (cancelled) return;
        const now = Date.now();
        const m = new Map<string, string>();
        for (const w of rows) {
          if (new Date(w.availableAt).getTime() > now) m.set(w.playerId, w.availableAt);
        }
        setWaiverByPlayer(m);
      })
      .catch(() => !cancelled && setWaiverByPlayer(new Map()));
    return () => {
      cancelled = true;
    };
  }, [contest.id, isFaab, canAddDrop]);

  const [query, setQuery] = useState('');
  // null until a pill is tapped; `filter` below follows the view until then.
  const [chosenFilter, setChosenFilter] = useState<Filter | null>(null);
  const [results, setResults] = useState<FantasyPlayerHit[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    // Responses can land out of order; only the latest query may write.
    let cancelled = false;
    setSearching(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      searchContestPlayers(contest, query, 30)
        .then((hits) => !cancelled && setResults(hits))
        .catch(() => !cancelled && setResults([]))
        .finally(() => !cancelled && setSearching(false));
    }, 200);
    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, contest.id]);

  const ownerByPlayer = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of allOwnership) m.set(t.playerId, t.teamId);
    if (!draftComplete) for (const p of draftPicks) m.set(p.playerId, p.teamId);
    return m;
  }, [allOwnership, draftPicks, draftComplete]);

  const myPlayerIds = useMemo(() => {
    const s = new Set(myOwnership.map((t) => t.playerId));
    if (!draftComplete && myTeam) for (const p of draftPicks) if (p.teamId === myTeam.id) s.add(p.playerId);
    return s;
  }, [myOwnership, draftPicks, draftComplete, myTeam]);

  const hasQuery = query.trim().length >= 2;
  // Scheduling a draft sets settings.draft, but rosters are only seeded when the
  // draft completes, so a rated pool keeps its ranked list until then. After
  // that, with nothing typed, the pill opens on My team (or All while searching).
  const rosterView = isDrafted && (draftComplete || ratings.length === 0);
  const filter: Filter = chosenFilter ?? (rosterView && !hasQuery ? 'mine' : 'all');
  // The list follows the pill: My team shows the roster, anything else the ranked
  // pool (rated contests) or the search prompt.
  const showMyTeamDefault = !hasQuery && rosterView && filter === 'mine';
  const showRanked = !hasQuery && !showMyTeamDefault && ratings.length > 0;

  const baseHits: FantasyPlayerHit[] = hasQuery
    ? results
    : showMyTeamDefault
      ? myOwnership.map((t) => ({
          playerId: t.playerId,
          fullName: t.playerName,
          teamId: null,
          teamName: ratingMap.get(ratingKey(contest.competitionDef.playerLeague, t.playerId))?.teamName ?? null,
        }))
      : showRanked
        ? ratings.map(ratingToHit)
        : [];

  const rows: Row[] = baseHits.map((hit) => {
    const ownerId = ownerByPlayer.get(hit.playerId);
    const isMine = myPlayerIds.has(hit.playerId);
    const isAvailable = isDrafted ? !ownerId : true;
    const ownerLabel = isMine ? 'You' : ownerId ? 'Owned' : 'Free agent';
    return {
      playerId: hit.playerId,
      fullName: hit.fullName,
      teamName: hit.teamName,
      ownerLabel,
      isMine,
      isAvailable,
      ownerTeamId: ownerId ?? null,
      waiverAvailableAt: waiverByPlayer.get(hit.playerId) ?? null,
      rating: ratingMap.get(ratingKey(contest.competitionDef.playerLeague, hit.playerId)),
    };
  });

  const matchingRows = rows.filter((r) => {
    if (filter === 'available') return r.isAvailable;
    if (filter === 'mine') return r.isMine;
    return true;
  });
  // The ranked list pages after filtering, so Available keeps filling as the
  // top of the list is drafted.
  const filteredRows = showRanked ? matchingRows.slice(0, rankedShown) : matchingRows;

  const showAvailableFilter = isDrafted;
  const division = contestDivision(contest.settings);
  const poolLabel = `${contest.competitionDef.shortLabel}${division === 'all' ? '' : ` ${divisionLabel(division)}`}`;

  const [dropSheetPlayer, setDropSheetPlayer] = useState<{ playerId: string; playerName: string } | null>(null);
  const [claimPlayer, setClaimPlayer] = useState<{ playerId: string; playerName: string } | null>(null);

  return (
    <div className="space-y-5">
      {/* ── Search ─────────────────────────────────────────────────────── */}
      <div className="relative flex items-center">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search the ${poolLabel} player pool`}
          aria-label="Search players"
          className={[
            'w-full px-3.5 py-2.5 rounded-card-sm bg-ink/5',
            'font-tight text-[14px] text-ink placeholder:text-faint',
            'focus:outline-none focus:ring-2 focus:ring-accent',
            'min-h-[44px]',
          ].join(' ')}
        />
        {searching && (
          <div className="absolute right-3 w-4 h-4 rounded-full border-2 border-ink/15 border-t-accent animate-spin" aria-hidden="true" />
        )}
      </div>

      {/* ── Segmented filter ──────────────────────────────────────────── */}
      <div className="flex gap-2">
        <SegmentButton label="All" active={filter === 'all'} onClick={() => setChosenFilter('all')} />
        {showAvailableFilter && (
          <SegmentButton label="Available" active={filter === 'available'} onClick={() => setChosenFilter('available')} />
        )}
        <SegmentButton label="My team" active={filter === 'mine'} onClick={() => setChosenFilter('mine')} />
      </div>

      {/* ── Rows ───────────────────────────────────────────────────────── */}
      {filteredRows.length === 0 ? (
        <p className="text-center font-tight text-[13px] text-faint py-8">
          {hasQuery
            ? searching
              ? 'Searching…'
              : `No players found for "${query.trim()}"`
            : showMyTeamDefault || (showRanked && filter === 'mine')
              ? 'No players on your team yet.'
              : `Search the ${poolLabel} player pool`}
        </p>
      ) : (
        <div className="bg-surface rounded-card-lg shadow-card overflow-hidden">
          {ratings.length > 0 && (
            <RankingsHeader
              competition={contest.competition}
              title={showRanked ? 'Ranked players' : undefined}
              className="px-5 pt-1.5 pb-1"
            />
          )}
          {filteredRows.map((row, idx) => (
            <PlayerRow
              key={row.playerId}
              row={row}
              first={idx === 0 && ratings.length === 0}
              isUfa={isUfa}
              seasonYear={contest.seasonYear}
              playerLeague={contest.competitionDef.playerLeague}
              projections={projections}
              rosteredPct={rosteredPct?.get(`${contest.competitionDef.playerLeague}:${row.playerId}`)}
              canAdd={canAddDrop && row.isAvailable && !row.isMine && row.waiverAvailableAt == null}
              onOpenAdd={(playerId, playerName) => setDropSheetPlayer({ playerId, playerName })}
              canClaim={canAddDrop && row.waiverAvailableAt != null}
              onOpenClaim={(playerId, playerName) => setClaimPlayer({ playerId, playerName })}
              ownerHref={
                canViewOwner && !row.isMine && row.ownerTeamId != null
                  ? `/fantasy/l/${contest.id}/t/${row.ownerTeamId}`
                  : null
              }
            />
          ))}
          {showRanked && rankedShown < matchingRows.length && (
            <div className="border-t border-hairline px-5 py-3">
              <ShowMoreButton onClick={() => setRankedShown((n) => n + RANKED_PAGE_SIZE)} />
            </div>
          )}
        </div>
      )}

      {/* ── Add/Drop modal ────────────────────────────────────────────── */}
      {dropSheetPlayer && myTeam && (
        <DropModal
          contest={contest}
          addPlayer={dropSheetPlayer}
          myOwnership={myOwnership}
          onClose={() => setDropSheetPlayer(null)}
          onDone={async () => {
            setDropSheetPlayer(null);
            await revalidateFantasyLeague(contest.leagueId, contest.id).catch(() => null);
            const rows = await getTeamPlayers(contest.id, myTeam.id).catch(() => []);
            setMyOwnership(rows.map((r) => ({ playerId: r.playerId, playerName: r.playerName })));
            if (isDrafted) {
              const all = await getTeamPlayers(contest.id).catch(() => []);
              setAllOwnership(all.map((r) => ({ playerId: r.playerId, teamId: r.teamId })));
            }
          }}
        />
      )}

      {/* ── Waiver claim dialog ───────────────────────────────────────── */}
      {claimPlayer && myTeam && (
        <WaiverClaimDialog
          contest={contest}
          teamId={myTeam.id}
          addPlayer={claimPlayer}
          onClose={() => setClaimPlayer(null)}
          onDone={async () => {
            setClaimPlayer(null);
            await revalidateFantasyLeague(contest.leagueId, contest.id).catch(() => null);
          }}
        />
      )}
    </div>
  );
}

function SegmentButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'px-3.5 py-2 rounded-full font-tight text-[11.5px] font-bold tracking-[0.06em] uppercase transition-colors duration-150 cursor-pointer',
        active ? 'bg-accent text-accent-ink' : 'bg-ink/5 text-muted hover:bg-ink/10',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function PlayerRow({
  row,
  first,
  isUfa,
  seasonYear,
  playerLeague,
  projections,
  rosteredPct,
  canAdd,
  onOpenAdd,
  canClaim,
  onOpenClaim,
  ownerHref,
}: {
  row: Row;
  first: boolean;
  isUfa: boolean;
  seasonYear: number;
  playerLeague: string;
  projections: ProjectionMap | undefined;
  rosteredPct: number | undefined;
  canAdd: boolean;
  onOpenAdd: (playerId: string, playerName: string) => void;
  canClaim: boolean;
  onOpenClaim: (playerId: string, playerName: string) => void;
  /** The owning team's profile (proposing a trade happens there). */
  ownerHref: string | null;
}) {
  const [preview, setPreview] = useState<number | null>(null);

  useEffect(() => {
    if (!isUfa) return;
    let cancelled = false;
    playerSeasonPreview(row.playerId, 'offender', seasonYear)
      .then((pts) => !cancelled && setPreview(pts))
      .catch(() => !cancelled && setPreview(null));
    return () => {
      cancelled = true;
    };
  }, [row.playerId, isUfa, seasonYear]);

  const proj = projections
    ? projectedPoints(projections.get(projectionKey(playerLeague, row.playerId)), 'offender')
    : null;

  const nameBlock = (
    <div className="min-w-0 flex-1">
      {isUfa ? (
        <Link
          href={`/players/${row.playerId}`}
          prefetch={false}
          className="block font-tight text-[14px] font-semibold text-ink truncate hover:text-accent transition-colors duration-150 focus-visible:outline-none focus-visible:underline"
        >
          {row.fullName}
        </Link>
      ) : (
        <span className="block font-tight text-[14px] font-semibold text-ink truncate">{row.fullName}</span>
      )}
      {row.teamName && <span className="block font-tight text-[11.5px] text-muted truncate">{row.teamName}</span>}
      <RatingLine rating={row.rating} />
      <span className="block font-tight text-[10.5px] text-faint mt-0.5">{row.ownerLabel}</span>
      {rosteredPct != null && rosteredPct > 0 && (
        <span className="block font-tight text-[10.5px] text-faint mt-0.5">Rostered {rosteredPct}%</span>
      )}
      {row.waiverAvailableAt && (
        <span className="block font-tight text-[10.5px] text-faint mt-0.5">
          {waiverClearsLabel(row.waiverAvailableAt)}
        </span>
      )}
    </div>
  );

  return (
    <div className={['flex items-center gap-3 px-5 py-3', !first ? 'border-t border-hairline' : ''].join(' ')}>
      {nameBlock}
      {isUfa && preview != null && (
        <div className="flex-shrink-0 text-right">
          <span className="font-tight text-[13px] font-bold tabular text-ink">{preview}</span>
          <span className="font-tight text-[9.5px] text-faint ml-1">pts</span>
          {projections && (
            <span className="block font-tight text-[10.5px] text-faint mt-0.5">
              {proj != null ? `Proj ${proj}` : 'Proj —'}
            </span>
          )}
        </div>
      )}
      {canAdd && (
        <button
          type="button"
          onClick={() => onOpenAdd(row.playerId, row.fullName)}
          className={[
            'flex-shrink-0 px-4 py-2 rounded-full min-h-[36px]',
            'bg-accent text-accent-ink font-tight text-[11px] font-bold tracking-[0.04em] uppercase',
            'hover:opacity-90 transition-opacity duration-150 cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          ].join(' ')}
        >
          Add
        </button>
      )}
      {canClaim && (
        <button
          type="button"
          onClick={() => onOpenClaim(row.playerId, row.fullName)}
          className={[
            'flex-shrink-0 px-4 py-2 rounded-full min-h-[36px]',
            'bg-accent text-accent-ink font-tight text-[11px] font-bold tracking-[0.04em] uppercase',
            'hover:opacity-90 transition-opacity duration-150 cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          ].join(' ')}
        >
          Claim
        </button>
      )}
      {ownerHref && (
        <Link
          href={ownerHref}
          className={[
            'flex-shrink-0 inline-flex items-center px-4 py-2 rounded-full min-h-[36px] no-underline',
            'bg-ink/5 text-ink font-tight text-[11px] font-bold tracking-[0.04em] uppercase',
            'hover:bg-ink/10 transition-colors duration-150 cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          ].join(' ')}
        >
          View team
        </Link>
      )}
    </div>
  );
}

function DropModal({
  contest,
  addPlayer,
  myOwnership,
  onClose,
  onDone,
}: {
  contest: ContestView;
  addPlayer: { playerId: string; playerName: string };
  myOwnership: { playerId: string; playerName: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const league = contest.competitionDef.playerLeague;

  const handleDrop = async (dropPlayerId: string, dropPlayerName: string) => {
    setSaving(dropPlayerId);
    setError(null);
    try {
      await addDrop(
        contest.id,
        { playerLeague: league, playerId: dropPlayerId, playerName: dropPlayerName },
        { playerLeague: league, playerId: addPlayer.playerId, playerName: addPlayer.playerName },
      );
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete the swap.');
      setSaving(null);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="drop-modal-title"
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-ink/40 backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-[440px] max-h-[75%] overflow-y-auto bg-surface rounded-t-card-lg sm:rounded-card-lg shadow-hero">
        <div className="flex items-center justify-between gap-4 px-6 pt-5 pb-3">
          <span id="drop-modal-title" className="font-tight text-[15px] font-bold text-ink">
            Drop who?
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cancel"
            className={[
              'w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0',
              'text-faint hover:text-ink hover:bg-ink/5 transition-colors duration-150 cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            ].join(' ')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <p className="px-6 pb-3 font-tight text-[12.5px] text-muted">
          Adding {addPlayer.playerName} — choose a player to drop from your roster.
        </p>
        {error && <p className="px-6 pb-2 font-tight text-[12px] text-live">{error}</p>}
        <div className="pb-6">
          {myOwnership.map((p, idx) => (
            <button
              key={p.playerId}
              type="button"
              onClick={() => void handleDrop(p.playerId, p.playerName)}
              disabled={saving != null}
              className={[
                'w-full flex items-center gap-3 px-6 py-3 text-left cursor-pointer',
                'hover:bg-surface-hi transition-colors duration-150',
                idx > 0 ? 'border-t border-hairline' : '',
                'focus-visible:outline-none focus-visible:bg-surface-hi',
              ].join(' ')}
            >
              <span className="flex-1 font-tight text-[14px] font-medium text-ink">{p.playerName}</span>
              {saving === p.playerId && (
                <div className="w-4 h-4 rounded-full border-2 border-ink/15 border-t-accent animate-spin" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default PlayersPanel;
