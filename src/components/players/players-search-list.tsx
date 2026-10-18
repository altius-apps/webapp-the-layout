'use client';

// Players-page client list: big search bar at the top, results filter
// live underneath. Renders either the UFA stats table or the USAU stint
// list, depending on which dataset the server passed in.

import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { TeamLogo } from '@/components/team-logo';
import { teamMetaByAbbr } from '@/lib/ufa/teams';
import { SearchGlyph } from '@/components/search-modal';
import { SortableTh } from '@/components/players/sortable-th';
import type { UfaPlayerStat } from '@/lib/ufa/types';
import { searchUfaPlayers } from '@/lib/ufa/search-actions';
import { listUsauPlayers, type UsauPlayerListRow } from '@/lib/usau/data';
import type { UsauDivision, UsauLevel } from '@/lib/league';

type Mode =
  | {
      kind: 'ufa';
      stats: UfaPlayerStat[];
      /** Set of teamIDs that won the championship the year these stats
       *  cover. Used to mark champion rows with a trophy chip. */
      championTeamIds: string[];
      /** The year the prefetched stats cover. Used by the on-demand
       *  search server action so it queries the same season. */
      year: number;
    }
  | { kind: 'usau'; players: UsauPlayerListRow[]; division: UsauDivision; level: UsauLevel; loadFailed?: boolean };

interface Props {
  mode: Mode;
  /** Label shown next to the result count (e.g. "2026 UFA leaders"). */
  scopeLabel: string;
  /** Current sort field + direction (from the URL), for clickable column headers. */
  currentSort?: string;
  currentDir?: 'asc' | 'desc';
}

