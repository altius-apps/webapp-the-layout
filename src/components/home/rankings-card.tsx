// USAU Rankings card — full-width companion to the UFA standings strip.
// White card (rounded-card-lg shadow-card p-7), SectionHead inside (eyebrow +
// "Rankings" title + "Full poll" action), division pill tabs, then a 4×4 grid
// of the top 16 teams in the active division (see usau-division-toggle.tsx).
// TOP 16 — enough to fill a 4-wide grid at 4 rows; the "Full poll" link is
// where the complete list lives.
//
// Data fetching mirrors the old UsauRankingsSection (league-standings-sections.tsx);
// interactive division tabs are a 'use client' sub-component fed pre-fetched data.

import Link from 'next/link';
import { clubStandingFinish, type OfficialRankedTeam } from '@/lib/usau/data';
import { listOfficialUsauRankingsCached, listUsauClubStandingsCached } from '@/lib/cached-readers';
import { RankingsDivisionToggle } from '@/components/home/usau-division-toggle';

const TOP_N = 16;

// The 5 published rank sets + their display labels / logo metadata.
// tinyLabel is the ultra-compact form used below `sm` so all 5 pills fit one
// row on a 320px phone; shortLabel is the roomier tablet/desktop form.
const RANK_DIVISIONS = [
  { key: 'Club-Men' as const, label: 'Club Men', shortLabel: 'Club M', tinyLabel: 'Club M', genderDivision: 'Men', competitionLevel: 'CLUB' },
  { key: 'Club-Women' as const, label: 'Club Women', shortLabel: 'Club W', tinyLabel: 'Club W', genderDivision: 'Women', competitionLevel: 'CLUB' },
  { key: 'Club-Mixed' as const, label: 'Club Mixed', shortLabel: 'Mixed', tinyLabel: 'Mixed', genderDivision: 'Mixed', competitionLevel: 'CLUB' },
  { key: 'College-Men' as const, label: 'College Men', shortLabel: 'College M', tinyLabel: 'Coll M', genderDivision: 'Men', competitionLevel: 'COLLEGE_D1' },
  { key: 'College-Women' as const, label: 'College Women', shortLabel: 'College W', tinyLabel: 'Coll W', genderDivision: 'Women', competitionLevel: 'COLLEGE_D1' },
] as const;

/** A ranked tile; `finish` ("T-3 · Nationals") is set for final standings. */
export type RankingsTeam = OfficialRankedTeam & { finish?: string };

export type UsauDivisionData = {
  key: string;
  label: string;
  shortLabel: string;
  tinyLabel: string;
  genderDivision: string;
  competitionLevel: string;
  season: number;
  week: number;
  scrapedAt: string | null;
  teams: RankingsTeam[];
  /** 'standings' = season-final Club standings (after Nationals), else the poll. */
  source: 'poll' | 'standings';
  /** Per-division source line, set only when standings and poll are mixed. */
  caption: string | null;
};

type DivisionFetch = Pick<UsauDivisionData, 'season' | 'week' | 'scrapedAt' | 'teams' | 'source'>;

async function fetchDivision(div: (typeof RANK_DIVISIONS)[number]): Promise<DivisionFetch> {
  // After Club Nationals, Club shows how teams finished until next season's
  // first poll lands (null = show the poll).
  if (div.competitionLevel === 'CLUB') {
    const standings = await listUsauClubStandingsCached(div.genderDivision, TOP_N);
    if (standings && standings.teams.length > 0) {
      return {
        source: 'standings',
        season: standings.season,
        week: 0,
        scrapedAt: standings.builtAt,
        teams: standings.teams.map((t) => ({
          id: t.id,
          name: t.name,
          state: t.state,
          region: null,
          rank: t.rank,
          rating: t.rating,
          wins: t.wins,
          losses: t.losses,
          // Tiles are narrow and the top 16 are the Nationals field: "T-3", not "T-3 · Nationals".
          finish: clubStandingFinish(t).replace(/ · Nationals$/, ''),
        })),
      };
    }
  }
  return { source: 'poll', ...(await listOfficialUsauRankingsCached(div.key, TOP_N)) };
}

