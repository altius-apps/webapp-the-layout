'use client';

// Year picker for a recurring tournament (Club Nationals, US Open, the TCT
// flight events…): each option is that year's edition, a separate event page.
// Keeps ?div / ?tab so you land on the same division and tab. Reads them from
// window at click time rather than useSearchParams, so the ISR event page
// needs no extra Suspense boundary for it.

import { useRouter } from 'next/navigation';
import { PillSelect } from '@/components/pill-select';
import type { TournamentEdition } from '@/lib/usau/data';

export function UsauEditionSelect({ season, editions }: { season: number; editions: TournamentEdition[] }) {
  const router = useRouter();

  function handleChange(next: number) {
    const target = editions.find((e) => e.season === next);
    if (!target || next === season) return;
    const params = new URLSearchParams(window.location.search);
    const qs = new URLSearchParams();
    for (const k of ['div', 'tab']) {
      const v = params.get(k);
      if (v) qs.set(k, v);
    }
    router.push(`/usau/events/${encodeURIComponent(target.slug)}${qs.size ? `?${qs}` : ''}`);
  }

  // z-50: the menu opens down over the tab bar and division toggle below the
  // header, which otherwise paint on top of it.
  return (
    <div className="relative z-50">
      <PillSelect
        value={season}
        onChange={handleChange}
        ariaLabel="Select tournament year"
        options={editions.map((e) => ({ value: e.season, label: String(e.season) }))}
      />
    </div>
  );
}
