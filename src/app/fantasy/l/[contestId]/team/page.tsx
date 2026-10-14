// /fantasy/l/[contestId]/team — the Team tab. Weekly contest → the roster
// builder (pool mode + Bench card when the contest is drafted, restricting
// lineups to owned players). Event contest with no draft (official leagues)
// → the open-search builder. Drafted event contest with a completed draft → a
// read-only seeded roster; without one → "built in the draft" card. Signed-out users still see the shell; the builder /
// bench island itself is auth-gated (AuthModal on write attempts, per the
// shared conventions).

import { getContest } from '@/lib/fantasy/leagues';
import { getLeagueCached } from '@/lib/fantasy/league-cached';
import { getDraftStatusServer, getMyContestTeamServer } from '@/lib/fantasy/server';
import { getContestTeamRoster } from '@/lib/fantasy/draft';
import { TeamTabClient } from '@/components/fantasy/team-tab-client';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

export default async function ContestTeamPage({ params }: { params: { contestId: string } }) {
  // Not logged: crawlers hit junk ids all day, and the layout already renders
  // the not-found card for them.
  const contest = await getContest(params.contestId).catch(() => null);
  if (!contest) return null;

  const isEventMode = contest.settings.mode === 'event';

  const league = await getLeagueCached(contest.leagueId).catch(() => null);
  const isOfficial = league?.isOfficial ?? false;

  // Weekly contests, and official event leagues (never drafted: everyone
  // picks from the whole player pool). A user's event league is built in its
  // draft, even before one is scheduled.
  if (!isEventMode || isOfficial) {
    // Weekly contest: the builder resolves its own team/period/roster client-
    // side (same as the legacy /fantasy/contests/[id]/team route) — pool mode
    // and the Bench card need the signed-in user's team, which isn't known at
    // request time for a force-dynamic-but-still-server page without a
    // session read here, so that resolution is delegated to a client island.
    return <TeamTabClient contest={contest} isOfficial={isOfficial} />;
  }

  // Event mode: seeded roster once the draft is complete.
  const draftStatus = await getDraftStatusServer(contest.id).catch((err) => {
    console.error('[fantasy team] getDraftStatusServer failed', err);
    return null;
  });
  const draftComplete = draftStatus === 'complete';

  if (!draftComplete) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-10 text-center">
        <h2 className="font-tight text-[16px] font-bold text-ink mb-2">Your roster is built in the draft</h2>
        <p className="font-tight text-[14px] text-muted">
          Once the draft completes, your seeded roster will show up here.
        </p>
      </div>
    );
  }

  const myTeam = await getMyContestTeamServer(contest.id).catch((err) => {
    console.error('[fantasy team] getMyContestTeamServer failed', err);
    return null;
  });
  if (!myTeam) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-10 text-center">
        <p className="font-tight text-[14px] text-muted">
          Create a team on the league page before viewing your roster.
        </p>
      </div>
    );
  }

  const roster = await getContestTeamRoster(contest, myTeam.id, 'event').catch((err) => {
    console.error('[fantasy team] getContestTeamRoster failed', err);
    return [];
  });

  if (roster.length === 0) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-10 text-center">
        <h2 className="font-tight text-[16px] font-bold text-ink mb-2">No roster yet</h2>
        <p className="font-tight text-[14px] text-muted">Your team wasn&apos;t seeded a roster from the draft.</p>
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-card-lg shadow-card overflow-hidden">
      {roster.map((slot, idx) => (
        <div
          key={slot.playerId}
          className={['flex items-center gap-3 px-5 py-3', idx > 0 ? 'border-t border-hairline' : ''].join(' ')}
        >
          <span className="flex-shrink-0 w-5 h-5 rounded-full bg-ink/5 text-[9px] font-bold flex items-center justify-center font-tight text-ink">
            {slot.role === 'offender' ? 'O' : slot.role === 'defender' ? 'D' : 'F'}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-tight text-[14px] font-semibold text-ink truncate">{slot.fullName}</span>
            {slot.teamName && <span className="block font-tight text-[11px] text-muted truncate">{slot.teamName}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
