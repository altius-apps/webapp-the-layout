'use client';

// Official leagues have no draft: this replaces the draft card with what to
// do instead. Event contests lock once at the event's first game.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getContestPeriods, type ContestView } from '@/lib/fantasy/leagues';

function lockText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'the event starts';
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  });
}

export function NoDraftCard({ contest }: { contest: ContestView }) {
  const isEvent = contest.settings.mode === 'event';
  const [lockAt, setLockAt] = useState<string | null>(null);

  useEffect(() => {
    if (!isEvent) return;
    let cancelled = false;
    getContestPeriods(contest.id)
      .then((periods) => !cancelled && setLockAt(periods.find((p) => p.period === 'event')?.lockAt ?? null))
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [contest.id, isEvent]);

  return (
    <section className="bg-surface rounded-card-lg shadow-card p-5 lg:p-6 flex flex-col sm:flex-row sm:items-center gap-4">
      <p className="flex-1 font-tight text-[14px] text-ink">
        {isEvent
          ? `No draft — pick any 7 players before ${lockAt ? lockText(lockAt) : 'the event starts'}. Everyone can pick the same players.`
          : 'No draft — set a 4 offense + 3 defense lineup from any players each week.'}
      </p>
      {isEvent && (
        <Link
          href={`/fantasy/l/${contest.id}/team`}
          className={[
            'inline-flex items-center justify-center flex-shrink-0 px-5 py-2.5 rounded-full min-h-[44px]',
            'bg-accent text-accent-ink font-tight text-[12px] font-bold tracking-[0.1em] uppercase no-underline',
            'hover:opacity-90 transition-opacity duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
          ].join(' ')}
        >
          Pick your players
        </Link>
      )}
    </section>
  );
}
