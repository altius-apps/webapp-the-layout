'use client';

// Draft Room — shared client island rendered by the canonical in-league
// route (/fantasy/l/[contestId]/draft). Draft state comes exclusively from
// src/lib/fantasy/draft-room.ts (the frozen backend contract — P2,
// 2026-08-27; auction + readiness/reschedule added 2026-09-08); nothing here
// talks to fantasy_drafts / fantasy_draft_picks / fantasy_draft_queues
// directly.
//
// Layout (Sleeper-style, Hunter 2026-10-12): a full-screen surface over the page
// under the app's top rail (RoomFrame). Slim top bar — X, status eyebrow
// over the league name, gear (autodraft, commissioner link) — then a compact
// header strip for the live pick clock, the board filling the screen, and a
// bottom sheet (Players / Queue / Team / Chat) that drags up and down over it
// (RoomStage). The league header + nav are left out of the page on this route
// (LeagueChrome), and the bottom nav and footer aren't rendered (isDraftRoomPath).
// The room must mount once per page: the realtime client caches channels by
// topic, so a second copy's subscribe would cut the first one's live updates.
//
// Gate (before any room renders — mirrors mobile DraftRoom.tsx):
//   No draft row → "No draft scheduled yet" (+ commissioner settings link).
//   scheduled AND >4h out → countdown card, no room.
//   Otherwise → dispatch by draft.status + draft.draftType, all inside the same
//     frame on the app's light/dark tokens (the auction room renders in it too).
//
// State machine (draft.status, from the contract):
//   scheduled → lobby: countdown to scheduledAt (or "starts whenever"),
//     readiness warning strip, commissioner Start Now (replaced by "Drafts open
//     <date>" until the server's window opens); snake also previews the empty
//     draft board. Players and Queue stay closed until the room goes live; Team
//     shows the draft order.
//   live → the room: snake (clock strip, the draft board, the sheet) or auction
//     (nominate/bid stage, budgets on the board, the sheet).
//   complete → summary: the board and each team's haul in the Team tab (+
//     auction prices). Viewers who watched it end also get a strip counting down
//     to the league page; anyone opening it later just stays on the board.
//
// Clock resolution: any open client can call resolveDraftClock() /
// resolveAuction() once a clock is CLOCK_GRACE_MS past 0 (the server's own
// grace; earlier calls are told "not yet") — server-side first-caller-wins, so
// no coordination is needed beyond a small random jitter to avoid every open
// tab firing at once. A 10-second server tick backs this up, so drafts run on
// with nobody in the room. There is no pause (Hunter, 2026-10-08).
//
// Realtime: subscribeDraft() (snake) or subscribeAuction() (auction)
// refetches on relevant table changes; also refetches on window focus and
// polls every 20s while live as a fallback. Queue is loaded once
// (owner-private) and saved via a debounced saveDraftQueue call.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-provider';
import { AuthModal } from '@/components/auth/auth-modal';
import { getMyLeagueRole } from '@/lib/fantasy/leagues';
import {
  getDraft,
  getDraftPicks,
  getMyDraftQueue,
  getDraftReadiness,
  getOpenNomination,
  getNominations,
  getDraftPrices,
  getAutodraftTeamIds,
  startDraft,
  makeDraftPick,
  resolveDraftClock,
  resolveAuction,
  saveDraftQueue,
  subscribeDraft,
  subscribeAuction,
  unsubscribeDraft,
  teamOnClock,
  roundOf,
  CLOCK_GRACE_MS,
  type Draft,
  type DraftPick,
  type DraftRef,
  type DraftReadiness,
  type DraftNomination,
  type DraftPrice,
} from '@/lib/fantasy/draft-room';
import { searchContestPlayers } from '@/lib/fantasy/draft';
import { getMyContestTeam, type ContestView } from '@/lib/fantasy/leagues';
import type { FantasyPlayerHit } from '@/lib/fantasy/data';
import { getContestRatings, ratingKey, toRatingMap, type PlayerRating } from '@/lib/fantasy/ratings';
import { AuctionBoard, AuctionRoom } from './draft/auction-room';
import { RoomFrame, RoomGate } from './draft/room-frame';
import { RoomStage, SheetClock, type SheetControl, type SheetSnap } from './draft/room-sheet';
import { RoomPanel, type RoomPanelContext } from './draft/room-panels';
import type { RoomTab } from './draft/room-tabs';
import { AutoBadge, AutodraftToggle } from './draft/autodraft';
import {
  CrosshairIcon,
  DraftBoard,
  TeamAvatar,
  formatClock,
  pickLabel,
  snakeCell,
  toneForRank,
  type BoardCell,
  type BoardColumn,
} from './draft/draft-board';
import {
  RANKED_PAGE_SIZE,
  RankingsHeader,
  RatingLine,
  RatingRowLine,
  ShowMoreButton,
  ratingToHit,
} from './player-rating';

interface TeamInfo {
  id: string;
  teamName: string;
  ownerDisplayName: string | null;
  ownerUsername: string | null;
}

interface Props {
  contest: ContestView;
  /** The league's name, as the league header shows it. */
  leagueName: string;
  /** Every team in this contest — needed to render names on the board/ticker
   *  and to resolve "team on the clock" to a display name. */
  teams: TeamInfo[];
  /** Where "back" / standings / team links point. */
  basePath: string;
}

const ROOM_OPENS_BEFORE_MS = 4 * 60 * 60 * 1000; // 4 hours
const RATINGS_REFRESH_MS = 5 * 60 * 1000;
const FRESH_PICK_MS = 4000; // how long the "pick is in" banner and slam stay up

function formatDraftTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDraftDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function DraftRoom({ contest, leagueName, teams, basePath }: Props) {
  const { user, loading: authLoading } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [picks, setPicks] = useState<DraftPick[]>([]);
  const [openNomination, setOpenNomination] = useState<DraftNomination | null>(null);
  const [nominations, setNominations] = useState<DraftNomination[]>([]);
  const [prices, setPrices] = useState<DraftPrice[]>([]);
  // Teams on autodraft. The teams prop is static, so this is re-read with
  // every refetch.
  const [autodraftTeamIds, setAutodraftTeamIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<DraftReadiness | null>(null);
  // Only a viewer who watched the draft end is sent back to the league; anyone
  // who opens a finished draft stays on the board (Hunter, 2026-10-13).
  const [sawLive, setSawLive] = useState(false);
  useEffect(() => {
    if (draft?.status === 'live') setSawLive(true);
  }, [draft?.status]);

  const [myTeam, setMyTeam] = useState<TeamInfo | null>(null);
  const [queue, setQueue] = useState<DraftRef[]>([]);
  const [ratings, setRatings] = useState<PlayerRating[]>([]);
  // The sheet. Until the viewer picks a tab it follows the draft: the draft order
  // in the lobby, the player list once live, the hauls when it's over.
  const [pickedTab, setPickedTab] = useState<RoomTab | null>(null);
  const [snap, setSnap] = useState<SheetSnap>('peek');
  const [isCommissioner, setIsCommissioner] = useState(false);

  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const draftedByKey = useMemo(
    () => new Map(picks.map((p) => [`${p.playerLeague}:${p.playerId}`, p.teamId])),
    [picks],
  );

  const refetch = useCallback(async () => {
    try {
      const d = await getDraft(contest.id);
      setLoadError(null);
      setDraft(d);
      if (!d) {
        setPicks([]);
        setOpenNomination(null);
        setNominations([]);
        return;
      }
      const isAuction = d.draftType === 'auction';
      const [p, open, noms, auto] = await Promise.all([
        getDraftPicks(d.id),
        isAuction ? getOpenNomination(d.id) : Promise.resolve(null),
        isAuction ? getNominations(d.id) : Promise.resolve([]),
        getAutodraftTeamIds(contest.id),
      ]);
      setPicks(p);
      setOpenNomination(open);
      setNominations(noms);
      setAutodraftTeamIds(auto);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load the draft.');
    }
  }, [contest.id]);

  // ── Initial load ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const d = await getDraft(contest.id);
        if (cancelled) return;
        setDraft(d);
        if (d) {
          const isAuction = d.draftType === 'auction';
          const [p, open, noms, auto] = await Promise.all([
            getDraftPicks(d.id),
            isAuction ? getOpenNomination(d.id) : Promise.resolve(null),
            isAuction ? getNominations(d.id) : Promise.resolve([]),
            getAutodraftTeamIds(contest.id),
          ]);
          if (cancelled) return;
          setPicks(p);
          setOpenNomination(open);
          setNominations(noms);
          setAutodraftTeamIds(auto);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not load the draft.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contest.id]);

  // ── Draft readiness (lobby warning strip) ─────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    getDraftReadiness(contest.id)
      .then((r) => {
        if (!cancelled) setReadiness(r);
      })
      .catch(() => {
        if (!cancelled) setReadiness(null);
      });
    return () => {
      cancelled = true;
    };
  }, [contest.id]);

  // ── Auction suggested prices ─────────────────────────────────────────────
  useEffect(() => {
    if (!draft || draft.draftType !== 'auction') {
      setPrices([]);
      return;
    }
    let cancelled = false;
    getDraftPrices(draft.id)
      .then((p) => {
        if (!cancelled) setPrices(p);
      })
      .catch(() => {
        if (!cancelled) setPrices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [draft?.id, draft?.draftType]);

  // ── Player ratings (the ranked list; [] for weekly contests) ─────────────
  // Re-read during a live draft: a rebuild (weekly or by hand) can reorder the list, and
  // autodraft always takes the current order. A failed re-read keeps the list.
  const draftLive = draft?.status === 'live';
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getContestRatings(contest)
        .then((r) => {
          if (!cancelled) setRatings(r);
        })
        .catch(() => {});
    load();
    const timer = draftLive ? setInterval(load, RATINGS_REFRESH_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contest.id, draftLive]);

  // ── My team ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) {
      setMyTeam(null);
      return;
    }
    getMyContestTeam(contest.id)
      .then((t) => setMyTeam(t ? teamById.get(t.id) ?? { ...t, ownerDisplayName: null, ownerUsername: null } : null))
      .catch(() => setMyTeam(null));
  }, [user, contest.id, teamById]);

  // ── My queue (owner-private) ────────────────────────────────────────────
  useEffect(() => {
    if (!draft || !myTeam) {
      setQueue([]);
      return;
    }
    getMyDraftQueue(draft.id)
      .then(setQueue)
      .catch(() => setQueue([]));
  }, [draft?.id, myTeam?.id]);

  // ── Commissioner role (drives the lobby's Start Now button) ─────────────
  useEffect(() => {
    if (!user) {
      setIsCommissioner(false);
      return;
    }
    getMyLeagueRole(contest.leagueId)
      .then((role) => setIsCommissioner(role === 'commissioner'))
      .catch(() => setIsCommissioner(false));
  }, [user, contest.leagueId]);

  // ── Realtime subscription — snake vs auction wiring differs ─────────────
  useEffect(() => {
    if (!draft) return;
    const isAuction = draft.draftType === 'auction';
    // An autodraft run lands several picks at once; refetch once per burst.
    let pending: ReturnType<typeof setTimeout> | null = null;
    const onChange = () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        refetch();
      }, 250);
    };
    const channel = isAuction ? subscribeAuction(draft.id, onChange) : subscribeDraft(draft.id, onChange);
    const onFocus = () => refetch();
    window.addEventListener('focus', onFocus);
    return () => {
      if (pending) clearTimeout(pending);
      unsubscribeDraft(channel);
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, draft?.draftType]);

  // ── Poll fallback every 20s while live ───────────────────────────────────
  useEffect(() => {
    if (draft?.status !== 'live') return;
    const id = setInterval(() => refetch(), 20_000);
    return () => clearInterval(id);
  }, [draft?.status, refetch]);

  // ── Clock resolution (snake pick, auction nomination or bid) ────────────
  // One timer per running clock, set for its deadline + the server's grace + a
  // little jitter. It re-arms only when the clock itself changes (a new pick,
  // a bid that pushes the deadline), never on a render tick — a timer that
  // re-arms every tick gets cancelled before it fires.
  const clockDeadline =
    !draft || draft.status !== 'live'
      ? null
      : draft.draftType === 'auction'
        ? openNomination
          ? new Date(openNomination.endsAt).getTime()
          : draft.currentStartedAt
            ? new Date(draft.currentStartedAt).getTime() + draft.nominationSeconds * 1000
            : null
        : draft.currentStartedAt
          ? new Date(draft.currentStartedAt).getTime() + draft.pickSeconds * 1000
          : null;
  const liveDraftId = draft?.id ?? null;
  const isAuctionDraft = draft?.draftType === 'auction';
  useEffect(() => {
    if (!liveDraftId || clockDeadline === null) return;
    const fireIn = clockDeadline + CLOCK_GRACE_MS + 200 + Math.random() * 800 - Date.now();
    const t = setTimeout(() => {
      (isAuctionDraft ? resolveAuction(liveDraftId) : resolveDraftClock(liveDraftId)).then(refetch).catch(() => {});
    }, Math.max(0, fireIn));
    return () => clearTimeout(t);
  }, [liveDraftId, isAuctionDraft, clockDeadline, refetch]);

  const bidRemainingMs = useDeadlineRemaining(openNomination?.endsAt ?? null);
  const nominationRemainingMs = useClockRemaining(
    draft?.draftType === 'auction' && draft.status === 'live' && !openNomination ? draft.currentStartedAt : null,
    draft?.nominationSeconds ?? 30,
  );

  // ── document.title prefix — on the clock (snake), nominating, or high
  // bidder (auction) ────────────────────────────────────────────────────────
  const onClockTeamId = draft && draft.status === 'live' && draft.draftType === 'snake' ? teamOnClock(draft) : null;
  const isMyClock = !!myTeam && onClockTeamId === myTeam.id;
  const nominatingTeamId = draft && draft.status === 'live' && draft.draftType === 'auction' ? draft.draftOrder[((draft.currentOverall - 1) % Math.max(draft.draftOrder.length, 1) + draft.draftOrder.length) % Math.max(draft.draftOrder.length, 1)] : null;
  const isMyNominateTurn = !!myTeam && !openNomination && nominatingTeamId === myTeam.id;
  const isMyHighBid = !!myTeam && !!openNomination && openNomination.highTeamId === myTeam.id;
  const titlePrefix = isMyClock
    ? '● Your pick'
    : isMyNominateTurn
      ? "● You're nominating"
      : isMyHighBid
        ? '● High bidder'
        : null;
  useEffect(() => {
    const original = document.title.replace(/^● [^—]+ — /, '');
    if (titlePrefix) document.title = `${titlePrefix} — ${original}`;
    else document.title = original;
    return () => {
      document.title = original;
    };
  }, [titlePrefix]);

  // Snake only: an auction win isn't "a pick" (the auction room has its own moment).
  const freshPick = useFreshPick(picks, !loading && draft?.draftType === 'snake');

  // With a player on the block the auction stage is what matters, so a sheet at
  // peek drops to its tab bar when a nomination opens.
  const nominationId = openNomination?.id ?? null;
  const seenNomination = useRef<string | null>(null);
  useEffect(() => {
    if (nominationId && nominationId !== seenNomination.current) setSnap((s) => (s === 'peek' ? 'min' : s));
    seenNomination.current = nominationId;
  }, [nominationId]);

  const signedOut = !authLoading && !user;
  const tab: RoomTab = pickedTab ?? (draft?.status === 'live' ? 'players' : 'team');
  const sheet: SheetControl = { tab, snap, setTab: setPickedTab, setSnap };
  const openTab = (t: RoomTab) => {
    setPickedTab(t);
    setSnap((s) => (s === 'min' ? 'peek' : s));
  };

  const autodraftToggle =
    myTeam && draft && draft.status !== 'complete' ? (
      <AutodraftToggle
        draftId={draft.id}
        on={autodraftTeamIds.has(myTeam.id)}
        onChanged={(next) => {
          setAutodraftTeamIds((prev) => {
            const updated = new Set(prev);
            if (next) updated.add(myTeam.id);
            else updated.delete(myTeam.id);
            return updated;
          });
          refetch();
        }}
      />
    ) : null;

  // Every state wears the same frame, gates included.
  const frame = (eyebrow: string, body: React.ReactNode) => (
    <RoomFrame
      eyebrow={eyebrow}
      title={leagueName}
      exitHref={basePath}
      autoOn={!!myTeam && !!autodraftToggle && autodraftTeamIds.has(myTeam.id)}
      menu={
        <RoomMenu
          autodraft={autodraftToggle}
          settingsHref={isCommissioner ? `${basePath}/settings` : null}
          signedOut={signedOut}
          onSignIn={() => setAuthOpen(true)}
        />
      }
    >
      {body}
      <AuthModal
        open={authOpen}
        dismissible
        initialMode="signin"
        onDismiss={() => setAuthOpen(false)}
        headline="Sign in to draft"
        subhead="You need a team in this league to make picks."
      />
    </RoomFrame>
  );

  if (loading) {
    return frame(
      'Draft room',
      <div className="px-3 py-4 lg:px-5">
        <RoomSkeleton />
      </div>,
    );
  }

  if (loadError) {
    return frame(
      'Draft room',
      <RoomGate>
        <div className="bg-surface rounded-card-lg shadow-card p-10 text-center">
          <p className="text-muted font-tight text-[14px]">{loadError}</p>
        </div>
      </RoomGate>,
    );
  }

  // ── Gate: no draft scheduled yet ─────────────────────────────────────────
  if (!draft) {
    return frame(
      'No draft yet',
      <RoomGate>
        <div className="bg-surface rounded-card-lg shadow-card p-10 text-center">
          <p className="text-muted font-tight text-[14px]">No draft scheduled yet.</p>
          {isCommissioner && (
            <Link
              href={`${basePath}/draft/setup`}
              className="inline-flex items-center gap-1.5 mt-4 text-accent font-tight text-[13px] font-bold hover:opacity-80 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
            >
              Set up the draft
            </Link>
          )}
        </div>
      </RoomGate>,
    );
  }

  // ── Gate: room opens 4h before scheduledAt ───────────────────────────────
  const opensSoon =
    draft.status === 'scheduled' &&
    draft.scheduledAt != null &&
    new Date(draft.scheduledAt).getTime() - Date.now() > ROOM_OPENS_BEFORE_MS;

  if (opensSoon && draft.scheduledAt) {
    return frame(
      'Room opens soon',
      <RoomGate>
        <RoomOpensSoonCard scheduledAt={draft.scheduledAt} />
      </RoomGate>,
    );
  }

  const teamCount = draft.draftOrder.length;
  const snake = draft.draftType === 'snake';
  const panelCtx: RoomPanelContext = {
    contest,
    draft,
    teams,
    picks,
    ratings,
    myTeamId: myTeam?.id ?? null,
    basePath,
    signedOut,
    onRequireAuth: () => setAuthOpen(true),
    onExpand: () => setSnap('full'),
  };
  const noPlayerPanels = (t: RoomTab, collapsed: boolean) => (
    <RoomPanel {...panelCtx} tab={t} collapsed={collapsed} players={null} queue={null} />
  );
  const freshTeamName = freshPick ? teamById.get(freshPick.teamId)?.teamName ?? 'Team' : '';
  const freshLabel = freshPick ? pickLabel(freshPick.overall, teamCount) : '';

  const eyebrow =
    draft.status === 'scheduled'
      ? 'Draft lobby'
      : draft.status === 'complete'
        ? 'Draft complete!'
        : snake
          ? `Round ${roundOf(draft.currentOverall, teamCount)} · Pick ${pickLabel(draft.currentOverall, teamCount)}`
          : openNomination
            ? 'Bidding'
            : 'Nominating';

  return frame(
    eyebrow,
    <>
      {/* Always mounted so the text change is announced; the banner is the sighted copy. */}
      <p className="sr-only" aria-live="polite">
        {freshPick && `Pick ${freshLabel}: ${freshTeamName} selects ${freshPick.playerName}`}
      </p>
      {freshPick && (
        <PickBanner
          key={freshPick.overall}
          label={freshLabel}
          teamName={freshTeamName}
          playerName={freshPick.playerName}
        />
      )}

      {draft.status === 'scheduled' && (
        <RoomStage sheet={sheet} renderPanel={noPlayerPanels}>
          {snake && teamCount > 0 ? (
            <SnakeBoard
              draft={draft}
              picks={picks}
              teamById={teamById}
              ratings={ratings}
              myTeamId={myTeam?.id ?? null}
              before={
                <LobbyPanel
                  draft={draft}
                  teams={teams}
                  isCommissioner={isCommissioner}
                  readiness={readiness}
                  onStarted={refetch}
                />
              }
            />
          ) : (
            <RoomScroll>
              <LobbyPanel
                draft={draft}
                teams={teams}
                isCommissioner={isCommissioner}
                readiness={readiness}
                onStarted={refetch}
              />
            </RoomScroll>
          )}
        </RoomStage>
      )}

      {draft.status === 'live' && !snake && (
        <AuctionRoom
          contest={contest}
          draft={draft}
          picks={picks}
          teamById={teamById}
          myTeam={myTeam}
          queue={queue}
          setQueue={setQueue}
          ratings={ratings}
          openNomination={openNomination}
          nominations={nominations}
          prices={prices}
          bidRemainingMs={bidRemainingMs}
          nominationRemainingMs={nominationRemainingMs}
          autodraftTeamIds={autodraftTeamIds}
          sheet={sheet}
          panelCtx={panelCtx}
          onPickPlayer={() => openTab('players')}
          refetch={refetch}
        />
      )}

      {draft.status === 'live' && snake && (
        <LiveRoom
          draft={draft}
          picks={picks}
          teamById={teamById}
          draftedByKey={draftedByKey}
          myTeam={myTeam}
          isMyClock={isMyClock}
          autodraftTeamIds={autodraftTeamIds}
          queue={queue}
          setQueue={setQueue}
          ratings={ratings}
          freshOverall={freshPick?.overall ?? null}
          sheet={sheet}
          panelCtx={panelCtx}
          refetch={refetch}
        />
      )}

      {draft.status === 'complete' && (
        <RoomStage
          sheet={sheet}
          header={sawLive ? <CompleteStrip draft={draft} basePath={basePath} /> : undefined}
          renderPanel={noPlayerPanels}
        >
          {snake ? (
            <SnakeBoard
              draft={draft}
              picks={picks}
              teamById={teamById}
              ratings={ratings}
              myTeamId={myTeam?.id ?? null}
              freshOverall={freshPick?.overall ?? null}
            />
          ) : (
            <AuctionBoard
              draft={draft}
              picks={picks}
              teamById={teamById}
              ratingMap={toRatingMap(ratings)}
              myTeamId={myTeam?.id ?? null}
              liveBidByTeam={new Map()}
              highTeamId={null}
              autodraftTeamIds={autodraftTeamIds}
              sold={null}
            />
          )}
        </RoomStage>
      )}
    </>,
  );
}

