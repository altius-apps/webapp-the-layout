'use client';

// Event-scoped WFDF players view — who played at this event, filtered by
// DIVISION (pill tabs + swipe, same DivisionPager idiom as the event screen)
// and ranked by stats: points (G+A) desc, goals desc (Hunter, 2026-08-18;
// replaces the old by-team roster grouping — most WFDF events ingest
// per-player goals/assists). Stat-less players trail the ranked block
// alphabetically so full rosters stay browsable on legacy events.
//
// Division lives in the URL (?div=) so back-nav from a profile and hard
// refresh both keep the filter, mirroring the event detail screen.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { WfdfEventPlayersDetail, WfdfEventPlayerRow } from '@/lib/wfdf/data';
import { WfdfFlag } from './wfdf-flag';
import { SearchBox, EmptyState } from './wfdf-teams-hub';
import { DivisionPager } from '@/components/division-pager';
import { useViewParam } from '@/lib/use-view-param';

interface Props {
  event: WfdfEventPlayersDetail;
}

// Bucket label for teams whose division didn't ingest — keeps them reachable
// behind their own pill instead of vanishing from the tab.
const OTHER_DIVISION = 'Other';

function playerPoints(p: WfdfEventPlayerRow): number {
  return (p.goals ?? 0) + (p.assists ?? 0);
}

export function WfdfEventPlayers({ event }: Props) {
  const [query, setQuery] = useState('');

  // Division pills — derived from the teams (rosters carry no division of
  // their own). Alphabetical, with the null-division bucket last.
  const divisions = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const t of event.teams) set.add(t.divisionName ?? OTHER_DIVISION);
    return [...set].sort((a, b) => {
      if (a === OTHER_DIVISION) return 1;
      if (b === OTHER_DIVISION) return -1;
      return a.localeCompare(b);
    });
  }, [event.teams]);

  const [divParam, setDivParam] = useViewParam('div');
  const defaultDiv = divisions[0] ?? '';
  const activeDiv = divParam != null && divisions.includes(divParam) ? divParam : defaultDiv;
  const setActiveDiv = (next: string) => setDivParam(next === defaultDiv ? null : next);
  const divisionOptions = useMemo(
    () => divisions.map((d) => ({ value: d, label: d })),
    [divisions],
  );

  // Rank a division's players by stats as they come through. A team-name hit
  // keeps the whole roster; otherwise filter by player name. Parameterized by
  // division so DivisionPager can call it for the active division AND the
  // neighbor division mid-swipe.
  const rankedFor = (division: string): WfdfEventPlayerRow[] => {
    const q = query.trim().toLowerCase();
    const out: WfdfEventPlayerRow[] = [];
    for (const t of event.teams) {
      if ((t.divisionName ?? OTHER_DIVISION) !== division) continue;
      const teamHit = q.length > 0 && t.teamName.toLowerCase().includes(q);
      for (const p of t.players) {
        if (q && !teamHit && !p.fullName.toLowerCase().includes(q)) continue;
        out.push(p);
      }
    }
    out.sort(
      (a, b) =>
        playerPoints(b) - playerPoints(a) ||
        (b.goals ?? 0) - (a.goals ?? 0) ||
        a.fullName.localeCompare(b.fullName),
    );
    return out;
  };

  const ranked = useMemo(() => rankedFor(activeDiv), [event.teams, activeDiv, query]);

  return (
    <div className="flex flex-col gap-6">
      <SearchBox
        value={query}
        onChange={setQuery}
        placeholder="Filter players or teams…"
        count={query ? ranked.length : event.totalPlayers}
        countLabel="players"
      />

      <DivisionPager
        divisions={divisionOptions}
        active={activeDiv}
        onChange={setActiveDiv}
        renderDivision={(div) => <RankedPlayersTable rows={rankedFor(div)} query={query} />}
        contentClassName="flex flex-col gap-6"
      />
    </div>
  );
}

function RankedPlayersTable({ rows, query }: { rows: WfdfEventPlayerRow[]; query: string }) {
  if (rows.length === 0) {
    return <EmptyState query={query} />;
  }
  return (
    <div className="overflow-x-auto">
      {/* No min-width: the 480px floor forced a horizontal scroll to reach
          the stat columns on phones. Player/Team instead cap + truncate the
          rare over-long value, so G/A/Pts stay on screen. */}
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-[10px] font-bold tracking-[0.12em] uppercase text-muted font-tight">
            <th className="text-right py-2 pr-2 font-bold w-8">#</th>
            <th className="text-left py-2 px-2 font-bold">Player</th>
            <th className="text-left py-2 px-2 font-bold">Team</th>
            <th className="text-right py-2 px-2 font-bold">G</th>
            <th className="text-right py-2 px-2 font-bold">A</th>
            <th className="text-right py-2 pl-2 font-bold">Pts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => {
            const hasStats = p.goals != null || p.assists != null;
            return (
              <tr key={`${p.teamId}-${p.fullName}-${i}`} className="border-t border-hairline">
                <td className="text-right py-2 pr-2 text-[12px] font-tight tabular-nums text-faint">
                  {i + 1}
                </td>
                <td className="py-2 px-2 text-[13px] font-tight text-ink">
                  <Link
                    href={`/wfdf/players/by-name/${encodeURIComponent(p.fullName)}`}
                    prefetch={false}
                    className="block max-w-[20ch] truncate no-underline hover:underline text-ink font-semibold"
                    title={p.fullName}
                  >
                    {p.fullName}
                  </Link>
                </td>
                <td className="py-2 px-2 text-[13px] font-tight text-muted">
                  {/* flex (not inline-flex) so the max-w cap + truncate on the
                      link actually constrain — inline-flex let the cell grow
                      to the longest team name instead of truncating it. */}
                  <span className="flex items-center gap-1.5 max-w-[18ch]">
                    <WfdfFlag flagFile={null} countryCode={p.countryCode} size={13} />
                    <Link
                      href={`/wfdf/teams/${p.teamId}`}
                      prefetch={false}
                      className="min-w-0 truncate no-underline hover:underline text-muted"
                      title={p.teamName}
                    >
                      {p.teamName}
                    </Link>
                  </span>
                </td>
                <td className="text-right py-2 px-2 text-[13px] font-tight tabular-nums text-ink">
                  {hasStats ? (p.goals ?? 0) : '–'}
                </td>
                <td className="text-right py-2 px-2 text-[13px] font-tight tabular-nums text-muted">
                  {hasStats ? (p.assists ?? 0) : '–'}
                </td>
                <td className="text-right py-2 pl-2 text-[13px] font-tight tabular-nums text-ink font-semibold">
                  {hasStats ? playerPoints(p) : '–'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
