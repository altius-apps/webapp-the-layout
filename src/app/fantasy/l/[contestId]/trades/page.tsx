// /fantasy/l/[contestId]/trades — the Trades tab. Chrome from the parent
// layout. Event contests (USAU, WFDF, EUCS) have no trades: 404 (Hunter).
// Weekly: contest must be drafted + draft complete, else render a one-line
// gate message.

import { notFound } from 'next/navigation';
import { getContest } from '@/lib/fantasy/leagues';
import { getDraftStatusServer } from '@/lib/fantasy/server';
import { TradesPanel } from '@/components/fantasy/trades/trades-panel';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

export default async function ContestTradesPage({ params }: { params: { contestId: string } }) {
  const contest = await getContest(params.contestId).catch(() => null);
  if (!contest) return null;

  const isWeekly = contest.settings.mode === 'weekly-stats';
  if (!isWeekly) notFound();

  const isDrafted = contest.settings.draft === true;
  const draftStatus = isDrafted
    ? await getDraftStatusServer(contest.id).catch((err) => {
        console.error('[fantasy trades] getDraftStatusServer failed', err);
        return null;
      })
    : null;
  const draftComplete = draftStatus === 'complete';

  if (!isDrafted || !draftComplete) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-10 text-center">
        <p className="font-tight text-[14px] text-muted">Trades open once the draft is complete.</p>
      </div>
    );
  }

  return <TradesPanel contest={contest} />;
}
