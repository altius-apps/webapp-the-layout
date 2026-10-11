'use client';

// EUCS Players hub — career scoring leaderboard with a client-side filter.
//
// Unlike WFDF's hub (which searches server-side over ~21k rows), the EUF page
// ships the top N players and filters them in the browser: the payload is
// bounded by the RPC's limit, so there's no corpus to page through. A name
// that isn't in the top N is still reachable through global search, which hits
// search_euf_players_fuzzy.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { PillSelect } from '@/components/pill-select';
import { EufFlag } from '@/components/euf/euf-flag';
import type { EufPlayerHubRow, EufDivision } from '@/lib/euf/data';

interface Props {
  players: EufPlayerHubRow[];
}

export function EufPlayersHub({ players }: Props) {
  const [query, setQuery] = useState('');
  const [division, setDivision] = useState('all');

  const divisionOptions = useMemo(() => {
    const divs = new Set(players.map((p) => p.division).filter(Boolean));
    return [
      { value: 'all', label: 'All divisions' },
      ...(['Open', "Women's", 'Mixed'] as EufDivision[])
        .filter((d) => divs.has(d))
        .map((d) => ({ value: d, label: d })),
    ];
  }, [players]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return players.filter(
      (p) =>
        (division === 'all' || p.division === division) &&
        (!q ||
          p.fullName.toLowerCase().includes(q) ||
          (p.teamName ?? '').toLowerCase().includes(q)),
    );
  }, [players, query, division]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search players or clubs…"
          aria-label="Search players"
          className="flex-1 min-w-[200px] px-3.5 py-2 rounded-full text-[13px] font-tight bg-surface border border-border text-ink placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <PillSelect
          value={division}
          options={divisionOptions}
          onChange={setDivision}
          ariaLabel="Filter players by division"
        />
        <span className="text-[11px] text-muted font-tight tabular-nums">
          {shown.length} {shown.length === 1 ? 'player' : 'players'}
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-card-lg bg-surface shadow-card p-10 text-center">
          <p className="text-muted font-tight text-[14px]">No players match that search.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[340px] border-collapse">
            <thead>
              <tr className="text-[10px] font-bold tracking-[0.12em] uppercase text-muted font-tight">
                <th className="text-left py-2 pr-2 font-bold">Player</th>
                <th className="text-left py-2 px-2 font-bold hidden sm:table-cell">Club</th>
                <th className="text-right py-2 px-2 font-bold">Ev</th>
                <th className="text-right py-2 px-2 font-bold">G</th>
                <th className="text-right py-2 px-2 font-bold">A</th>
                <th className="text-right py-2 pl-2 font-bold">Pts</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.fullName} className="border-t border-hairline">
                  <td className="py-2 pr-2 text-[13px] font-tight text-ink">
                    <Link
                      href={`/euf/players/by-name/${encodeURIComponent(p.fullName)}`}
                      prefetch={false}
                      className="no-underline hover:underline text-ink"
                    >
                      {p.fullName}
                    </Link>
                    {/* Club moves under the name on phones, where its own
                        column would squeeze the stat columns off-screen. */}
                    <span className="sm:hidden block text-[11px] text-muted mt-0.5 truncate">
                      {p.teamName}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-[13px] font-tight text-muted hidden sm:table-cell">
                    <span className="inline-flex items-center gap-1.5 min-w-0">
                      <EufFlag countryName={p.countryName} size={13} />
                      <span className="truncate">{p.teamName}</span>
                    </span>
                  </td>
                  <td className="text-right py-2 px-2 text-[13px] font-tight tabular-nums text-muted">
                    {p.events}
                  </td>
                  <td className="text-right py-2 px-2 text-[13px] font-tight tabular-nums text-ink">
                    {p.goals}
                  </td>
                  <td className="text-right py-2 px-2 text-[13px] font-tight tabular-nums text-muted">
                    {p.assists}
                  </td>
                  <td className="text-right py-2 pl-2 text-[13px] font-tight tabular-nums text-ink font-semibold">
                    {p.points}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
