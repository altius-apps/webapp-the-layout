'use client';

// The sheet's panels that don't depend on the draft type, shared by the snake
// and the auction room: Team (one team's picks; the draft order in the lobby),
// Chat, and the notices that stand in for Queue before the draft is live, for
// Players / Queue after it ends, and for signed-out viewers. Players and Queue
// differ by room type and are passed in by the room.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { PillSelect, type PillSelectOption } from '@/components/pill-select';
import { auctionTeamState, type Draft, type DraftPick } from '@/lib/fantasy/draft-room';
import type { ContestView } from '@/lib/fantasy/leagues';
import type { ResolvedIcon } from '@/lib/profile/avatar-icon';
import { ratingKey, toRatingMap, type PlayerRating } from '@/lib/fantasy/ratings';
import { LeagueFeed } from '../league-feed';
import { RatingLine } from '../player-rating';
import { TeamAvatar, pickLabel } from './draft-board';
import type { RoomTab } from './room-tabs';

export interface RoomTeam {
  id: string;
  teamName: string;
  ownerIcon?: ResolvedIcon;
}

// Outlined, not shadowed: the sheet behind the cards is white (bg-surface).
const CARD = 'bg-surface rounded-card-lg border border-hairline';

/** What every panel needs to know about the draft, the same for each tab. */
export interface RoomPanelContext {
  contest: ContestView;
  draft: Draft;
  teams: RoomTeam[];
  picks: DraftPick[];
  ratings: PlayerRating[];
  myTeamId: string | null;
  basePath: string;
  signedOut: boolean;
  onRequireAuth: () => void;
  /** Open the sheet to full height (a menu inside it needs the room). */
  onExpand: () => void;
}

export function RoomPanel({
  tab,
  collapsed,
  contest,
  draft,
  teams,
  picks,
  ratings,
  myTeamId,
  basePath,
  signedOut,
  onRequireAuth,
  onExpand,
  players,
  queue,
}: RoomPanelContext & {
  tab: RoomTab;
  /** The sheet is at `min`: nothing in it is on screen. */
  collapsed: boolean;
  /** The room type's Players and Queue panels. Players also shows in the lobby
   *  (a browse-only list); Queue only while the draft is live. */
  players: React.ReactNode;
  queue: React.ReactNode;
}) {
  switch (tab) {
    case 'players':
    case 'queue': {
      if (draft.status === 'scheduled') {
        return tab === 'players' ? players : <Notice>Your queue opens when the draft goes live.</Notice>;
      }
      if (draft.status === 'complete') {
        return <Notice>The draft is complete, so the player list and queue are closed.</Notice>;
      }
      if (signedOut) {
        return tab === 'players' ? (
          <div className="space-y-3">
            <SignInPrompt onSignIn={onRequireAuth} />
            {players}
          </div>
        ) : (
          <SignInPrompt onSignIn={onRequireAuth} />
        );
      }
      return tab === 'players' ? players : queue;
    }
    case 'team':
      return draft.status === 'scheduled' ? (
        <DraftOrder draft={draft} teams={teams} myTeamId={myTeamId} />
      ) : (
        <TeamPanel
          draft={draft}
          teams={teams}
          picks={picks}
          ratings={ratings}
          myTeamId={myTeamId}
          basePath={basePath}
          onExpand={onExpand}
        />
      );
    case 'chat':
      // Mounted only while it's on screen: it holds its own realtime channel.
      return collapsed ? null : <LeagueFeed contest={contest} outlined />;
  }
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className={[CARD, 'p-8 text-center'].join(' ')}>
      <p className="m-0 font-tight text-[13px] text-muted">{children}</p>
    </div>
  );
}

function SignInPrompt({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className={[CARD, 'flex items-center justify-between gap-3 px-4 py-3 lg:px-5'].join(' ')}>
      <p className="m-0 min-w-0 font-tight text-[13px] leading-snug text-muted">Sign in to draft or build a queue.</p>
      <button
        type="button"
        onClick={onSignIn}
        className={[
          'inline-flex min-h-[44px] flex-shrink-0 cursor-pointer items-center justify-center rounded-full px-5',
          'bg-accent text-accent-ink font-tight text-[12px] font-bold uppercase tracking-[0.08em]',
          'transition-opacity duration-150 hover:opacity-90',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        ].join(' ')}
      >
        Sign in
      </button>
    </div>
  );
}

// ─── Lobby: the draft order ─────────────────────────────────────────────────