/** The gear popover: autodraft, the commissioner's link, or what a viewer can do. */
function RoomMenu({
  autodraft,
  settingsHref,
  signedOut,
  onSignIn,
}: {
  autodraft: React.ReactNode;
  settingsHref: string | null;
  signedOut: boolean;
  onSignIn: () => void;
}) {
  const empty = !autodraft && !settingsHref;
  return (
    <div className="space-y-4">
      <p className="m-0 font-tight text-[10.5px] font-bold uppercase tracking-[0.16em] text-muted">Draft settings</p>
      {autodraft}
      {settingsHref && (
        <Link
          href={settingsHref}
          className="flex min-h-[44px] items-center justify-between gap-3 rounded-card-sm bg-ink/[0.05] px-3.5 font-tight text-[13px] font-bold text-ink transition-colors duration-150 hover:bg-ink/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          League settings
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      )}
      {empty &&
        (signedOut ? (
          <>
            <p className="m-0 font-tight text-[12.5px] leading-snug text-muted">
              Sign in to draft, build a queue and set autodraft.
            </p>
            <button
              type="button"
              onClick={onSignIn}
              className="inline-flex min-h-[44px] cursor-pointer items-center justify-center rounded-full bg-accent px-5 font-tight text-[12px] font-bold uppercase tracking-[0.08em] text-accent-ink transition-opacity duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Sign in
            </button>
          </>
        ) : (
          <p className="m-0 font-tight text-[12.5px] leading-snug text-muted">You&apos;re watching this draft.</p>
        ))}
    </div>
  );
}