export async function RankingsCard() {
  // Fetch all 5 divisions in parallel — a failure in any one is non-fatal.
  // Each reader is asked for exactly TOP_N so mobile and desktop both render
  // straight from the fetch, with no client-side slicing to forget in one of
  // the two render paths.
  const results = await Promise.allSettled(RANK_DIVISIONS.map(fetchDivision));

  const divisions: UsauDivisionData[] = RANK_DIVISIONS.map((div, i) => {
    const res = results[i];
    if (res.status === 'fulfilled') {
      return {
        key: div.key,
        label: div.label,
        shortLabel: div.shortLabel,
        tinyLabel: div.tinyLabel,
        genderDivision: div.genderDivision,
        competitionLevel: div.competitionLevel,
        season: res.value.season,
        week: res.value.week,
        scrapedAt: res.value.scrapedAt,
        teams: res.value.teams.slice(0, TOP_N),
        source: res.value.source,
        caption: null,
      };
    }
    return {
      key: div.key,
      label: div.label,
      shortLabel: div.shortLabel,
      tinyLabel: div.tinyLabel,
      genderDivision: div.genderDivision,
      competitionLevel: div.competitionLevel,
      season: 0,
      week: 0,
      scrapedAt: null,
      teams: [],
      source: 'poll',
      caption: null,
    };
  });

  // Only render divisions that have data.
  const populated = divisions.filter((d) => d.teams.length > 0);
  const firstPopulated = populated[0];

  // Club on final standings while College is still on the poll: the shared
  // eyebrow can't describe both, so each division carries its own source line.
  const hasStandings = populated.some((d) => d.source === 'standings');
  if (hasStandings) {
    for (const d of populated) {
      d.caption =
        d.source === 'standings'
          ? `${d.season} final standings · Nationals, then Regionals & Sectionals`
          : `Official poll · Week ${d.week}`;
    }
  }

  if (populated.length === 0) {
    // Graceful "coming soon" placeholder — same chrome, no rows.
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-5 lg:p-7">
        <RankingsHeader eyebrow="USAU · Official" attribution={null} />
        <span className="font-mono text-[11px] text-faint tracking-[0.06em]">
          Rankings coming soon — check back after the first ranking week.
        </span>
      </div>
    );
  }

  const scrapedAtLabel = firstPopulated?.scrapedAt
    ? `Updated ${new Date(firstPopulated.scrapedAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })}`
    : null;

  const eyebrow = hasStandings
    ? 'USAU'
    : [
        'USAU',
        firstPopulated?.week ? `Week ${firstPopulated.week}` : null,
        'Official',
      ]
        .filter(Boolean)
        .join(' · ');

  return (
    <div className="bg-surface rounded-card-lg shadow-card p-5 lg:p-7">
      <RankingsHeader
        eyebrow={eyebrow}
        attribution={scrapedAtLabel}
        linkLabel={hasStandings ? 'Full rankings' : 'Full poll'}
      />
      <RankingsDivisionToggle divisions={populated} />
    </div>
  );
}

function RankingsHeader({
  eyebrow,
  attribution,
  linkLabel = 'Full poll',
}: {
  eyebrow: string;
  attribution: string | null;
  linkLabel?: string;
}) {
  return (
    <div className="flex items-end justify-between gap-4 mb-4">
      <div>
        <span className="block text-[10.5px] font-bold tracking-[0.18em] uppercase text-accent font-sans mb-2">
          {eyebrow}
        </span>
        <h2 className="font-display italic font-bold text-[26px] lg:text-[34px] leading-[0.95] tracking-[-0.02em] text-ink m-0">
          Rankings
        </h2>
      </div>
      <div className="flex flex-col items-end gap-1.5">
        {attribution && (
          <span className="font-mono text-[10px] text-faint tracking-[0.06em] hidden sm:block">
            {attribution}
          </span>
        )}
        <Link
          href="/teams?league=usau"
          className="text-[11px] font-bold tracking-[0.12em] uppercase text-muted no-underline inline-flex items-center gap-1.5 hover:text-accent transition-colors whitespace-nowrap"
        >
          {linkLabel}
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8H13M13 8L8.5 3.5M13 8L8.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
          </svg>
        </Link>
      </div>
    </div>
  );
}