function DraftOrder({ draft, teams, myTeamId }: { draft: Draft; teams: RoomTeam[]; myTeamId: string | null }) {
  const byId = new Map(teams.map((t) => [t.id, t]));
  if (draft.draftOrder.length === 0) return <Notice>The draft order is set when the draft starts.</Notice>;
  return (
    <ol aria-label="Draft order" className={[CARD, 'overflow-hidden'].join(' ')}>
      {draft.draftOrder.map((id, idx) => (
        <li
          key={id}
          className={['flex items-center gap-3 px-4 py-2.5', idx > 0 ? 'border-t border-hairline' : ''].join(' ')}
        >
          <span className="w-5 flex-shrink-0 text-right font-tight text-[12px] font-bold text-faint tabular">{idx + 1}</span>
          <TeamAvatar name={byId.get(id)?.teamName ?? 'Team'} icon={byId.get(id)?.ownerIcon} size="sm" />
          <span className="min-w-0 flex-1 truncate font-tight text-[13.5px] font-semibold text-ink">
            {byId.get(id)?.teamName ?? 'Team'}
          </span>
          {id === myTeamId && <YouTag />}
        </li>
      ))}
    </ol>
  );
}

function YouTag() {
  return (
    <span className="flex-shrink-0 rounded-full bg-accent/10 px-2 py-0.5 font-tight text-[9.5px] font-bold uppercase tracking-[0.14em] text-accent">
      You
    </span>
  );
}

// ─── Team: one team's picks, in draft order ─────────────────────────────────

function TeamPanel({
  draft,
  teams,
  picks,
  ratings,
  myTeamId,
  basePath,
  onExpand,
}: {
  draft: Draft;
  teams: RoomTeam[];
  picks: DraftPick[];
  ratings: PlayerRating[];
  myTeamId: string | null;
  basePath: string;
  onExpand: () => void;
}) {
  const ordered = useMemo(() => {
    const byId = new Map(teams.map((t) => [t.id, t]));
    const ids = draft.draftOrder.length > 0 ? draft.draftOrder : teams.map((t) => t.id);
    return ids.map((id) => byId.get(id)).filter((t): t is RoomTeam => !!t);
  }, [draft.draftOrder, teams]);
  const ratingMap = useMemo(() => toRatingMap(ratings), [ratings]);
  const [chosen, setChosen] = useState<string | null>(null);

  const has = (id: string | null): id is string => !!id && ordered.some((t) => t.id === id);
  const teamId = has(chosen) ? chosen : has(myTeamId) ? myTeamId : ordered[0]?.id ?? null;
  const team = ordered.find((t) => t.id === teamId);
  if (!teamId || !team) return <Notice>No teams in this draft yet.</Notice>;

  const auction = draft.draftType === 'auction';
  const haul = picks.filter((p) => p.teamId === teamId).sort((a, b) => a.overall - b.overall);
  const money = auction ? auctionTeamState(draft, picks, teamId) : null;
  const options: PillSelectOption<string>[] = ordered.map((t) => ({
    value: t.id,
    label: t.teamName,
    hint: t.id === myTeamId ? 'You' : undefined,
  }));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        {/* The team menu lists every team and would be cut off by a short sheet. */}
        <div
          className="min-w-0"
          onClickCapture={(e) => {
            if ((e.target as HTMLElement).closest('[aria-haspopup="listbox"]')) onExpand();
          }}
        >
          <PillSelect
            value={teamId}
            options={options}
            onChange={setChosen}
            ariaLabel="Choose a team"
            className="min-w-[13rem] max-w-full justify-between text-left !whitespace-normal"
          />
        </div>
        {draft.status === 'complete' && (
          <Link
            href={`${basePath}/t/${teamId}`}
            className="inline-flex min-h-[44px] flex-shrink-0 items-center px-2 font-tight text-[11.5px] font-bold uppercase tracking-[0.08em] text-accent transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-full"
          >
            View team
          </Link>
        )}
      </div>

      <p className="m-0 px-1 font-tight text-[11px] font-bold uppercase tracking-[0.12em] text-muted tabular">
        {money
          ? `$${money.remaining} left · ${money.openSlots} ${money.openSlots === 1 ? 'spot' : 'spots'} open`
          : `${haul.length} of ${draft.rounds} picks`}
      </p>

      {haul.length === 0 ? (
        <Notice>No picks yet.</Notice>
      ) : (
        <ul aria-label={`${team.teamName} picks`} className={[CARD, 'overflow-hidden'].join(' ')}>
          {haul.map((p, idx) => (
            <li
              key={p.overall}
              className={['flex items-center gap-3 px-4 py-3', idx > 0 ? 'border-t border-hairline' : ''].join(' ')}
            >
              <span className="w-10 flex-shrink-0 font-tight text-[11px] font-bold text-muted tabular">
                {auction ? `#${p.overall}` : pickLabel(p.overall, draft.draftOrder.length)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-tight text-[13.5px] font-semibold text-ink">
                  {p.playerName}
                  {p.auto && <span className="font-normal text-faint"> (auto)</span>}
                </div>
                <RatingLine rating={ratingMap.get(ratingKey(p.playerLeague, p.playerId))} compact />
              </div>
              {p.price != null && (
                <span className="flex-shrink-0 font-tight text-[14px] font-bold text-accent tabular">${p.price}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