/** A body that isn't a board (the auction lobby) but still scrolls clear of the sheet. */
function RoomScroll({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto overscroll-contain px-3 pt-3 pb-[calc(var(--sheet-peek,20rem)+1rem)] lg:px-5">
      {children}
    </div>
  );
}

// ─── Gate: room opens soon ──────────────────────────────────────────────────

function RoomOpensSoonCard({ scheduledAt }: { scheduledAt: string }) {
  const countdown = useCountdown(scheduledAt);
  return (
    <div className="bg-surface rounded-card-lg shadow-card p-10 text-center">
      <div className="text-[10.5px] font-bold tracking-[0.16em] uppercase text-accent mb-2.5 font-tight">
        Draft room opens 4 hours before the draft
      </div>
      <h2 className="font-display italic text-[28px] lg:text-[34px] font-bold tracking-[-0.02em] leading-[0.95] text-ink mb-2">
        {countdown}
      </h2>
      <p className="text-muted font-tight text-[13px]">{formatDraftTime(scheduledAt)}</p>
    </div>
  );
}

// ─── Pick-is-in moment ───────────────────────────────────────────────────────

/** The newest pick for FRESH_PICK_MS after it lands while the room is open.
 *  Silent on first load, on refetches that bring no new pick, and after an
 *  undo (the top pick drops, so the re-pick counts as new). */
function useFreshPick(picks: DraftPick[], enabled: boolean): DraftPick | null {
  const [fresh, setFresh] = useState<DraftPick | null>(null);
  const topSeen = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      topSeen.current = null;
      return;
    }
    let top: DraftPick | null = null;
    for (const p of picks) if (!top || p.overall > top.overall) top = p;
    const prev = topSeen.current;
    topSeen.current = top ? top.overall : 0;
    if (prev !== null && top && top.overall > prev) setFresh(top);
  }, [picks, enabled]);

  // Its own effect: every refetch hands over a new picks array, which would
  // cancel a timer owned by the effect above and leave the banner stuck.
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => setFresh(null), FRESH_PICK_MS);
    return () => clearTimeout(t);
  }, [fresh]);

  return fresh;
}

function PickBanner({ label, teamName, playerName }: { label: string; teamName: string; playerName: string }) {
  return (
    <div
      aria-hidden="true"
      // A toast over the board (under the top bar), so the board doesn't jump on every pick.
      className="absolute inset-x-3 top-3 z-50 mx-auto max-w-xl flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3 rounded-card bg-surface-hi shadow-hero px-4 py-3 motion-safe:animate-fade-up"
    >
      <span className="flex-shrink-0 font-tight text-[10.5px] font-extrabold tracking-[0.16em] uppercase text-accent">
        The pick is in
      </span>
      <span className="min-w-0 font-tight text-[14px] lg:text-[15px] text-ink">
        <span className="font-bold tabular">{label}</span>
        {' · '}
        {teamName} selects <span className="font-extrabold">{playerName}</span>
      </span>
    </div>
  );
}

// ─── Lobby (scheduled) ────────────────────────────────────────────────────────

function settingsLine(draft: Draft): string {
  if (draft.draftType === 'auction') {
    return `Auction · $${draft.budget} budget · ${draft.rounds} roster spots · ${draft.nominationSeconds}s to nominate · ${draft.bidSeconds}s bids`;
  }
  return `Snake · ${draft.rounds} rounds · ${draft.pickSeconds}s clock`;
}

