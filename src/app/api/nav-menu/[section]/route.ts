// Data for the mega-menu flyouts (Feature Backlog #23, 2026-10-11). The menu
// used to import the league data libs into the browser and query the DB on
// every open; each section is now built here at most once an hour (ISR) and
// shared by every visitor. generateStaticParams returns [] so the build never
// needs the DB (App Health rule 5) — a section is generated on its first
// request. A failed build throws (500), so ISR keeps serving the last good copy.

import { NextResponse } from 'next/server';
import { listOfficialUsauRankings, listTopUsauTeams } from '@/lib/usau/data';
import { listTopPulTeams } from '@/lib/pul/data';
import { listEvents as listWfdfEvents } from '@/lib/wfdf/data';
import { listEvents as listEufEvents } from '@/lib/euf/data';
import type { NavMenuSection } from '@/lib/nav-menu-sections';

export const revalidate = 3600;

export function generateStaticParams() {
  return [];
}

const SECTIONS: Record<NavMenuSection, () => Promise<unknown>> = {
  usau: async () => {
    const [Men, Women, Mixed] = await Promise.all([
      listTopUsauTeams({ genderDivision: 'Men', limit: 8 }),
      listTopUsauTeams({ genderDivision: 'Women', limit: 8 }),
      listTopUsauTeams({ genderDivision: 'Mixed', limit: 8 }),
    ]);
    return { Men, Women, Mixed };
  },
  'usau-college': async () => {
    const [men, women] = await Promise.all([
      listOfficialUsauRankings('College-Men', 8),
      listOfficialUsauRankings('College-Women', 8),
    ]);
    return {
      Men: men.teams.map((t) => ({ id: t.id, name: t.name, rank: t.rank })),
      Women: women.teams.map((t) => ({ id: t.id, name: t.name, rank: t.rank })),
    };
  },
  pul: () => listTopPulTeams(),
  wfdf: async () => (await listWfdfEvents()).slice(0, 8).map((e) => ({ slug: e.slug, name: e.name, year: e.year })),
  euf: async () => (await listEufEvents()).slice(0, 8).map((e) => ({ slug: e.slug, name: e.name, year: e.year })),
};

export async function GET(_req: Request, { params }: { params: { section: string } }) {
  // Own keys only: "constructor" / "toString" must not resolve.
  if (!Object.hasOwn(SECTIONS, params.section)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const build = SECTIONS[params.section as NavMenuSection];
  return NextResponse.json(await build());
}