export function PlayersSearchList({ mode, scopeLabel, currentSort = 'impact', currentDir = 'desc' }: Props) {
  const [raw, setRaw] = useState('');
  const query = useDeferredValue(raw);
  const needle = query.trim().toLowerCase();

  // When the user types ≥ 2 chars, re-query the full dataset on the
  // server so matches outside the prefetched top-200 still show up.
  // Both leagues share the same shape: a debounced effect that flips a
  // single results buffer typed to whichever league is active.
  const [usauSearchResults, setUsauSearchResults] = useState<UsauPlayerListRow[] | null>(null);
  const [ufaSearchResults, setUfaSearchResults] = useState<UfaPlayerStat[] | null>(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const q = needle;
    if (q.length < 2) {
      setUsauSearchResults(null);
      setUfaSearchResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    // 200ms debounce — matches the global search modal's cadence.
    const t = setTimeout(async () => {
      try {
        if (mode.kind === 'usau') {
          const rows = await listUsauPlayers({
            limit: 200,
            search: q,
            genderDivision: mode.division,
            competitionLevel: mode.level,
          });
          if (!cancelled) {
            setUsauSearchResults(rows);
            setUfaSearchResults(null);
          }
        } else {
          const rows = await searchUfaPlayers(q, mode.year);
          if (!cancelled) {
            setUfaSearchResults(rows);
            setUsauSearchResults(null);
          }
        }
      } catch {
        if (!cancelled) {
          if (mode.kind === 'usau') setUsauSearchResults([]);
          else setUfaSearchResults([]);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mode, needle]);

  const filtered = useMemo(() => {
    if (!needle) return mode;
    if (mode.kind === 'ufa') {
      // Prefer server-side full-leaderboard search when present (catches
      // role players outside the prefetched top 200, e.g. Carter
      // Hawkins). Otherwise fall back to a client filter over the
      // prefetched set — covers the still-loading and < 2 char cases.
      if (ufaSearchResults != null) {
        return {
          kind: 'ufa' as const,
          stats: ufaSearchResults,
          championTeamIds: mode.championTeamIds,
          year: mode.year,
        };
      }
      return {
        kind: 'ufa' as const,
        stats: mode.stats.filter((p) => p.name.toLowerCase().includes(needle)),
        championTeamIds: mode.championTeamIds,
        year: mode.year,
      };
    }
    if (usauSearchResults != null) {
      return { kind: 'usau' as const, players: usauSearchResults, division: mode.division, level: mode.level };
    }
    return {
      kind: 'usau' as const,
      players: mode.players.filter((p) => {
        if (p.displayName.toLowerCase().includes(needle)) return true;
        return p.latestTeam?.toLowerCase().includes(needle) ?? false;
      }),
      division: mode.division,
      level: mode.level,
    };
  }, [mode, needle, ufaSearchResults, usauSearchResults]);

  const count =
    filtered.kind === 'ufa' ? filtered.stats.length : filtered.players.length;
  const totalCount =
    mode.kind === 'ufa' ? mode.stats.length : mode.players.length;

  return (
    <div className="flex flex-col gap-6">
      {/* Hero search */}
      <div className="relative">
        <span
          aria-hidden="true"
          className="absolute left-5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
        >
          <SearchGlyph size={18} />
        </span>
        <input
          type="search"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={
            mode.kind === 'ufa'
              ? 'Search UFA players by name…'
              : 'Search USAU players by name or team…'
          }
          aria-label="Search players"
          className={[
            'w-full bg-surface rounded-full shadow-card',
            'pl-12 pr-5 py-3.5 text-[15px] text-ink font-tight placeholder:text-faint',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-shadow',
          ].join(' ')}
        />
      </div>

      {/* Count line */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10.5px] font-bold tracking-[0.18em] uppercase text-accent font-sans">
          {scopeLabel}
        </span>
        <span className="text-[10px] font-bold tracking-[0.14em] uppercase text-faint font-tight">
          {searching
            ? 'Searching…'
            : needle
              ? (mode.kind === 'usau' && usauSearchResults != null) ||
                (mode.kind === 'ufa' && ufaSearchResults != null)
                ? `${count} ${count === 1 ? 'match' : 'matches'}`
                : `${count} of ${totalCount}`
              : `${totalCount} ${totalCount === 1 ? 'player' : 'players'}`}
        </span>
      </div>

      {/* List */}
      {searching && count === 0 ? null : count === 0 ? (
        <EmptyState query={needle} unavailable={mode.kind === 'usau' && mode.loadFailed === true && !needle} />
      ) : filtered.kind === 'ufa' ? (
        <UfaList stats={filtered.stats} championTeamIds={filtered.championTeamIds} currentSort={currentSort} currentDir={currentDir} />
      ) : (
        <UsauList players={filtered.players} />
      )}
    </div>
  );
}

function UfaList({
  stats,
  championTeamIds,
  currentSort,
  currentDir,
}: {
  stats: UfaPlayerStat[];
  championTeamIds: string[];
  currentSort: string;
  currentDir: 'asc' | 'desc';
}) {
  const champSet = new Set(championTeamIds.map((id) => id.toLowerCase()));
  // Alignment-neutral base — the Player column is left-aligned, stat columns are
  // right-aligned (thStat). Keeping `text-right` OUT of the base avoids the
  // conflicting `text-right text-left` on the Player header (it read right-aligned
  // even though the name cells below are left-aligned).
  const thBase =
    'px-3 py-3 text-[10px] font-bold tracking-wide uppercase text-faint whitespace-nowrap';
  const thStat = `${thBase} text-right`;
  // Cap the Player column so one long name can't balloon it to 2/3 of the row.
  // The name itself scrolls horizontally inside this fixed box (see the <td>).
  const playerColCls = 'w-[150px] min-w-[150px] max-w-[150px] sm:w-[200px] sm:min-w-[200px] sm:max-w-[200px]';
  // Clickable stat header — maps a UFA column to its ?sort= field. (Cmp% has no
  // API sort field, so it stays a plain header.)
  const sortableProps = (field: string, accent = false) => ({
    sortField: field,
    currentSort,
    currentDir,
    accent,
    className: `${thStat}${accent ? ' text-accent' : ''}`,
  });
  return (
    <div className="overflow-x-auto bg-surface rounded-card-lg shadow-card">
      <table className="w-full min-w-[920px] border-collapse table-fixed">
        <thead>
          <tr>
            <th className={`${thBase} text-left pl-5 ${playerColCls}`} scope="col">Player</th>
            <SortableTh label="GP" title="Games Played" {...sortableProps('gamesPlayed')} />
            <SortableTh label="G" title="Goals" {...sortableProps('goals')} />
            <SortableTh label="A" title="Assists" {...sortableProps('assists')} />
            <SortableTh label="HA" title="Hockey Assists" {...sortableProps('hockeyAssists')} />
            <SortableTh label="Scr" title="Scores (Goals + Assists)" {...sortableProps('scores')} />
            <SortableTh label="IMP" title="Impact (Goals + Assists + Blocks)" {...sortableProps('impact', true)} />
            <SortableTh label="Cmp" title="Completions" {...sortableProps('completions')} />
            <th className={thStat} scope="col" title="Completion %">Cmp%</th>
            <SortableTh label="TA" title="Throwaways" {...sortableProps('throwaways')} />
            <SortableTh label="D" title="Drops" {...sortableProps('drops')} />
            <SortableTh label="Blk" title="Blocks" {...sortableProps('blocks')} />
            <SortableTh label="+/−" title="Plus / Minus" {...sortableProps('plusMinus')} className={`${thStat} pr-5`} />
          </tr>
        </thead>
        <tbody>
          {stats.map((p, i) => {
            const teamAbbr =
              typeof p.teamID === 'string'
                ? p.teamID
                : typeof p.teamAbbrev === 'string'
                  ? (p.teamAbbrev as string)
                  : null;
            const team = teamAbbr ? teamMetaByAbbr(teamAbbr) : null;
            const isChamp = teamAbbr ? champSet.has(teamAbbr.toLowerCase()) : false;
            const rowTop = i === 0 ? '' : 'border-t border-hairline';
            return (
              <tr key={p.playerID} className="hover:bg-surface-hi transition-colors duration-100">
                <td className={`px-3 py-2.5 text-[13px] text-left pl-5 ${rowTop} ${playerColCls}`}>
                  <Link
                    href={`/players/${p.playerID}?from=ufa`} prefetch={false}
                    className="flex items-center gap-2 hover:opacity-80 transition-opacity no-underline"
                  >
                    <span className="tabular text-[10px] font-bold text-faint font-tight w-5 text-right flex-shrink-0">
                      {i + 1}
                    </span>
                    {team && (
                      <span className="flex-shrink-0 inline-flex rounded-full overflow-hidden">
                        <TeamLogo team={team} size={22} />
                      </span>
                    )}
                    {/* Name scrolls horizontally within the fixed Player column
                        so a long name never widens the column. */}
                    <span className="font-medium font-tight text-ink whitespace-nowrap overflow-x-auto no-scrollbar min-w-0">
                      {p.name}
                    </span>
                    {isChamp && <TrophyChip title="Reigning UFA Champion" />}
                  </Link>
                </td>
                <Cell value={p.gamesPlayed} rowTop={rowTop} />
                <Cell value={p.goals} rowTop={rowTop} />
                <Cell value={p.assists} rowTop={rowTop} />
                <Cell value={p.hockeyAssists} rowTop={rowTop} />
                <Cell value={p.scores} bold rowTop={rowTop} />
                <ImpactCell value={(p.goals ?? 0) + (p.assists ?? 0) + (p.blocks ?? 0)} rowTop={rowTop} />
                <Cell value={p.completions} rowTop={rowTop} />
                <Cell value={p.completionPercentage ? `${p.completionPercentage}%` : '—'} rowTop={rowTop} />
                <Cell value={p.throwaways} rowTop={rowTop} />
                <Cell value={p.drops} rowTop={rowTop} />
                <Cell value={p.blocks} rowTop={rowTop} />
                <Cell value={signed(p.plusMinus)} rowTop={rowTop} pr />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Cell({
  value,
  bold,
  rowTop,
  pr,
}: {
  value: string | number | undefined;
  bold?: boolean;
  rowTop?: string;
  pr?: boolean;
}) {
  return (
    <td
      className={[
        'px-3 py-2.5 text-[13px] text-right tabular font-tight',
        rowTop ?? '',
        pr ? 'pr-5' : '',
        bold ? 'text-ink font-semibold' : 'text-muted',
      ].join(' ')}
    >
      {value ?? '—'}
    </td>
  );
}

// Impact (Goals + Assists + Blocks) — the default ranking metric, so it reads
// in the accent color + bold to stand out from the neutral stat columns.
function ImpactCell({ value, rowTop }: { value: number; rowTop?: string }) {
  return (
    <td
      className={[
        'px-3 py-2.5 text-[13px] text-right tabular font-tight font-bold text-accent',
        rowTop ?? '',
      ].join(' ')}
    >
      {value}
    </td>
  );
}

function signed(n: number | undefined | null): string {
  if (n == null) return '0';
  if (n === 0) return '0';
  return n > 0 ? `+${n}` : String(n);
}

function UsauList({ players }: { players: UsauPlayerListRow[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {players.map((p, i) => (
        <Link
          key={p.id}
          href={`/players/${p.id}?from=usau`} prefetch={false}
          className="flex items-center gap-3 px-4 py-3 bg-surface rounded-card shadow-card hover:shadow-lift transition-shadow cursor-pointer no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="tabular font-mono text-[11px] font-bold text-faint w-6 text-right flex-shrink-0">
            {i + 1}
          </span>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="text-[14px] font-semibold text-ink font-tight truncate">
                {p.displayName}
              </span>
              {p.championYears.length > 0 && (
                <TrophyChip
                  title={
                    p.championYears.length === 1
                      ? `USAU National Champion · ${p.championYears[0]}`
                      : `${p.championYears.length}× USAU National Champion`
                  }
                />
              )}
            </span>
            {p.latestTeam && (
              <span className="text-[11px] text-muted font-tight truncate">
                {p.latestTeam}
                {p.latestSeason && ` · ${p.latestSeason}`}
              </span>
            )}
          </div>
          <span className="text-[10px] font-bold tracking-[0.14em] uppercase text-faint font-tight whitespace-nowrap">
            {p.appearances} {p.appearances === 1 ? 'stint' : 'stints'}
          </span>
        </Link>
      ))}
    </div>
  );
}

function TrophyChip({ title }: { title: string }) {
  return (
    <span
      title={title}
      aria-label={title}
      className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full bg-accent text-accent-ink flex-shrink-0"
    >
      <svg width="10" height="10" viewBox="0 0 22 22" fill="none" aria-hidden="true">
        <path d="M6 3h10v5a5 5 0 0 1-10 0V3Z" stroke="currentColor" strokeWidth="1.8" />
        <path d="M6 5H3v2a2 2 0 0 0 2 2M16 5h3v2a2 2 0 0 1-2 2" stroke="currentColor" strokeWidth="1.8" />
        <path d="M11 13v3M8 19h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function EmptyState({ query, unavailable = false }: { query: string; unavailable?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 text-center bg-surface rounded-card-lg shadow-card">
      <div className="text-[13px] font-semibold uppercase tracking-[0.18em] text-muted mb-1 font-tight">
        {unavailable ? 'List unavailable' : 'No matches'}
      </div>
      <div className="text-[12px] text-faint font-tight">
        {unavailable
          ? "The player list didn't load. Search still works, or refresh in a minute."
          : query
            ? `Nothing for "${query}".`
            : 'Try a different search.'}
      </div>
    </div>
  );
}
