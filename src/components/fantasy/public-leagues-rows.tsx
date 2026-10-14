'use client';

// Rows + competition filter for the hub's Public section. Rows come from the
// server (cached); this island only filters them and hosts the JOIN pill.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { PillSelect, type PillSelectOption } from '@/components/pill-select';
import { LeagueLogo } from '@/components/fantasy/league-logo';
import { OfficialBadge } from '@/components/fantasy/official-badge';
import { JoinPublicLeagueButton } from '@/components/fantasy/join-public-league-button';

export interface PublicLeagueView {
  leagueId: string;
  contestId: string;
  name: string;
  logoUrl: string | null;
  logoIcon: string | null;
  logoSrc: string | null;
  isOfficial: boolean;
  open: boolean;
  competition: string;
  competitionLabel: string;
  memberCount: number;
  lockLabel: string;
}

const ALL = 'all';

export function PublicLeaguesRows({ rows }: { rows: PublicLeagueView[] }) {
  const [competition, setCompetition] = useState<string>(ALL);

  const options = useMemo<PillSelectOption<string>[]>(() => {
    const seen = new Map<string, string>();
    for (const r of rows) seen.set(r.competition, r.competitionLabel);
    return [{ value: ALL, label: 'All' }, ...[...seen].map(([value, label]) => ({ value, label }))];
  }, [rows]);

  const shown = competition === ALL ? rows : rows.filter((r) => r.competition === competition);

  return (
    <>
      {options.length > 2 && (
        <div className="mb-3">
          <PillSelect value={competition} options={options} onChange={setCompetition} ariaLabel="Filter public leagues by game" />
        </div>
      )}
      <div className="bg-surface rounded-card-lg shadow-card overflow-hidden">
        <ul aria-label="Public leagues">
          {shown.map((r, idx) => (
            <li
              key={r.contestId}
              className={['flex items-center gap-3 pr-5', idx > 0 ? 'border-t border-hairline' : ''].join(' ')}
            >
              <Link
                href={`/fantasy/l/${r.contestId}`}
                className={[
                  'min-w-0 flex-1 flex items-center gap-3 pl-5 py-3.5',
                  'no-underline transition-colors duration-150 hover:bg-surface-hi',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                ].join(' ')}
              >
                <LeagueLogo name={r.name} logoUrl={r.logoUrl} logoIcon={r.logoIcon} logoSrc={r.logoSrc} size={40} />
                <span className="min-w-0 flex-1 flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="font-tight text-[14px] font-semibold text-ink truncate">{r.name}</span>
                    {r.isOfficial && <OfficialBadge />}
                  </span>
                  <span className="font-tight text-[11px] text-muted truncate">
                    {r.competitionLabel} · {r.lockLabel}
                    {r.memberCount > 0 && ` · ${r.memberCount.toLocaleString('en-US')} ${r.memberCount === 1 ? 'player' : 'players'}`}
                  </span>
                </span>
              </Link>
              {r.open ? (
                <JoinPublicLeagueButton leagueId={r.leagueId} contestId={r.contestId} />
              ) : (
                <Link
                  href={`/fantasy/l/${r.contestId}`}
                  className="flex-shrink-0 font-tight text-[11px] font-bold tracking-[0.06em] uppercase text-muted hover:text-accent no-underline transition-colors duration-150 focus-visible:outline-none focus-visible:underline"
                >
                  View
                </Link>
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