function LobbyPanel({
  draft,
  teams,
  isCommissioner,
  readiness,
  onStarted,
}: {
  draft: Draft;
  teams: TeamInfo[];
  isCommissioner: boolean;
  readiness: DraftReadiness | null;
  onStarted: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const countdown = useCountdown(draft.scheduledAt);

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    try {
      await startDraft(draft.id);
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the draft.');
    } finally {
      setStarting(false);
    }
  };

  const orderKnown = draft.draftOrder.length > 0;
  // The server refuses start_draft until the window opens, so don't offer it.
  const opensAt =
    readiness?.earliestAt && new Date(readiness.earliestAt).getTime() > Date.now() ? readiness.earliestAt : null;

  return (
    <div className="bg-surface rounded-card-lg shadow-card p-6 lg:p-8 text-center lg:mx-auto lg:max-w-xl">
      <h2 className="font-display italic text-[28px] lg:text-[34px] font-bold tracking-[-0.02em] leading-[0.95] text-ink mb-3">
        {draft.scheduledAt ? countdown : 'Starts whenever the commissioner is ready'}
      </h2>
      <p className="text-muted font-tight text-[13px] mb-6">
        {settingsLine(draft)}
        {orderKnown ? ' — order re-shuffles when the draft starts.' : ''}
      </p>

      {readiness && !readiness.rostersReady && (
        <p className="max-w-md mx-auto mb-5 px-4 py-3 rounded-card-sm bg-live/10 text-live font-tight text-[12.5px] leading-[1.4]" role="alert">
          Rosters not set on {readiness.sourceLabel} — draft will be another day.
        </p>
      )}
      {readiness?.missed && (
        <p className="max-w-md mx-auto mb-5 px-4 py-3 rounded-card-sm bg-live/10 text-live font-tight text-[12.5px] leading-[1.4]" role="alert">
          This draft&apos;s scheduled time has passed. The commissioner needs to reschedule it.
        </p>
      )}

      {orderKnown && (
        <ol className="max-w-md mx-auto mb-6 grid grid-cols-2 gap-1.5 text-left">
          {draft.draftOrder.map((teamId, idx) => (
            <li
              key={teamId}
              className="flex min-w-0 items-center gap-2.5 px-3 py-2 rounded-card-sm bg-ink/[0.04]"
            >
              <span className="font-tight text-[12px] font-bold text-faint tabular w-5 text-right">{idx + 1}</span>
              <span className="font-tight text-[13px] font-semibold text-ink truncate">
                {teams.find((t) => t.id === teamId)?.teamName ?? 'Team'}
              </span>
            </li>
          ))}
        </ol>
      )}

      {opensAt ? (
        <p className="inline-flex items-center px-4 py-2 rounded-full bg-ink/[0.06] text-muted font-tight text-[12px] font-bold tracking-[0.08em] uppercase">
          Drafts open {formatDraftDate(opensAt)}
        </p>
      ) : (
        isCommissioner && (
          <button
            type="button"
            onClick={handleStart}
            disabled={starting}
            className={[
              'inline-flex items-center justify-center gap-2 px-7 py-3 rounded-full min-h-[44px]',
              'bg-accent text-accent-ink font-tight text-[13px] font-bold tracking-[0.08em] uppercase',
              'hover:opacity-90 transition-opacity duration-150 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
            ].join(' ')}
          >
            {starting ? 'Starting…' : 'Start now'}
          </button>
        )
      )}
      {error && <p className="mt-3 text-[12px] text-live font-tight" role="alert">{error}</p>}
    </div>
  );
}

function useCountdown(iso: string | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [iso]);
  if (!iso) return '';
  const target = new Date(iso).getTime();
  const diffMs = target - now;
  if (diffMs <= 0) return 'Starting soon';
  const totalSec = Math.floor(diffMs / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

// ─── Live room ────────────────────────────────────────────────────────────────

function LiveRoom({
  draft,
  picks,
  teamById,
  draftedByKey,
  myTeam,
  isMyClock,
  autodraftTeamIds,
  queue,
  setQueue,
  ratings,
  freshOverall,
  sheet,
  panelCtx,
  refetch,
}: {
  draft: Draft;
  picks: DraftPick[];
  teamById: Map<string, TeamInfo>;
  draftedByKey: Map<string, string>;
  myTeam: TeamInfo | null;
  isMyClock: boolean;
  autodraftTeamIds: Set<string>;
  queue: DraftRef[];
  setQueue: (q: DraftRef[]) => void;
  ratings: PlayerRating[];
  freshOverall: number | null;
  sheet: SheetControl;
  panelCtx: RoomPanelContext;
  refetch: () => void;
}) {
  const onClockTeamId = teamOnClock(draft);
  const onClockTeam = onClockTeamId ? teamById.get(onClockTeamId) : null;

  // Display only — DraftRoom's clock timer resolves an expired pick.
  const remainingMs = useClockRemaining(draft.currentStartedAt, draft.pickSeconds);
  const sec = remainingMs === null ? draft.pickSeconds : Math.max(0, Math.ceil(remainingMs / 1000));
  const [jump, setJump] = useState(0);

  return (
    <RoomStage
      sheet={sheet}
      header={
        <ClockStrip
          draft={draft}
          sec={sec}
          remainingMs={remainingMs}
          onClockTeamId={onClockTeamId}
          onClockTeamName={onClockTeam?.teamName ?? 'Team'}
          onClockAuto={!!onClockTeamId && autodraftTeamIds.has(onClockTeamId)}
          isMyClock={isMyClock}
          myTeamId={myTeam?.id ?? null}
          onJump={() => setJump((n) => n + 1)}
        />
      }
      status={<SheetClock label={isMyClock ? 'Your pick' : 'On the clock'} value={formatClock(sec)} urgent={sec <= 10} />}
      renderPanel={(tab, collapsed) => (
        <RoomPanel
          {...panelCtx}
          tab={tab}
          collapsed={collapsed}
          players={
            <PlayersPanel
              contest={panelCtx.contest}
              draft={draft}
              draftedByKey={draftedByKey}
              teamById={teamById}
              myTeam={myTeam}
              isMyClock={isMyClock}
              queue={queue}
              setQueue={setQueue}
              ratings={ratings}
              onRequireAuth={panelCtx.onRequireAuth}
              refetch={refetch}
            />
          }
          queue={
            <QueuePanel
              draft={draft}
              myTeam={myTeam}
              queue={queue}
              setQueue={setQueue}
              ratings={ratings}
              onRequireAuth={panelCtx.onRequireAuth}
            />
          }
        />
      )}
    >
      <SnakeBoard
        draft={draft}
        picks={picks}
        teamById={teamById}
        ratings={ratings}
        myTeamId={myTeam?.id ?? null}
        autodraftTeamIds={autodraftTeamIds}
        clock={{
          remainingSec: remainingMs === null ? null : sec,
          mine: isMyClock,
        }}
        freshOverall={freshOverall}
        jumpSignal={jump}
      />
    </RoomStage>
  );
}

function useClockRemaining(startedAt: string | null, pickSeconds: number): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return null;
  const deadline = new Date(startedAt).getTime() + pickSeconds * 1000;
  return deadline - now;
}

