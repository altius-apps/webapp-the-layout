'use client';

// "My Leagues" — the fantasy hub's first section. Each of the signed-in
// user's league contests as a row with a status pill (draft state / live / final / open). Port of the
// mobile hub's My Leagues card (altiusapps/mobileapp-thelayout ·
// app/(app)/fantasy/index.tsx) — same status-chip logic, same row shape.
//
// Empty and load-failed states are plain rows, not links (Hunter, 2026-10-07):
// creating starts from Start a League below, joining from the header's Join
// league button. A failed load says so rather than claiming "No leagues yet".

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth/auth-provider';
import { AuthModal } from '@/components/auth/auth-modal';
import { LeagueLogo } from '@/components/fantasy/league-logo';
import { getMyLeagues, type MyLeagueRow, type MyLeagueContestRow } from '@/lib/fantasy/leagues';
import { contestFormat, divisionSuffix } from '@/lib/fantasy/competitions';
import { getGame } from '@/lib/fantasy/games';

interface StatusChip {
  label: string;
  tone: 'neutral' | 'accent' | 'solid';
}

function draftTimeLabel(scheduledAt: string): string {
  const d = new Date(scheduledAt);
  if (Number.isNaN(d.getTime())) return 'Draft pending';
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Draft today ${time}`;
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return `Draft ${day} · ${time}`;
}

function contestStatusChip(contest: MyLeagueContestRow): StatusChip {
  const d = contest.draft;
  // A finished contest reads Final even if its draft never ran.
  if (contest.status === 'complete') return { label: 'Final', tone: 'neutral' };
  if (d?.status === 'live') return { label: 'Draft live', tone: 'solid' };
  if (d?.status === 'scheduled' && d.scheduledAt) return { label: draftTimeLabel(d.scheduledAt), tone: 'accent' };
  if (d?.status === 'scheduled') return { label: 'Draft pending', tone: 'accent' };
  if (contest.status === 'active') return { label: 'Live', tone: 'accent' };
  if (d?.status === 'complete') return { label: 'Drafted', tone: 'neutral' };
  return { label: 'Open', tone: 'neutral' };
}

function StatusPill({ chip }: { chip: StatusChip }) {
  const toneClass =
    chip.tone === 'solid'
      ? 'bg-accent text-accent-ink'
      : chip.tone === 'accent'
        ? 'bg-accent/10 text-accent'
        : 'bg-ink/[0.06] text-faint';
  return (
    <span
      className={[
        'flex-shrink-0 text-[9.5px] font-bold tracking-[0.08em] uppercase px-2 py-[3px] rounded-full whitespace-nowrap',
        toneClass,
      ].join(' ')}
    >
      {chip.label}
    </span>
  );
}

export function MyLeaguesList() {
  const { user, loading } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const [leagues, setLeagues] = useState<MyLeagueRow[]>([]);
  const [leaguesLoading, setLeaguesLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    setLoadFailed(false);
    if (!user) {
      setLeagues([]);
      setLeaguesLoading(false);
      return;
    }
    setLeaguesLoading(true);
    getMyLeagues()
      .then(setLeagues)
      .catch(() => {
        setLeagues([]);
        setLoadFailed(true);
      })
      .finally(() => setLeaguesLoading(false));
  }, [user]);

  // Flatten each league's contests into rows, same as the mobile hub.
  const rows = leagues.flatMap((league) =>
    league.contests.map((contest) => ({
      key: `${league.leagueId}:${contest.contestId}`,
      league,
      contest,
    })),
  );

  return (
    <section aria-labelledby="my-leagues-heading" className="mb-8 lg:mb-10">
      <h2
        id="my-leagues-heading"
        className="font-display italic text-[22px] lg:text-[26px] font-bold tracking-[-0.02em] leading-[0.95] text-ink mb-4"
      >
        My Leagues
      </h2>

      <div className="bg-surface rounded-card-lg shadow-card overflow-hidden">
        {loading || leaguesLoading ? (
          <div className="p-6 flex items-center justify-center" aria-hidden="true">
            <span className="w-5 h-5 rounded-full border-2 border-ink/15 border-t-accent animate-spin" />
          </div>
        ) : !user ? (
          <button
            type="button"
            onClick={() => setAuthOpen(true)}
            className={[
              'w-full flex items-center gap-3 px-5 py-4 text-left cursor-pointer',
              'transition-colors duration-150 hover:bg-surface-hi',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
            ].join(' ')}
          >
            <span className="min-w-0 flex-1 font-tight text-[14px] font-semibold text-ink">
              Sign in to see your leagues
            </span>
            <ChevronGlyph />
          </button>
        ) : loadFailed ? (
          <div role="alert" className="px-5 py-4">
            <p className="font-tight text-[14px] font-semibold text-ink">Couldn&apos;t load your leagues</p>
            <p className="font-tight text-[11px] text-muted mt-0.5">Check your connection and try again.</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="px-5 py-4">
            <p className="font-tight text-[14px] font-semibold text-ink">No leagues yet</p>
            <p className="font-tight text-[11px] text-muted mt-0.5">
              Create one below, or join a friend&apos;s with an invite code.
            </p>
          </div>
        ) : (
          <ul aria-label="Your leagues">
            {rows.map((r, idx) => {
              const chip = contestStatusChip(r.contest);
              const showLeagueName = r.league.contests.length === 1 || r.contest.name === r.league.name;
              return (
                <li key={r.key}>
                  <Link
                    href={`/fantasy/l/${r.contest.contestId}`}
                    className={[
                      'flex items-center gap-3 px-5 py-3.5',
                      'no-underline transition-colors duration-150',
                      'hover:bg-surface-hi',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                      idx > 0 ? 'border-t border-hairline' : '',
                    ].join(' ')}
                  >
                    <LeagueLogo
                      name={r.league.name}
                      logoUrl={r.league.logoUrl}
                      logoIcon={r.league.logoIcon}
                      logoSrc={getGame(r.contest.competition)?.logoSrc}
                      size={40}
                    />
                    <span className="min-w-0 flex-1 flex flex-col gap-0.5">
                      <span className="font-tight text-[14px] font-semibold text-ink truncate">
                        {showLeagueName ? r.league.name : r.contest.name}
                      </span>
                      <span className="font-tight text-[11px] text-muted truncate">
                        {r.contest.competitionDef.shortLabel}
                        {divisionSuffix(r.contest.settings)} · {r.contest.seasonYear}
                        {contestFormat(r.contest.settings) === 'h2h' ? ' · H2H' : ''}
                        {r.league.role === 'commissioner' ? ' · Commish' : ''}
                      </span>
                    </span>
                    <StatusPill chip={chip} />
                    <ChevronGlyph />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <AuthModal
        open={authOpen}
        dismissible
        initialMode="signin"
        onDismiss={() => setAuthOpen(false)}
        headline="Sign in to see your leagues"
      />
    </section>
  );
}

function ChevronGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="flex-shrink-0 text-faint">
      <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
