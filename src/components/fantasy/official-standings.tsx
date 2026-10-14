'use client';

// ESPN-style standings for official leagues: rank across the whole field, the
// viewer's own row pinned on top, top 100 then "Show more". Pages come from the
// server-cached leaderboard (60 s) and are fetched once per mount/page.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth/auth-provider';
import {
  getContestTeamRank,
  getMyContestTeam,
  topPercent,
  type LeaderboardEntry,
} from '@/lib/fantasy/leagues';
import { fetchLeaderboardPage } from '@/app/fantasy/leaderboard-actions';

const PAGE_SIZE = 100;

interface MyStanding {
  teamId: string;
  teamName: string;
  rank: number;
  totalTeams: number;
  totalPoints: number;
}

export function OfficialStandings({ contestId }: { contestId: string }) {
  const { user } = useAuth();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [mine, setMine] = useState<MyStanding | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchLeaderboardPage(contestId, 0)
      .then((rows) => {
        if (cancelled) return;
        setEntries(rows);
        setHasMore(rows.length === PAGE_SIZE);
      })
      .catch(() => !cancelled && setFailed(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [contestId]);

  useEffect(() => {
    if (!user) {
      setMine(null);
      return;
    }
    let cancelled = false;
    getMyContestTeam(contestId)
      .then(async (team) => {
        if (!team) return;
        const r = await getContestTeamRank(team.id);
        if (!cancelled && r) setMine({ teamId: team.id, teamName: team.teamName, ...r });
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [user, contestId]);

  const showMore = async () => {
    setLoadingMore(true);
    try {
      const next = await fetchLeaderboardPage(contestId, page + 1);
      setEntries((prev) => [...prev, ...next]);
      setPage(page + 1);
      setHasMore(next.length === PAGE_SIZE);
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-8 text-center">
        <div className="inline-block w-5 h-5 rounded-full border-2 border-ink/15 border-t-accent animate-spin" aria-hidden="true" />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-8 text-center">
        <p className="text-muted font-tight text-[14px]">
          {failed ? "Couldn't load the standings. Try again shortly." : 'No teams yet — be the first to build one.'}
        </p>
      </div>
    );
  }

  const scored = entries.some((e) => e.totalPoints > 0);

  return (
    <div className="space-y-3">
      {mine && (
        <Link
          href={`/fantasy/l/${contestId}/t/${mine.teamId}`}
          className={[
            'flex items-center gap-3 bg-accent/10 rounded-card-lg px-5 py-3.5 no-underline',
            'transition-colors duration-150 hover:bg-accent/15',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          ].join(' ')}
        >
          <span className="min-w-0 flex-1 flex flex-col gap-0.5">
            <span className="font-tight text-[14px] font-semibold text-ink truncate">{mine.teamName}</span>
            <span className="font-tight text-[11px] text-muted truncate">
              {scored || mine.totalPoints > 0
                ? `You · #${mine.rank.toLocaleString('en-US')} of ${mine.totalTeams.toLocaleString('en-US')} · top ${topPercent(mine.rank, mine.totalTeams)}%`
                : `You · ${mine.totalTeams.toLocaleString('en-US')} teams in the field`}
            </span>
          </span>
          <span className="font-tight text-[15px] font-bold tabular text-ink">
            {mine.totalPoints}
            <span className="text-[11px] font-medium text-faint ml-1">pts</span>
          </span>
        </Link>
      )}

      <div className="bg-surface rounded-card-lg shadow-card overflow-hidden">
        <div className="grid grid-cols-[3rem_1fr_auto] items-center px-5 py-3">
          <span className="text-[10px] font-bold tracking-[0.16em] uppercase text-faint font-tight">RK</span>
          <span className="text-[10px] font-bold tracking-[0.16em] uppercase text-faint font-tight">Team</span>
          <span className="text-[10px] font-bold tracking-[0.16em] uppercase text-faint font-tight text-right">Pts</span>
        </div>
        <ol aria-label="Contest standings">
          {entries.map((row) => {
            const owner = row.ownerDisplayName ?? row.ownerUsername;
            return (
              <li key={row.teamId}>
                <Link
                  href={`/fantasy/l/${contestId}/t/${row.teamId}`}
                  className={[
                    'grid grid-cols-[3rem_1fr_auto] items-center px-5 py-3.5 border-t border-hairline',
                    'no-underline transition-colors duration-150 hover:bg-surface-hi',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                  ].join(' ')}
                >
                  <span
                    className={['font-tight text-[13px] font-bold tabular', row.rank <= 3 ? 'text-accent' : 'text-faint'].join(' ')}
                    aria-label={`Rank ${row.rank}`}
                  >
                    {row.rank}
                  </span>
                  <span className="min-w-0 flex flex-col gap-0.5">
                    <span className="font-tight text-[14px] font-semibold text-ink truncate">{row.teamName}</span>
                    {owner && owner !== row.teamName && (
                      <span className="font-tight text-[11px] text-muted truncate">{owner}</span>
                    )}
                  </span>
                  <span className="font-tight text-[15px] font-bold tabular text-right text-ink">
                    {row.totalPoints}
                    <span className="text-[11px] font-medium text-faint ml-1">pts</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      </div>

      {hasMore && (
        <button
          type="button"
          onClick={showMore}
          disabled={loadingMore}
          className={[
            'w-full py-3 rounded-full bg-ink/5 text-ink font-tight text-[12px] font-bold tracking-[0.06em] uppercase',
            'hover:bg-ink/10 transition-colors duration-150 cursor-pointer disabled:opacity-50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          ].join(' ')}
        >
          {loadingMore ? 'Loading…' : 'Show more'}
        </button>
      )}
    </div>
  );
}
