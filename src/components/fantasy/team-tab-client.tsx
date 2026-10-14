'use client';

// TeamTabClient — the weekly-contest branch of the Team tab. Resolves the
// signed-in user's team + drafted-pool ownership client-side, then renders
// ContestRosterBuilder in pool mode (when the contest is drafted, lineups
// are restricted to owned players) plus a Bench card for pool players not in
// the active week's lineup. Web port of the mobile app's team.tsx weekly
// branch (altiusapps/mobileapp-thelayout ·
// app/(app)/fantasy/l/[contestId]/team.tsx).

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth/auth-provider';
import {
  getMyContestTeam,
  getTeamPlayers,
  getContestPeriods,
  periodsToWeeks,
  type ContestView,
} from '@/lib/fantasy/leagues';
import { getContestTeamRoster } from '@/lib/fantasy/draft';
import type { FantasyPlayerHit } from '@/lib/fantasy/data';
import { ContestRosterBuilder } from '@/components/fantasy/contest-roster-builder';
import { FantasyRulesModal } from '@/components/fantasy/fantasy-rules-modal';

export function TeamTabClient({ contest, isOfficial = false }: { contest: ContestView; isOfficial?: boolean }) {
  const { user } = useAuth();
  const isDrafted = contest.settings.draft === true;

  const [myTeam, setMyTeam] = useState<{ id: string; teamName: string } | null>(null);
  const [pool, setPool] = useState<FantasyPlayerHit[] | undefined>(undefined);
  const [activeWeek, setActiveWeek] = useState<string | null>(null);
  const [lineup, setLineup] = useState<{ playerId: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setMyTeam(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    getMyContestTeam(contest.id)
      .then((t) => !cancelled && setMyTeam(t))
      .catch(() => !cancelled && setMyTeam(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [user, contest.id]);

  useEffect(() => {
    if (!myTeam || !isDrafted) {
      setPool(undefined);
      return;
    }
    let cancelled = false;
    getTeamPlayers(contest.id, myTeam.id)
      .then((rows) => {
        if (cancelled) return;
        setPool(rows.map((r) => ({ playerId: r.playerId, fullName: r.playerName, teamId: null, teamName: null })));
      })
      .catch(() => !cancelled && setPool([]));
    return () => {
      cancelled = true;
    };
  }, [contest.id, myTeam, isDrafted]);

  useEffect(() => {
    let cancelled = false;
    getContestPeriods(contest.id)
      .then((periods) => {
        if (cancelled) return;
        const weeks = periodsToWeeks(periods);
        if (weeks.length === 0) {
          setActiveWeek(null);
          return;
        }
        const nowMs = Date.now();
        const upcoming = weeks.find((w) => w.lockAt == null || new Date(w.lockAt).getTime() > nowMs);
        setActiveWeek((upcoming ?? weeks[weeks.length - 1]).week);
      })
      .catch(() => !cancelled && setActiveWeek(null));
    return () => {
      cancelled = true;
    };
  }, [contest.id]);

  useEffect(() => {
    if (!myTeam || !activeWeek) {
      setLineup([]);
      return;
    }
    let cancelled = false;
    getContestTeamRoster(contest, myTeam.id, activeWeek)
      .then((rows) => !cancelled && setLineup(rows.map((r) => ({ playerId: r.playerId }))))
      .catch(() => !cancelled && setLineup([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contest.id, myTeam, activeWeek]);

  const lineupIds = useMemo(() => new Set(lineup.map((s) => s.playerId)), [lineup]);
  const bench = useMemo(() => (pool ?? []).filter((p) => !lineupIds.has(p.playerId)), [pool, lineupIds]);

  if (loading) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-10 text-center">
        <div className="inline-block w-5 h-5 rounded-full border-2 border-ink/15 border-t-accent animate-spin" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FantasyRulesModal
        label="How scoring works"
        mode={contest.settings.mode}
        playerLeague={contest.competitionDef.playerLeague}
        competition={contest.competition}
      />

      <ContestRosterBuilder contest={contest} pool={pool} showRosteredPct={isOfficial} />

      {pool && pool.length > 0 && bench.length > 0 && (
        <div>
          <h2 className="text-[11px] font-bold tracking-[0.16em] uppercase text-muted font-tight mb-3">Bench</h2>
          <div className="bg-surface rounded-card-lg shadow-card overflow-hidden">
            {bench.map((p, idx) => (
              <div
                key={p.playerId}
                className={['flex items-center gap-3 px-5 py-3', idx > 0 ? 'border-t border-hairline' : ''].join(' ')}
              >
                <span className="font-tight text-[14px] font-semibold text-ink truncate">{p.fullName}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default TeamTabClient;
