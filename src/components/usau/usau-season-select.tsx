'use client';

// USAU season picker, bound to ?season=YYYY | 'all'. Lives on the /scores
// results feed (moved off the schedule 2026-08-16 for mobile parity — the
// schedule is future-facing, so "which season's results" belongs here).
// Absent ?season ⇒ the level's default season (same rule as the server's
// resolveUsauSeason); 'all' ⇒ every season.

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PillSelect } from '@/components/pill-select';
import { listSeasons } from '@/lib/usau/data';
import { parseLevelParam } from '@/lib/league';
import { defaultSeason, pickSeason, usauSeasonLeague } from '@/lib/season-windows';

const ALL = 'all' as const;

export function UsauSeasonSelect() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [seasons, setSeasons] = useState<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    listSeasons()
      .then((s) => !cancelled && setSeasons(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (seasons.length === 0) return null;

  const raw = searchParams.get('season');
  const paramSeason = Number(raw);
  const fallback =
    pickSeason(seasons, defaultSeason(usauSeasonLeague(parseLevelParam(searchParams.get('level'))))) ?? seasons[0];
  const current: number | typeof ALL =
    raw === ALL ? ALL : seasons.includes(paramSeason) ? paramSeason : fallback;

  const onChange = (next: number | typeof ALL) => {
    const params = new URLSearchParams(searchParams.toString());
    // The default season → keep the URL clean by omitting it.
    if (next === fallback) params.delete('season');
    else params.set('season', String(next));
    // A season change re-defines the result set — restart at page 1.
    params.delete('page');
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
  };

  return (
    <PillSelect<number | typeof ALL>
      value={current}
      onChange={onChange}
      ariaLabel="Select season"
      options={[
        ...seasons.map((y) => ({ value: y, label: `${y} Season` })),
        { value: ALL, label: 'All seasons' },
      ]}
    />
  );
}
