'use client';

// Client half of /euf/clubs — country dropdown + division tabs over the club list.
//
// Country is a PillSelect dropdown rather than a pill row: there are 21
// countries, well past the point where a row of pills stops being scannable.
// Division is the tournament pages' frozen segmented tabs, tap-only so just the
// active tab renders (no added page weight).
//
// ?div= seeds the tab, read from window.location in an effect rather than
// useSearchParams: that hook would force a Suspense boundary and drop the
// club list from this page's static HTML.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PillSelect } from '@/components/pill-select';
import { DivisionPager } from '@/components/division-pager';
import { EufFlag } from '@/components/euf/euf-flag';
import type { EufClubCard, EufDivision } from '@/lib/euf/data';

interface Props {
  clubs: EufClubCard[];
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export function EufClubBrowse({ clubs }: Props) {
  const [country, setCountry] = useState('all');
  const [division, setDivisionState] = useState('all');

  useEffect(() => {
    const seed = new URLSearchParams(window.location.search).get('div');
    if (seed) setDivisionState(seed);
  }, []);

  const setDivision = (next: string) => {
    setDivisionState(next);
    const params = new URLSearchParams(window.location.search);
    if (next === 'all') params.delete('div');
    else params.set('div', next);
    const qs = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  };

  const countryOptions = useMemo(() => {
    const names = Array.from(
      new Set(clubs.map((c) => c.countryName).filter((n): n is string => Boolean(n))),
    ).sort();
    return [
      { value: 'all', label: `All countries (${names.length})` },
      ...names.map((n) => ({ value: n, label: n })),
    ];
  }, [clubs]);

  const divisionOptions = useMemo(() => {
    const divs = new Set(clubs.map((c) => c.division));
    return [
      { value: 'all', label: 'All', ariaLabel: 'All divisions' },
      ...(['Open', "Women's", 'Mixed'] as EufDivision[])
        .filter((d) => divs.has(d))
        .map((d) => ({ value: d, label: d })),
    ];
  }, [clubs]);

  const activeDivision = divisionOptions.some((o) => o.value === division) ? division : 'all';

  const clubsFor = (div: string) =>
    clubs.filter(
      (c) =>
        (country === 'all' || c.countryName === country) && (div === 'all' || c.division === div),
    );
  const shownCount = clubsFor(activeDivision).length;

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2">
        <PillSelect
          value={country}
          options={countryOptions}
          onChange={setCountry}
          ariaLabel="Filter clubs by country"
        />
        <span className="text-[11px] text-muted font-tight tabular-nums ml-auto">
          {shownCount} {shownCount === 1 ? 'club' : 'clubs'}
        </span>
      </div>

      <DivisionPager
        divisions={divisionOptions}
        active={activeDivision}
        onChange={setDivision}
        renderDivision={(div) => <ClubGrid clubs={clubsFor(div)} />}
        fill
        swipe={false}
      />
    </div>
  );
}

function ClubGrid({ clubs }: { clubs: EufClubCard[] }) {
  if (clubs.length === 0) {
    return (
      <div className="rounded-card-lg bg-surface shadow-card p-10 text-center">
        <p className="text-muted font-tight text-[14px]">No clubs match those filters.</p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {clubs.map((c) => (
        <Link
          key={`${c.key}-${c.division}`}
          href={`/euf/clubs/${encodeURIComponent(c.name)}?div=${encodeURIComponent(c.division)}`}
          prefetch={false}
          className={[
            'rounded-card bg-surface shadow-card p-4 no-underline flex flex-col gap-1.5',
            'transition-shadow hover:shadow-lift cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          ].join(' ')}
        >
          <span className="flex items-center gap-2 min-w-0">
            <EufFlag countryName={c.countryName} size={15} />
            <span className="text-[15px] font-semibold text-ink font-tight truncate">
              {c.name}
            </span>
          </span>
          <span className="text-[11px] text-muted font-tight">
            {[c.countryName, c.division, `${c.events} ${c.events === 1 ? 'event' : 'events'}`]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <span className="text-[11px] text-faint font-tight tabular-nums">
            {c.firstYear === c.lastYear ? c.firstYear : `${c.firstYear}–${c.lastYear}`}
            {c.bestPlacement ? ` · best ${ordinal(c.bestPlacement)}` : ''}
          </span>
        </Link>
      ))}
    </div>
  );
}
