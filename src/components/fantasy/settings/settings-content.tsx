'use client';

// Settings for /fantasy/l/[contestId]/settings. The commissioner gets every
// card; any other member gets their team name + Leave league (Hunter, 2026-10-09).
// Rendered inside the shared league layout (AppShell + header/nav already
// wrap this), so this owns ONLY the heading + cards, in mobile's order:
// Name → Logo → Teams/Limits → Format + Waivers (weekly-stats only) → Roster →
// Draft (a link: draft setup is its own page, ../draft/setup).
//
// Gating: non-members see a locked-out message. Role is resolved client-side
// (same pattern as league-home-client.tsx); the RPCs re-check server-side
// regardless.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-provider';
import {
  getMyLeagueRole,
  type ContestView,
  type FantasyLeagueSummary,
  type LeagueRole,
} from '@/lib/fantasy/leagues';
import { revalidateFantasyLeague } from '@/app/fantasy/leagues/actions';
import { getGame } from '@/lib/fantasy/games';
import { LeagueLogo } from '@/components/fantasy/league-logo';
import { LeagueLogoPicker } from '@/components/fantasy/league-logo-picker';
import { NameCard, RosterCard } from '@/components/fantasy/league-settings-panel';
import { LimitsCard } from './limits-card';
import { VisibilityCard } from './visibility-card';
import { FormatCard } from './format-card';
import { WaiversCard } from './waivers-card';
import { DeleteLeagueCard } from './delete-league-card';
import { LeaveLeagueCard } from './leave-league-card';
import { TeamNameCard } from './team-name-card';

const HEADING_CLASS =
  'font-display italic text-[22px] lg:text-[26px] font-bold tracking-[-0.02em] leading-[0.95] text-ink';

interface Props {
  contest: ContestView;
  league: FantasyLeagueSummary | null;
}

export function SettingsContent({ contest, league }: Props) {
  const router = useRouter();
  const { user } = useAuth();

  const [myRole, setMyRole] = useState<LeagueRole | null>(null);
  const [roleLoading, setRoleLoading] = useState(true);
  const [logoPickerOpen, setLogoPickerOpen] = useState(false);

  useEffect(() => {
    if (!user) {
      setMyRole(null);
      setRoleLoading(false);
      return;
    }
    let cancelled = false;
    setRoleLoading(true);
    getMyLeagueRole(contest.leagueId)
      .then((r) => {
        if (!cancelled) setMyRole(r);
      })
      .catch(() => {
        if (!cancelled) setMyRole(null);
      })
      .finally(() => {
        if (!cancelled) setRoleLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [contest.leagueId, user]);

  const onSaved = () => {
    revalidateFantasyLeague(contest.leagueId, contest.id).catch(() => null);
    router.refresh();
  };

  if (roleLoading) {
    return (
      <section aria-labelledby="league-settings-heading" className="space-y-4">
        <h2 id="league-settings-heading" className={HEADING_CLASS}>
          Settings
        </h2>
      </section>
    );
  }

  if (myRole !== 'commissioner') {
    return (
      <section aria-labelledby="league-settings-heading" className="space-y-4">
        <h2 id="league-settings-heading" className={HEADING_CLASS}>
          Settings
        </h2>
        {myRole === 'member' && <TeamNameCard contest={contest} />}
        <div className="bg-surface rounded-card-lg shadow-card p-8 text-center">
          <p className="text-muted font-tight text-[14px]">
            {myRole === 'member'
              ? 'League settings are managed by the commissioner.'
              : 'Only the commissioner can change settings.'}
          </p>
        </div>
        {myRole === 'member' && <LeaveLeagueCard leagueId={contest.leagueId} isOwner={false} />}
      </section>
    );
  }

  const leagueName = league?.name ?? contest.name;

  return (
    <section aria-labelledby="league-settings-heading" className="space-y-4">
      <h2 id="league-settings-heading" className={HEADING_CLASS}>
        Settings
      </h2>

      <TeamNameCard contest={contest} />

      <NameCard leagueId={contest.leagueId} initialName={leagueName} />

      <div className="bg-surface rounded-card-lg shadow-card p-5 lg:p-6">
        <h3 className="text-[11px] font-bold tracking-[0.16em] uppercase text-muted font-tight mb-4">Logo</h3>
        <div className="flex items-center gap-3.5">
          <LeagueLogo
            name={leagueName}
            logoUrl={league?.logoUrl}
            logoIcon={league?.logoIcon}
            logoSrc={getGame(contest.competition)?.logoSrc}
            size={56}
          />
          <div className="min-w-0 flex-1">
            <p className="font-tight text-[13.5px] font-semibold text-ink truncate">{leagueName}</p>
            <p className="font-tight text-[11.5px] text-faint">Shown across the app for this league.</p>
          </div>
          <button
            type="button"
            onClick={() => setLogoPickerOpen(true)}
            aria-label="Change league logo"
            className={[
              'flex-shrink-0 inline-flex items-center justify-center',
              'px-4 py-2 rounded-full min-h-[36px]',
              'font-tight text-[11px] font-bold tracking-[0.06em] uppercase',
              'bg-ink/5 text-ink hover:bg-ink/10 transition-colors duration-150 cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            ].join(' ')}
          >
            Change
          </button>
        </div>
      </div>

      <LimitsCard contest={contest} onSaved={onSaved} />

      {league && !league.isOfficial && <VisibilityCard leagueId={contest.leagueId} initialPublic={league.isPublic} />}

      {contest.settings.mode === 'weekly-stats' && <FormatCard contest={contest} onSaved={onSaved} />}

      {contest.settings.mode === 'weekly-stats' && <WaiversCard contest={contest} onSaved={onSaved} />}

      <RosterCard contest={contest} />

      <Link
        href={`/fantasy/l/${contest.id}/draft/setup`}
        className={[
          'flex items-center gap-3 bg-surface rounded-card-lg shadow-card p-5 lg:p-6',
          'no-underline transition-colors duration-150 hover:bg-surface-hi',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
        ].join(' ')}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-bold tracking-[0.16em] uppercase text-muted font-tight">
            Draft
          </span>
          <span className="block font-tight text-[13.5px] text-ink mt-1.5">Set up the draft — type, time and clock</span>
        </span>
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="flex-shrink-0 text-faint">
          <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Link>

      {/* A sole owner can't leave (nobody to hand the league to); they delete it. */}
      {(league?.memberCount ?? 0) > 1 && <LeaveLeagueCard leagueId={contest.leagueId} isOwner />}

      {league && user?.id === league.ownerId && <DeleteLeagueCard leagueId={contest.leagueId} contestId={contest.id} leagueName={leagueName} />}

      <LeagueLogoPicker
        open={logoPickerOpen}
        onClose={() => setLogoPickerOpen(false)}
        leagueId={contest.leagueId}
        leagueName={leagueName}
        currentLogoUrl={league?.logoUrl ?? null}
        currentLogoIcon={league?.logoIcon ?? null}
      />
    </section>
  );
}
