'use client';

// Client-side season filter for the EUCS club history. Mirrors
// UsauTeamHistory's interaction pattern: a season dropdown (newest first,
// default newest) that scopes the tournament cards + roster below it.
//
// Unlike USAU, EUCS has no seeds or pool assignment at the team level, and
// the roster is fetched per-season up front (one request per season, all
// sent from the server) rather than embedded — see the page for why.

import Link from 'next/link';
import { useState } from 'react';
import type { EufClubAppearance, EufClubSeasonPlayer } from '@/lib/euf/data';
import { eufDateRange } from '@/lib/euf/format-date';
import { PillSelect } from '@/components/pill-select';

export interface EufClubSeason {
  year: number;
  appearances: EufClubAppearance[];
  roster: EufClubSeasonPlayer[];
}

interface Props {
  seasons: EufClubSeason[];
  /** Season to open on (?season= deep link); ignored if we have no such season. */
  initialSeason?: number | null;
}

export function EufClubHistory({ seasons, initialSeason = null }: Props) {
  const [selected, setSelected] = useState<number | null>(() =>
    initialSeason != null && seasons.some((s) => s.year === initialSeason)
      ? initialSeason
      : seasons[0]?.year ?? null,
  );

  if (seasons.length === 0) {
    return <div className="text-[12px] text-faint font-tight">No history recorded yet.</div>;
  }

  const active = seasons.find((s) => s.year === selected) ?? seasons[0];

  return (
    <section aria-labelledby="history-heading">
      <div className="flex items-center justify-between gap-3 mb-4 pb-2 border-b border-hairline">
        <h2
          id="history-heading"
          className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight"
        >
          Season history
        </h2>
        <SeasonDropdown seasons={seasons} value={active.year} onChange={setSelected} />
      </div>

      <div className="flex flex-col gap-6">
        {/* Quick stats for the selected season */}
        <div className="flex items-center gap-4 text-[10px] font-bold tracking-[0.16em] uppercase text-faint font-tight">
          <span>
            <span className="tabular text-ink">{active.appearances.length}</span>{' '}
            {active.appearances.length === 1 ? 'event' : 'events'}
          </span>
          <span>
            <span className="tabular text-ink">{active.roster.length}</span>{' '}
            {active.roster.length === 1 ? 'player' : 'players'}
          </span>
        </div>

        {active.appearances.length > 0 && (
          <div>
            <div className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight mb-2">
              Tournaments
            </div>
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {active.appearances.map((a) => (
                <EventCard key={a.teamId} appearance={a} />
              ))}
            </ul>
          </div>
        )}

        {active.roster.length > 0 && (
          <div className="bg-surface rounded-card-lg shadow-card p-4 lg:p-5">
            <div className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight mb-2 px-1">
              Roster
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {active.roster.map((p) => (
                <li key={p.key}>
                  <Link
                    href={`/euf/players/by-name/${encodeURIComponent(p.fullName)}`}
                    prefetch={false}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-card-sm hover:bg-ink/[0.04] transition-colors no-underline"
                  >
                    <span
                      aria-hidden="true"
                      className="tabular text-[12px] font-bold text-faint font-tight w-7 text-right flex-shrink-0"
                    >
                      {p.jerseyNumber ?? '—'}
                    </span>
                    <span className="flex-1 min-w-0 text-[13px] font-semibold text-ink font-tight truncate">
                      {p.fullName}
                    </span>
                    <span className="tabular text-[11px] font-bold text-muted font-tight flex-shrink-0">
                      {p.goals}G {p.assists}A
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {active.appearances.length === 0 && active.roster.length === 0 && (
          <div className="text-[12px] text-faint font-tight py-2">
            No tournaments or roster recorded for {active.year}.
          </div>
        )}
      </div>
    </section>
  );
}

function SeasonDropdown({
  seasons,
  value,
  onChange,
}: {
  seasons: EufClubSeason[];
  value: number;
  onChange: (year: number) => void;
}) {
  return (
    <PillSelect
      value={value}
      onChange={onChange}
      ariaLabel="Select season"
      options={seasons.map((s) => ({ value: s.year, label: `${s.year} Season` }))}
    />
  );
}

/** "1st" / "2nd" / "3rd" / "4th" … */
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/** The club's finish at a tournament. Podium places (1–3) get a medal-tinted
 *  chip; everything else is a clean "Nth place" label. Mirrors USAU's
 *  PlacementBadge — except the gold "Champions" chip is EUCF-ONLY (Hunter's
 *  call): winning a tour stop or invite is a 1st-place finish, not a
 *  European title. */
function PlacementBadge({ place, eucf }: { place: number; eucf: boolean }) {
  const podium =
    place === 1 && eucf
      ? { ring: 'bg-[#E8B923]/15 text-[#9A7B0A]', label: 'Champions' }
      : place === 2
        ? { ring: 'bg-[#9AA3AD]/20 text-[#5C6672]', label: `${ordinal(place)} place` }
        : place === 3
          ? { ring: 'bg-[#C77B3B]/15 text-[#8A5222]', label: `${ordinal(place)} place` }
          : null;

  if (podium) {
    return (
      <span
        className={[
          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1',
          'text-[11px] font-bold tracking-[0.06em] uppercase font-tight',
          podium.ring,
        ].join(' ')}
      >
        <MedalGlyph />
        {podium.label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-ink/[0.05] px-2.5 py-1 text-[11px] font-bold tracking-[0.06em] uppercase text-muted font-tight">
      {ordinal(place)} place
    </span>
  );
}

function MedalGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="15" r="6" stroke="currentColor" strokeWidth="2" />
      <path d="M8 4l4 6 4-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EventCard({ appearance: a }: { appearance: EufClubAppearance }) {
  const date = a.startDate ? eufDateRange(a.startDate, a.startDate) : null;
  const diff = a.scoresFor - a.scoresAgainst;
  return (
    <li>
      <Link
        href={`/euf/events/${a.eventSlug}`}
        prefetch={false}
        className="group block bg-surface rounded-card shadow-card p-3.5 transition-shadow hover:shadow-lift cursor-pointer no-underline"
      >
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-faint font-tight truncate">
            {date ?? '—'}
          </span>
        </div>
        <div className="font-display italic font-bold text-[17px] leading-tight tracking-[-0.02em] text-ink group-hover:text-accent transition-colors">
          {a.eventName}
        </div>
        {a.finalPlacement != null && (
          <div className="mt-2">
            <PlacementBadge place={a.finalPlacement} eucf={a.kind === 'eucf'} />
          </div>
        )}
        {a.games > 0 && (
          <div className="mt-1.5 text-[11px] text-muted font-tight tabular-nums">
            {a.wins}–{a.losses} · {diff > 0 ? '+' : ''}
            {diff}
          </div>
        )}
      </Link>
    </li>
  );
}
