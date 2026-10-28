// USAU Teams view: list ranked by their finish at the most recent
// completed Nationals (or, if they didn't make Nationals, their best
// Regionals placement).
//
// Server Component — pre-renders the entire list using lib/usau/data
// query helpers. Re-renders every minute via the page's revalidate.

import Link from 'next/link';
import {
  clubStandingFinish,
  listRankedTeams,
  officialRankSetFor,
  type ClubStandings,
} from '@/lib/usau/data';
import { listOfficialUsauRankingsCached, listUsauClubStandingsCached } from '@/lib/cached-readers';
import type { UsauLevel } from '@/lib/league';
import { UsauTeamLogo } from '@/components/usau/usau-team-logo';

export async function UsauTeamsRanked({
  genderDivision,
  competitionLevel,
}: {
  genderDivision?: 'Men' | 'Women' | 'Mixed';
  competitionLevel?: UsauLevel;
}) {
  // After Club Nationals, Club ranks by how teams finished (Nationals, then
  // Regionals / Sectionals) until next season's first poll lands.
  if (competitionLevel === 'CLUB' && genderDivision) {
    const standings = await listUsauClubStandingsCached(genderDivision, 500);
    if (standings && standings.teams.length > 0) {
      return <ClubFinalStandings data={standings} genderDivision={genderDivision} />;
    }
  }

  // Prefer USAU's OFFICIAL published rankings when we have them scraped for
  // this division (Club Men/Women/Mixed, College-D1 Men/Women). This is the
  // same source the home-page "Top of the division" reads, so the two match.
  // Falls back to the seed/placement view below for divisions USAU doesn't
  // publish (D-III, Masters) or that we haven't scraped yet.
  const rankSet = officialRankSetFor(competitionLevel, genderDivision);
  if (rankSet) {
    // Show the full official ranking (Club runs 200+; College ~130–195). The
    // scraper stores every team it can match, so surface them all rather than
    // truncating to a top-N.
    const official = await listOfficialUsauRankingsCached(rankSet, 500);
    if (official.teams.length > 0) {
      return <OfficialRankings data={official} genderDivision={genderDivision} competitionLevel={competitionLevel} />;
    }
  }

  const { season, teams } = await listRankedTeams({ genderDivision, competitionLevel });

  if (teams.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center bg-surface rounded-card-lg shadow-card">
        <div className="text-[14px] font-semibold uppercase tracking-[0.18em] text-muted mb-2 font-tight">
          No ranked teams
        </div>
        <div className="text-[13px] text-faint max-w-sm">
          We don&rsquo;t have a Nationals event ingested yet. Run the
          scraper for {season} to populate this list.
        </div>
      </div>
    );
  }

  // Split into "made Nationals" and "everyone else" so we can show a
  // visual divider between the two tiers.
  const madeNats = teams.filter(
    (t) => t.nationalsPlacement != null || t.rankedFromSlug?.includes('Nationals'),
  );
  const others = teams.filter(
    (t) => t.nationalsPlacement == null && !t.rankedFromSlug?.includes('Nationals'),
  );

  return (
    <div className="flex flex-col gap-7">
      {/* Honest framing — we don't have computed final placements yet
          (USAU's schedule pages don't expose them, and we haven't
          derived them from bracket games). What we DO have is each
          team's entry seed at each event. Re-orderable to true finish
          once we add a placement-derivation pass. */}
      <div className="text-[11px] font-medium text-faint font-tight bg-surface rounded-card-sm shadow-soft px-4 py-3">
        <span className="font-bold text-muted uppercase tracking-[0.16em] text-[10px]">
          Note ·
        </span>{' '}
        Currently ordered by entry seed at the {season} {madeNats.length > 0 ? 'Nationals' : 'Regionals'}.
        Real finish-order (champion → last place) lands when we add bracket
        derivation.
      </div>

      {madeNats.length > 0 && (
        <section aria-labelledby="ranked-heading" className="bg-surface rounded-card-lg shadow-card p-5 lg:p-6">
          <h2
            id="ranked-heading"
            className="flex items-baseline justify-between text-[10px] font-bold tracking-[0.18em] uppercase text-muted mb-4 font-tight"
          >
            <span>{season} Nationals · by seed</span>
            <span className="text-faint normal-case tracking-[0.1em]">
              {madeNats.length} teams
            </span>
          </h2>
          <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4">
            {madeNats.map((t, idx) => (
              <RankedRow
                key={t.id}
                rank={t.nationalsPlacement ?? idx + 1}
                name={t.name}
                genderDivision={t.genderDivision}
                state={t.state}
                competitionLevel={t.competitionLevel}
                href={`/usau/teams/${t.id}`}
                isTop
              />
            ))}
          </ol>
        </section>
      )}

      {others.length > 0 && (
        <section aria-labelledby="others-heading" className="bg-surface rounded-card-lg shadow-card p-5 lg:p-6">
          <h2
            id="others-heading"
            className="flex items-baseline justify-between text-[10px] font-bold tracking-[0.18em] uppercase text-muted mb-4 font-tight"
          >
            <span>Other teams · {season} Regionals</span>
            <span className="text-faint normal-case tracking-[0.1em]">
              {others.length}
            </span>
          </h2>
          <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4">
            {others.map((t, idx) => (
              <RankedRow
                key={t.id}
                rank={t.bestRegionalsPlacement ?? idx + 1}
                name={t.name}
                genderDivision={t.genderDivision}
                state={t.state}
                competitionLevel={t.competitionLevel}
                href={`/usau/teams/${t.id}`}
                isTop={false}
              />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function OfficialRankings({
  data,
  genderDivision,
  competitionLevel,
}: {
  data: Awaited<ReturnType<typeof listOfficialUsauRankingsCached>>;
  genderDivision?: 'Men' | 'Women' | 'Mixed';
  competitionLevel?: UsauLevel;
}) {
  return (
    <div className="flex flex-col gap-7">
      <section aria-labelledby="official-ranked-heading" className="bg-surface rounded-card-lg shadow-card p-5 lg:p-6">
        <h2
          id="official-ranked-heading"
          className="flex items-baseline justify-between text-[10px] font-bold tracking-[0.18em] uppercase text-muted mb-4 font-tight"
        >
          <span>Official USAU rankings</span>
          <span className="text-faint normal-case tracking-[0.1em]">{data.teams.length} teams</span>
        </h2>
        <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4">
          {data.teams.map((t) => (
            <RankedRow
              // Rank is unique within a division (unlike id, which is null for
              // teams we couldn't match to a usau_teams row) — safe React key
              // for every row, matched or not.
              key={t.rank}
              rank={t.rank}
              name={t.name}
              genderDivision={genderDivision ?? null}
              state={t.state}
              competitionLevel={competitionLevel ?? null}
              href={t.id ? `/usau/teams/${t.id}` : null}
              isTop
              record={t.wins != null && t.losses != null ? `${t.wins}–${t.losses}` : null}
              rating={t.rating}
            />
          ))}
        </ol>
      </section>
    </div>
  );
}

function ClubFinalStandings({
  data,
  genderDivision,
}: {
  data: ClubStandings;
  genderDivision: 'Men' | 'Women' | 'Mixed';
}) {
  return (
    <div className="flex flex-col gap-7">
      <div className="text-[11px] font-medium text-faint font-tight bg-surface rounded-card-sm shadow-soft px-4 py-3">
        <span className="font-bold text-muted uppercase tracking-[0.16em] text-[10px]">
          How it&rsquo;s ranked ·
        </span>{' '}
        Nationals finish first, then teams out at Regionals and Sectionals by how
        close they came to a bid. USAU&rsquo;s final rating breaks ties.
      </div>

      <section aria-labelledby="final-standings-heading" className="bg-surface rounded-card-lg shadow-card p-5 lg:p-6">
        <h2
          id="final-standings-heading"
          className="flex items-baseline justify-between text-[10px] font-bold tracking-[0.18em] uppercase text-muted mb-4 font-tight"
        >
          <span>{data.season} Final standings</span>
          <span className="text-faint normal-case tracking-[0.1em]">{data.teams.length} teams</span>
        </h2>
        <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4">
          {data.teams.map((t) => (
            <RankedRow
              key={t.rank}
              rank={t.rank}
              name={t.name}
              genderDivision={genderDivision}
              state={t.state}
              competitionLevel="CLUB"
              href={t.id ? `/usau/teams/${t.id}` : null}
              isTop
              finish={clubStandingFinish(t)}
              rating={t.rating}
            />
          ))}
        </ol>
      </section>
    </div>
  );
}

function RankedRow({
  rank,
  name,
  genderDivision,
  state,
  competitionLevel,
  href,
  isTop,
  record = null,
  finish = null,
  rating = null,
}: {
  rank: number | null;
  name: string;
  genderDivision: string | null;
  state: string | null;
  competitionLevel: string | null;
  /** Null when the team couldn't be matched to a usau_teams row — there's no
   *  profile page to link to, so the row renders as static (non-clickable). */
  href: string | null;
  isTop: boolean;
  /** Optional W–L record (official rankings only). */
  record?: string | null;
  /** Optional season finish, e.g. "T-9 · Nationals" (final standings only). */
  finish?: string | null;
  /** Optional USAU power rating (official rankings only). */
  rating?: number | null;
}) {
  // Top 3 get the accent ring; champion + 2nd + 3rd get a medal-style
  // tinted background so the podium reads at a glance.
  const podium = isTop && rank != null && rank <= 3;

  const content = (
    <>
      <span
        aria-hidden="true"
        className={[
          'flex items-center justify-center w-8 h-8 rounded-full flex-shrink-0',
          'tabular text-[13px] font-bold font-tight',
          podium
            ? rank === 1
              ? 'bg-accent text-accent-ink'
              : 'bg-ink text-bg'
            : 'bg-ink/5 text-muted',
        ].join(' ')}
      >
        {rank ?? '—'}
      </span>
      <UsauTeamLogo
        name={name}
        genderDivision={genderDivision}
        competitionLevel={competitionLevel}
        size={28}
      />
      <span className="flex-1 min-w-0">
        <span className="block text-[14px] font-bold text-ink font-tight truncate">
          {name}
        </span>
        <span className="block text-[10px] font-bold tracking-[0.16em] uppercase text-faint font-tight mt-0.5">
          {[finish ?? record, state, competitionLevel?.replace('_', ' ')].filter(Boolean).join(' · ') || '—'}
        </span>
      </span>
      {rating != null && (
        <span className="tabular text-[12px] font-bold text-muted font-tight flex-shrink-0">
          {rating}
        </span>
      )}
    </>
  );

  // Unmatched teams (no usau_teams row) still appear in the list — just as a
  // static row with the same layout, no link/hover affordance since there's
  // nowhere to send the user.
  if (!href) {
    return (
      <li className="border-t border-hairline first:border-t-0">
        <div className="flex items-center gap-3 px-1 py-3">{content}</div>
      </li>
    );
  }

  return (
    <li className="border-t border-hairline first:border-t-0">
      <Link
        href={href}
        className={[
          'flex items-center gap-3 px-1 py-3 hover:opacity-80 transition-opacity no-underline',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-card-sm',
        ].join(' ')}
      >
        {content}
      </Link>
    </li>
  );
}
