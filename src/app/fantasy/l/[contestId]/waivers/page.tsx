// /fantasy/l/[contestId]/waivers — the Waivers tab. Chrome from the parent
// layout. Event contests (USAU, WFDF, EUCS) have no waivers: 404 (Hunter).
// Weekly: contest must be drafted + draft complete + FAAB waivers enabled,
// else render a one-line gate message.

import { notFound } from 'next/navigation';
import { getContest, waiverSettings } from '@/lib/fantasy/leagues';
import { getDraftStatusServer } from '@/lib/fantasy/server';
import { WaiversPanel } from '@/components/fantasy/waivers/waivers-panel';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

export default async function ContestWaiversPage({ params }: { params: { contestId: string } }) {
  const contest = await getContest(params.contestId).catch(() => null);
  if (!contest) return null;

  const isWeekly = contest.settings.mode === 'weekly-stats';
  if (!isWeekly) notFound();

  const isDrafted = contest.settings.draft === true;
  const draftStatus = isDrafted
    ? await getDraftStatusServer(contest.id).catch((err) => {
        console.error('[fantasy waivers] getDraftStatusServer failed', err);
        return null;
      })
    : null;
  const draftComplete = draftStatus === 'complete';
  const isFaab = waiverSettings(contest.settings).mode === 'faab';

  if (!isDrafted || !draftComplete || !isFaab) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-10 text-center">
        <p className="font-tight text-[14px] text-muted">
          Waivers open once this league&apos;s draft is complete and FAAB bidding is turned on.
        </p>
      </div>
    );
  }

  return <WaiversPanel contest={contest} />;
}