/** Same shape but for an absolute ISO deadline (auction bidding clock). */
function useDeadlineRemaining(endsAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!endsAt) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [endsAt]);
  if (!endsAt) return null;
  return new Date(endsAt).getTime() - now;
}

// ─── Clock strip ────────────────────────────────────────────────────────────

/** Picks from now until the team's next turn (1 = the pick after this one);
 *  null when it has no turn left. */
function picksUntilTurn(draft: Draft, teamId: string): number | null {
  const total = draft.rounds * draft.draftOrder.length;
  for (let k = draft.currentOverall + 1; k <= total; k++) {
    if (teamOnClock({ draftOrder: draft.draftOrder, currentOverall: k }) === teamId) {
      return k - draft.currentOverall;
    }
  }
  return null;
}

/** The live pick clock as a slim strip under the top bar: who is up, the timer,
 *  how far off my turn is, and the time left as a thin bar. */
function ClockStrip({
  draft,
  sec,
  remainingMs,
  onClockTeamId,
  onClockTeamName,
  onClockAuto,
  isMyClock,
  myTeamId,
  onJump,
}: {
  draft: Draft;
  sec: number;
  remainingMs: number | null;
  onClockTeamId: string | null;
  onClockTeamName: string;
  onClockAuto: boolean;
  isMyClock: boolean;
  myTeamId: string | null;
  onJump: () => void;
}) {
  // ≤10s: urgency is pulse + size, not color (live = accent = coral in dark mode).
  const low = sec <= 10;
  // The bar's viewBox is 100 wide, so the rect's width attribute is the percent left.
  const left =
    remainingMs === null
      ? 100
      : Math.round(Math.max(0, Math.min(100, (remainingMs / (draft.pickSeconds * 1000)) * 100)) * 10) / 10;
  const until = myTeamId && !isMyClock ? picksUntilTurn(draft, myTeamId) : null;

  return (
    <div
      className={[
        'relative overflow-hidden rounded-b-card-lg shadow-soft lg:rounded-card-lg',
        isMyClock ? 'bg-accent/10' : 'bg-surface',
      ].join(' ')}
    >
      <div className="flex items-center gap-3 px-3 pb-3 pt-1.5 lg:px-5">
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          {isMyClock ? (
            <span className="inline-flex h-8 w-fit items-center rounded-full bg-accent px-4 font-tight text-[11.5px] font-extrabold uppercase tracking-[0.16em] text-accent-ink">
              Your turn
            </span>
          ) : (
            <div className="flex h-8 min-w-0 max-w-full items-center gap-2.5">
              <TeamAvatar id={onClockTeamId ?? ''} name={onClockTeamName} size="sm" />
              <div className="min-w-0">
                <span className="block font-tight text-[9.5px] font-bold uppercase leading-none tracking-[0.14em] text-muted">
                  On the clock
                </span>
                <span className="mt-0.5 block truncate font-tight text-[14px] font-bold leading-tight text-ink">
                  {onClockTeamName}
                </span>
              </div>
              {onClockAuto && <AutoBadge />}
            </div>
          )}
          {until !== null && (
            <span
              className={[
                'w-fit font-tight text-[11.5px] font-bold tabular',
                until === 1
                  ? 'rounded-full bg-accent/15 px-2.5 py-0.5 text-ink ring-1 ring-inset ring-accent/60'
                  : 'text-muted',
              ].join(' ')}
            >
              {until === 1 ? "You're up next" : `${until} picks until your turn`}
            </span>
          )}
        </div>

        <div
          role="timer"
          aria-label={`${sec} seconds remaining`}
          className={[
            'origin-center font-tight text-[26px] font-extrabold leading-none tracking-[-0.02em] text-ink tabular',
            'motion-safe:transition-transform motion-safe:duration-300',
            low ? 'scale-110 motion-safe:animate-cue-pulse' : '',
          ].join(' ')}
        >
          {formatClock(sec)}
        </div>

        <button
          type="button"
          onClick={onJump}
          aria-label="Scroll the board to the current pick"
          className={[
            'flex h-11 w-11 flex-shrink-0 cursor-pointer items-center justify-center rounded-full',
            'bg-ink/[0.07] text-ink transition-colors duration-150 hover:bg-ink/[0.12]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          ].join(' ')}
        >
          <CrosshairIcon />
        </button>
      </div>

      <svg
        aria-hidden="true"
        viewBox="0 0 100 1"
        preserveAspectRatio="none"
        className="absolute inset-x-0 bottom-0 h-1 w-full bg-ink/10"
      >
        <rect width={left} height="1" className="fill-accent" />
      </svg>
    </div>
  );
}

// ─── Players panel ──────────────────────────────────────────────────────────

function PlayersPanel({
  contest,
  draft,
  draftedByKey,
  teamById,
  myTeam,
  isMyClock,
  queue,
  setQueue,
  ratings,
  onRequireAuth,
  refetch,
}: {
  contest: ContestView;
  draft: Draft;
  draftedByKey: Map<string, string>;
  teamById: Map<string, TeamInfo>;
  myTeam: TeamInfo | null;
  isMyClock: boolean;
  queue: DraftRef[];
  setQueue: (q: DraftRef[]) => void;
  ratings: PlayerRating[];
  onRequireAuth: () => void;
  refetch: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FantasyPlayerHit[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const league = contest.competitionDef.playerLeague;

  const ratingMap = useMemo(() => toRatingMap(ratings), [ratings]);
  const available = useMemo(
    () => ratings.filter((r) => !draftedByKey.has(ratingKey(r.playerLeague, r.playerId))),
    [ratings, draftedByKey],
  );
  const [shown, setShown] = useState(RANKED_PAGE_SIZE);
  // Nothing typed yet: the best players still on the board instead of a blank prompt.
  const showRanked = query.trim().length < 2 && available.length > 0;
  const listHits = showRanked ? available.slice(0, shown).map(ratingToHit) : results;

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    // Responses can land out of order; only the latest query may write. The
    // spinner starts now, not after the debounce, so "No players found." can't
    // flash first.
    let cancelled = false;
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const hits = await searchContestPlayers(contest, query, 30);
        if (!cancelled) setResults(hits);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, contest.id]);

  const handleDraft = async (hit: FantasyPlayerHit) => {
    if (!myTeam) {
      onRequireAuth();
      return;
    }
    setPickingId(hit.playerId);
    setPickError(null);
    try {
      await makeDraftPick(draft.id, { playerLeague: league, playerId: hit.playerId, playerName: hit.fullName });
      refetch();
    } catch (err) {
      setPickError(err instanceof Error ? err.message : 'Could not make that pick.');
    } finally {
      setPickingId(null);
    }
  };

  const handleQueue = (hit: FantasyPlayerHit) => {
    // Signed out, the star would fill locally and the save would fail silently.
    if (!myTeam) {
      onRequireAuth();
      return;
    }
    const ref: DraftRef = { playerLeague: league, playerId: hit.playerId, playerName: hit.fullName };
    if (queue.some((q) => q.playerId === ref.playerId && q.playerLeague === ref.playerLeague)) return;
    const next = [...queue, ref];
    setQueue(next);
    saveDraftQueue(draft.id, next).catch(() => {});
  };

  return (
    <div className="bg-surface rounded-card-lg shadow-card p-4 lg:p-5">
      <div className="flex flex-col sm:flex-row gap-2.5 mb-4">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search players…"
          aria-label="Search players"
          className={[
            'flex-1 min-w-0 px-3.5 py-2.5 rounded-card-sm bg-ink/5',
            'font-tight text-[14px] text-ink placeholder:text-faint',
            'focus:outline-none focus:ring-2 focus:ring-accent',
            'min-h-[44px]',
          ].join(' ')}
        />
      </div>

      {pickError && (
        <p role="alert" className="mb-3 text-[12px] text-live font-tight">
          {pickError}
        </p>
      )}

      {ratings.length > 0 && (
        <RankingsHeader
          competition={contest.competition}
          title={showRanked ? 'Best available' : undefined}
          className="mb-2"
        />
      )}

      {query.trim().length < 2 && !showRanked ? (
        <p className="text-faint font-tight text-[13px] py-6 text-center">
          Search the player pool to draft or queue someone.
        </p>
      ) : searching && !showRanked ? (
        <PlayerListSkeleton />
      ) : listHits.length === 0 ? (
        <p className="text-faint font-tight text-[13px] py-6 text-center">No players found.</p>
      ) : (
        <ul className="space-y-1.5">
          {listHits.map((hit) => {
            const key = `${league}:${hit.playerId}`;
            const draftedTeamId = draftedByKey.get(key) ?? null;
            return (
              <PlayerRow
                key={hit.playerId}
                hit={hit}
                rating={ratingMap.get(key)}
                drafted={draftedTeamId !== null}
                draftedTeamName={draftedTeamId ? teamById.get(draftedTeamId)?.teamName ?? null : null}
                queued={queue.some((q) => q.playerId === hit.playerId && q.playerLeague === league)}
                canDraft={isMyClock && !!myTeam}
                picking={pickingId === hit.playerId}
                onDraft={() => handleDraft(hit)}
                onQueue={() => handleQueue(hit)}
              />
            );
          })}
          {showRanked && shown < available.length && (
            <li className="pt-2">
              <ShowMoreButton onClick={() => setShown((n) => n + RANKED_PAGE_SIZE)} />
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function PlayerRow({
  hit,
  rating,
  drafted,
  draftedTeamName,
  queued,
  canDraft,
  picking,
  onDraft,
  onQueue,
}: {
  hit: FantasyPlayerHit;
  rating: PlayerRating | undefined;
  drafted: boolean;
  draftedTeamName: string | null;
  queued: boolean;
  canDraft: boolean;
  picking: boolean;
  onDraft: () => void;
  onQueue: () => void;
}) {
  return (
    <li
      className={[
        'flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2.5 rounded-card-sm',
        drafted ? 'opacity-45' : 'hover:bg-surface-hi transition-colors duration-150',
      ].join(' ')}
    >
      <div className="min-w-0 flex-1">
        <div className="font-tight text-[13.5px] font-semibold text-ink truncate">{hit.fullName}</div>
        <div className="font-tight text-[11px] text-muted truncate">
          {drafted ? (draftedTeamName ? `Drafted — ${draftedTeamName}` : 'Drafted') : hit.teamName ?? ' '}
        </div>
      </div>
      {!drafted && (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            type="button"
            onClick={onQueue}
            disabled={queued}
            aria-label={queued ? `${hit.fullName} is queued` : `Queue ${hit.fullName}`}
            className={[
              'flex items-center justify-center w-9 h-9 rounded-full',
              'transition-colors duration-150',
              queued ? 'text-accent bg-accent/10 cursor-default' : 'text-faint hover:text-ink hover:bg-ink/10 cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            ].join(' ')}
          >
            <QueueGlyph filled={queued} />
          </button>
          <button
            type="button"
            onClick={onDraft}
            disabled={!canDraft || picking}
            className={[
              'px-3.5 py-2 rounded-full min-h-[36px] font-tight text-[11px] font-bold tracking-[0.08em] uppercase transition-all duration-150',
              canDraft
                ? 'bg-accent text-accent-ink hover:opacity-90 cursor-pointer'
                : 'bg-ink/[0.06] text-faint cursor-not-allowed',
            ].join(' ')}
          >
            {picking ? '…' : 'Draft'}
          </button>
        </div>
      )}
      <RatingRowLine rating={rating} />
    </li>
  );
}

function QueueGlyph({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {filled ? (
        <path d="M8 2l1.6 3.9 4.2.4-3.2 2.8.9 4.1L8 11.1l-3.5 2.1.9-4.1-3.2-2.8 4.2-.4L8 2z" fill="currentColor" />
      ) : (
        <path
          d="M8 2l1.6 3.9 4.2.4-3.2 2.8.9 4.1L8 11.1l-3.5 2.1.9-4.1-3.2-2.8 4.2-.4L8 2z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function PlayerListSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-11 rounded-card-sm bg-ink/[0.06] animate-pulse" aria-hidden="true" />
      ))}
    </div>
  );
}

// ─── Draft board ────────────────────────────────────────────────────────────

// One mapping from draft state to the shared DraftBoard, used by the live room,
// the lobby preview and the complete summary. Everything starts as an empty
// cell labeled with its pick number; picks fill in by snake position, and the
// pick on the clock (live only) overlays its empty cell.
function SnakeBoard({
  draft,
  picks,
  teamById,
  ratings,
  myTeamId,
  autodraftTeamIds,
  clock,
  freshOverall = null,
  jumpSignal,
  before,
}: {
  draft: Draft;
  picks: DraftPick[];
  teamById: Map<string, TeamInfo>;
  ratings: PlayerRating[];
  myTeamId: string | null;
  /** Live only: teams on autodraft get a badge. */
  autodraftTeamIds?: Set<string>;
  /** Live only: the pick on the clock. Omitted in the lobby and once complete. */
  clock?: { remainingSec: number | null; mine: boolean };
  freshOverall?: number | null;
  /** Bump to scroll the pick on the clock into view. */
  jumpSignal?: number;
  /** Scrolls with the board, above it (the lobby panel). */
  before?: React.ReactNode;
}) {
  const n = draft.draftOrder.length;
  const ratingMap = useMemo(() => toRatingMap(ratings), [ratings]);

  const columns = useMemo<BoardColumn[]>(
    () =>
      draft.draftOrder.map((id) => ({
        id,
        name: teamById.get(id)?.teamName ?? 'Team',
        auto: autodraftTeamIds?.has(id) ?? false,
      })),
    [draft.draftOrder, teamById, autodraftTeamIds],
  );

  const cells = useMemo(() => {
    const grid: BoardCell[] = [];
    for (let overall = 1; overall <= draft.rounds * n; overall++) {
      const { row, col } = snakeCell(overall, n);
      grid[row * n + col] = { kind: 'empty', corner: pickLabel(overall, n) };
    }
    for (const p of picks) {
      const { row, col } = snakeCell(p.overall, n);
      const rating = ratingMap.get(ratingKey(p.playerLeague, p.playerId));
      grid[row * n + col] = {
        kind: 'pick',
        playerName: p.playerName,
        meta: rating?.teamName ?? null,
        corner: pickLabel(p.overall, n),
        tone: toneForRank(rating?.rank),
        auto: p.auto,
        fresh: p.overall === freshOverall,
      };
    }
    return grid;
  }, [draft.rounds, n, picks, ratingMap, freshOverall]);

  const focus = clock ? snakeCell(draft.currentOverall, n) : null;
  const cellAt = (row: number, col: number): BoardCell => {
    const cell = cells[row * n + col];
    // Only over an empty cell: a refetch can land the pick before the clock moves on.
    if (clock && focus && row === focus.row && col === focus.col && cell.kind === 'empty') {
      return { kind: 'clock', corner: cell.corner, remainingSec: clock.remainingSec, mine: clock.mine };
    }
    return cell;
  };

  return (
    <DraftBoard
      columns={columns}
      rows={draft.rounds}
      cellAt={cellAt}
      arrows
      myColumnId={myTeamId}
      focus={focus}
      jumpSignal={jumpSignal}
      legend={picks.some((p) => ratingMap.has(ratingKey(p.playerLeague, p.playerId)))}
      before={before}
      ariaLabel="Draft board"
    />
  );
}

// ─── Queue panel ────────────────────────────────────────────────────────────

function QueuePanel({
  draft,
  myTeam,
  queue,
  setQueue,
  ratings,
  onRequireAuth,
}: {
  draft: Draft;
  myTeam: TeamInfo | null;
  queue: DraftRef[];
  setQueue: (q: DraftRef[]) => void;
  ratings: PlayerRating[];
  onRequireAuth: () => void;
}) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const persist = useCallback(
    (next: DraftRef[]) => {
      setQueue(next);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // Save the newest queue, not this call's: an add from the Players tab
      // saves at once, and a stale timer would overwrite it.
      saveTimer.current = setTimeout(() => {
        saveDraftQueue(draft.id, queueRef.current).catch(() => {});
      }, 400);
    },
    [draft.id, setQueue],
  );

  const ratingMap = useMemo(() => toRatingMap(ratings), [ratings]);

  if (!myTeam) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-8 text-center">
        <p className="text-muted font-tight text-[13px] mb-3">Sign in with a team in this league to build a queue.</p>
        <button
          type="button"
          onClick={onRequireAuth}
          className={[
            'inline-flex items-center justify-center px-5 min-h-[44px] rounded-full',
            'bg-accent text-accent-ink font-tight text-[12px] font-bold tracking-[0.08em] uppercase',
            'hover:opacity-90 transition-opacity duration-150 cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          ].join(' ')}
        >
          Sign in
        </button>
      </div>
    );
  }

  if (queue.length === 0) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-8 text-center">
        <p className="text-muted font-tight text-[13px]">
          Your queue is empty. Add players from the PLAYERS tab. If your clock runs out, autodraft picks for you: your
          queue first, then the top-ranked player left.
        </p>
      </div>
    );
  }

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...queue];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    persist(next);
  };

  const remove = (idx: number) => {
    const next = queue.filter((_, i) => i !== idx);
    persist(next);
  };

  return (
    <div className="bg-surface rounded-card-lg shadow-card overflow-hidden">
      <ul aria-label="Your draft queue">
        {queue.map((entry, idx) => (
          <li
            key={`${entry.playerLeague}:${entry.playerId}`}
            className={['flex items-center gap-2 px-4 py-3', idx > 0 ? 'border-t border-hairline' : ''].join(' ')}
          >
            <span className="font-tight text-[11px] font-bold text-faint tabular w-5">{idx + 1}</span>
            <div className="flex-1 min-w-0">
              <div className="font-tight text-[13.5px] font-semibold text-ink truncate">{entry.playerName}</div>
              <RatingLine rating={ratingMap.get(ratingKey(entry.playerLeague, entry.playerId))} compact />
            </div>
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <button
                type="button"
                onClick={() => move(idx, -1)}
                disabled={idx === 0}
                aria-label={`Move ${entry.playerName} up`}
                className="flex items-center justify-center w-9 h-9 rounded-full text-faint hover:text-ink hover:bg-ink/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <ArrowIcon dir="up" />
              </button>
              <button
                type="button"
                onClick={() => move(idx, 1)}
                disabled={idx === queue.length - 1}
                aria-label={`Move ${entry.playerName} down`}
                className="flex items-center justify-center w-9 h-9 rounded-full text-faint hover:text-ink hover:bg-ink/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <ArrowIcon dir="down" />
              </button>
              <button
                type="button"
                onClick={() => remove(idx)}
                aria-label={`Remove ${entry.playerName} from queue`}
                className="flex items-center justify-center w-9 h-9 rounded-full text-faint hover:text-live hover:bg-live/10 transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <XIcon />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ArrowIcon({ dir }: { dir: 'up' | 'down' }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className={dir === 'down' ? 'rotate-180' : ''}>
      <path d="M2.5 7.5L6 4l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// ─── Complete strip ──────────────────────────────────────────────────────────

function CompleteStrip({ draft, basePath }: { draft: Draft; basePath: string }) {
  // A minute after the draft ends, whoever watched it end goes back to the
  // league (Hunter, 2026-10-11). Every completion path stamps currentStartedAt,
  // the countdown's anchor. Rendered only for those viewers (sawLive).
  const router = useRouter();
  const [openedAt] = useState(() => Date.now());
  const endsAt = (draft.currentStartedAt ? Date.parse(draft.currentStartedAt) : openedAt) + 60_000;
  const [msLeft, setMsLeft] = useState(() => Math.max(0, endsAt - Date.now()));
  useEffect(() => {
    const tick = () => {
      const ms = endsAt - Date.now();
      if (ms <= 0) router.replace(basePath);
      else setMsLeft(ms);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [endsAt, basePath, router]);

  return (
    <div className="rounded-b-card-lg bg-surface shadow-soft lg:rounded-card-lg">
      <div className="flex min-h-[52px] items-center justify-between gap-3 px-3 py-1.5 lg:px-5">
        <p className="m-0 min-w-0 truncate font-tight text-[12.5px] text-muted tabular">
          Back to the league in {Math.ceil(msLeft / 1000)}s
        </p>
        <Link
          href={basePath}
          className="inline-flex min-h-[44px] flex-shrink-0 items-center justify-center rounded-full bg-accent px-5 font-tight text-[12px] font-bold uppercase tracking-[0.08em] text-accent-ink transition-opacity duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          View league
        </Link>
      </div>
    </div>
  );
}

// ─── Skeleton ───────────────────────────────────────────────────────────────

function RoomSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <span className="sr-only">Loading draft…</span>
      <div className="h-24 rounded-card-lg bg-ink/[0.06] animate-pulse" aria-hidden="true" />
      <div className="h-64 rounded-card-lg bg-ink/[0.06] animate-pulse" aria-hidden="true" />
    </div>
  );
}

