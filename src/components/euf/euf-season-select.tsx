'use client';

// EUCS season picker for /euf/events, bound to ?season=YYYY | 'all'.
// Mirrors UsauSeasonSelect, but `years` comes in as a prop instead of a
// second client-side fetch — listEvents() already ran server-side with every
// event's year attached, so there's nothing left to look up here.
// Absent ?season ⇒ the EUF default season (season-windows.ts), not simply the
// newest year with data; 'all' ⇒ every season.

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PillSelect } from '@/components/pill-select';
import { defaultSeason, pickSeason } from '@/lib/season-windows';

const ALL = 'all' as const;

export function EufSeasonSelect({ years }: { years: number[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (years.length === 0) return null;

  const raw = searchParams.get('season');
  const paramSeason = Number(raw);
  const fallback = eufDefaultYear(years);
  const current: number | typeof ALL =
    raw === ALL ? ALL : years.includes(paramSeason) ? paramSeason : fallback;

  const onChange = (next: number | typeof ALL) => {
    const params = new URLSearchParams(searchParams.toString());
    // The default season → keep the URL clean by omitting it.
    if (next === fallback) params.delete('season');
    else params.set('season', String(next));
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
  };

  return (
    <PillSelect<number | typeof ALL>
      value={current}
      onChange={onChange}
      ariaLabel="Select season"
      options={[
        ...years.map((y) => ({ value: y, label: `${y} Season` })),
        { value: ALL, label: 'All seasons' },
      ]}
    />
  );
}

/** Resolves the current ?season= value the same way EufSeasonSelect does, so
 *  the events body (also a client component) can pick which events to render
 *  without duplicating this logic. */
export function resolveEufSeason(
  searchParams: URLSearchParams | ReturnType<typeof useSearchParams>,
  years: number[],
): number | typeof ALL {
  if (years.length === 0) return ALL;
  const raw = searchParams.get('season');
  if (raw === ALL) return ALL;
  const paramSeason = Number(raw);
  return years.includes(paramSeason) ? paramSeason : eufDefaultYear(years);
}

function eufDefaultYear(years: number[]): number {
  return pickSeason(years, defaultSeason('euf')) ?? years[0];
}

export { ALL as EUF_ALL_SEASONS };
