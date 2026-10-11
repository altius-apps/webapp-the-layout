'use client';

// WFDF event detail — division tabs → standings + games for one Worlds event.
//
// WFDF divisions are per-event and named freely (Master Mixed, Open, Women's…),
// so unlike USAU we tab locally rather than via a global ?div param. Each tab
// shows: final standings (from wfdf_teams) + the division's games grouped into
// pool play and bracket. Team names link to /wfdf/teams/[id].

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useViewParam } from '@/lib/use-view-param';
import type { WfdfEventDetail as WfdfEvent } from '@/lib/wfdf/data';
import { wfdfGameTime } from '@/lib/wfdf/format-date';
import { DivisionPager, scrollToSectionTop } from '@/components/division-pager';
import { WfdfFlag } from './wfdf-flag';
import { WfdfBracketTree, hasWfdfBracket, wfdfBracketCoveredIds } from './wfdf-bracket-tree';

interface Props {
  event: WfdfEvent;
}

type WfdfTabKey = 'pools' | 'bracket' | 'standings';

const TAB_LABELS: Record<WfdfTabKey, string> = {
  pools: 'Pools',
  bracket: 'Bracket',
  standings: 'Standings',
};

// ── Real pools vs. bracket phases ─────────────────────────────────────────
//
// wfdf_games.pool_name is NOT a pool field — it's whatever phase label the
// source published. Of the ~97 distinct values in the table, many are bracket
// rounds ("Playoff (1-8)", "Pre-quarter", "Crossover", "Gold", "Bronze").
// `is_bracket` doesn't fully separate them either (AOBUC24 tags "Pre-quarter"
// rows as pool play), so grouping on pool_name alone fills Pool Play with
// playoff rounds. Only labels that actually read as a pool ("Pool A", "Pool
// B") are treated as pools; everything else stays out of the pool grouping.
function isRealPoolName(name: string | null): boolean {
  if (!name) return false;
  const t = name.trim().toLowerCase();
  // Bracket phases first — "Crossover(s)" and playoff/quarter rounds are
  // single-elimination, not round-robin groups, even when the source files
  // them under pool_name.
  if (t.includes('playoff') || t.includes('crossover') || t.includes('quarter')) return false;
  // "Pool A", but also WFDF's second-phase groups: "Power Pool E" (seeded
  // regroup after first-phase pools) and "Placement Pool K" (lower-bracket
  // round robin). Both are real round-robin pools with their own slates, so
  // anchoring on a leading "pool" token would misfile ~250 games into Other.
  return /(^|\s)pool\b/.test(t);
}

// Stored values already carry the word "Pool" ("Pool A", "Power Pool E"), so
// the header renders the name as-is rather than prefixing "POOL " and
// producing "POOL POOL A".
function poolDisplayLabel(pool: string): string {
  return pool.trim().toUpperCase();
}

// ── Pool membership, derived from games ───────────────────────────────────
//
// Unlike USAU (usau_event_teams.pool), wfdf_teams carries NO pool column —
// the schema has seed/final_standing/W-L but nothing tying a team to a pool.
// So a pool's teams are the teams that played in that pool's games. Callers
// pass division-filtered games/teams: WFDF pool names are only unique WITHIN
// a division (AOBUC24's "Pool A" spans several divisions' pools), so grouping
// across divisions would merge unrelated pools into one oversized card.
//
// Teams are ordered by RECORD in that pool's games as results come through —
// wins desc, then point diff desc (Hunter, 2026-08-18), then seed/name for
// the pre-play state where nobody has a result yet.
// Each returned team carries its IN-POOL record (poolWins/poolLosses) — the
// pool card must display that, not wfdf_teams' event-wide W-L, which counts
// bracket games too (Hunter, 2026-08-20).
type WfdfPoolTeam = WfdfEvent['teams'][number] & { poolWins: number; poolLosses: number };

function buildWfdfPoolTeams(
  games: WfdfEvent['games'],
  teams: WfdfEvent['teams'],
): Map<string, WfdfPoolTeam[]> {
  const byId = new Map(teams.map((t) => [t.id, t]));
  const byPool = new Map<string, Map<string, WfdfEvent['teams'][number]>>();
  const gamesByPool = new Map<string, WfdfEvent['games']>();

  for (const g of games) {
    if (!isRealPoolName(g.poolName)) continue;
    const pool = g.poolName as string;
    const bucket = byPool.get(pool) ?? new Map<string, WfdfEvent['teams'][number]>();
    for (const id of [g.homeTeamId, g.awayTeamId]) {
      if (id == null) continue;
      const team = byId.get(id);
      // Only teams in the active division resolve — a game whose opponent sits
      // outside this division (shouldn't happen, but the data is scraped) just
      // contributes the side we know.
      if (team) bucket.set(team.id, team);
    }
    byPool.set(pool, bucket);
    const pg = gamesByPool.get(pool) ?? [];
    pg.push(g);
    gamesByPool.set(pool, pg);
  }

  const out = new Map<string, WfdfPoolTeam[]>();
  for (const [pool, bucket] of byPool) {
    // In-pool record and point diff from this pool's scored games only —
    // event-wide W-L would drag bracket results into pool order.
    const stats = new Map<string, { w: number; l: number; diff: number }>();
    const stat = (id: string) => {
      let s = stats.get(id);
      if (!s) {
        s = { w: 0, l: 0, diff: 0 };
        stats.set(id, s);
      }
      return s;
    };
    for (const g of gamesByPool.get(pool) ?? []) {
      if (g.homeTeamId == null || g.awayTeamId == null) continue;
      if (g.homeScore == null || g.awayScore == null) continue;
      stat(g.homeTeamId).diff += g.homeScore - g.awayScore;
      stat(g.awayTeamId).diff += g.awayScore - g.homeScore;
      if (g.homeScore > g.awayScore) {
        stat(g.homeTeamId).w += 1;
        stat(g.awayTeamId).l += 1;
      } else if (g.awayScore > g.homeScore) {
        stat(g.awayTeamId).w += 1;
        stat(g.homeTeamId).l += 1;
      }
    }
    const EMPTY = { w: 0, l: 0, diff: 0 };
    out.set(
      pool,
      [...bucket.values()]
        .map((t) => {
          const s = stats.get(t.id) ?? EMPTY;
          return { ...t, poolWins: s.w, poolLosses: s.l };
        })
        .sort((a, b) => {
          const sa = stats.get(a.id) ?? EMPTY;
          const sb = stats.get(b.id) ?? EMPTY;
          if (sb.w !== sa.w) return sb.w - sa.w;
          if (sa.l !== sb.l) return sa.l - sb.l;
          if (sb.diff !== sa.diff) return sb.diff - sa.diff;
          const sd = (a.seed ?? 9999) - (b.seed ?? 9999);
          return sd !== 0 ? sd : a.name.localeCompare(b.name);
        }),
    );
  }
  return out;
}

export function WfdfEventDetail({ event }: Props) {
  const divisions = event.divisions;
  // Division lives in the URL (?div=) so back-nav from a team page and hard
  // refresh both keep the filter (Hunter ruling 2026-08-16; default omitted
  // for clean URLs, unknown values fall back to the first division).
  const [divParam, setDivParam] = useViewParam('div');
  const defaultDiv = divisions[0]?.name ?? '';
  const activeDiv =
    divParam != null && divisions.some((d) => d.name === divParam) ? divParam : defaultDiv;
  const setActiveDiv = (next: string) => setDivParam(next === defaultDiv ? null : next);

  // Tab in the URL too (?tab=), same survival rules as the division. The
  // param itself is global/shared — but which tab is EFFECTIVE (falls back
  // to the division's own first-filled section when the param names a tab
  // this division can't fill) must be resolved per-division, since with live
  // preview the neighbor division renders mid-swipe independently of
  // whatever the active division's tab is.
  const [tabParam, setTabParam] = useViewParam('tab');
  const activeTab = (tabParam as WfdfTabKey | null) ?? 'pools';
  const setActiveTab = (next: WfdfTabKey) => setTabParam(next);

  // Per-division derivation — must be callable for ANY division in the list,
  // not just activeDiv, because DivisionPager's renderDivision also mounts
  // the neighbor division live while a swipe is in flight.
  const deriveDivision = (div: string) => {
    const teams = event.teams.filter((t) => t.divisionName === div);
    const games = event.games.filter((g) => g.divisionName === div);

    // Standings order:
    //  1. final_standing when the source provides it (modern events do; legacy
    //     Ultiorganizer events — e.g. WUC 2024 — leave it null for every team).
    //  2. Otherwise fall back to RECORD: win% desc → more wins → fewer losses.
    //     Without this, null-standing teams sorted alphabetically, which put a
    //     9-0 USA at the BOTTOM. Record is the meaningful ranking when there's no
    //     official final placement.
    //  3. SEED asc, then SOTG desc — pre-tournament every record ties 0-0, and a
    //     name tie-break rendered WUCC standings A→Z. Seed is the pre-play order
    //     (all WUCC teams are seeded); spirit is the live tie-break for legacy
    //     events with no seeds. (Mobile parity 2026-08-16.)
    //  4. Name as the final tie-break.
    // Whether the source gave us official final placements (modern events) or we
    // must rank by record (legacy pool-only events).
    const hasOfficialStanding = teams.some((t) => t.finalStanding != null);

    const winPct = (t: (typeof teams)[number]) => {
      const w = t.wins ?? 0;
      const l = t.losses ?? 0;
      return w + l > 0 ? w / (w + l) : -1; // teams with no games sink below 0-x
    };
    const standings = [...teams].sort((a, b) => {
      if (hasOfficialStanding) {
        const d = (a.finalStanding ?? 999) - (b.finalStanding ?? 999);
        if (d !== 0) return d;
      }
      const pd = winPct(b) - winPct(a);
      if (pd !== 0) return pd;
      const wd = (b.wins ?? 0) - (a.wins ?? 0);
      if (wd !== 0) return wd;
      const ld = (a.losses ?? 0) - (b.losses ?? 0);
      if (ld !== 0) return ld;
      const sd = (a.seed ?? 9999) - (b.seed ?? 9999);
      if (sd !== 0) return sd;
      const gd = (b.spiritAvg ?? -1) - (a.spiritAvg ?? -1);
      if (gd !== 0) return gd;
      return a.name.localeCompare(b.name);
    });

    const poolGames = games.filter((g) => !g.isBracket);
    const bracketGames = games.filter((g) => g.isBracket);
    const hasBracketTree = hasWfdfBracket(div, event.games, event.teams);

    // Bracket games the trees DON'T place (Pre-quarter, Crossover, Round of 32,
    // the placement round-robins) still render as a flat section below the trees
    // — a played game must never be invisible. 307 games across 13 events fall
    // through classifyRound, so without this they vanish wherever a tree renders.
    let uncoveredBracketGames: WfdfEvent['games'] = [];
    if (hasBracketTree) {
      const covered = wfdfBracketCoveredIds(div, event.games, event.teams);
      // Unplaced games with neither team decided are pure structure (e.g. a
      // standalone placement pool's TBD slots) — hidden until a team lands.
      uncoveredBracketGames = bracketGames.filter(
        (g) => !covered.has(g.id) && (g.homeTeamId != null || g.awayTeamId != null),
      );
    }

    // Which section tabs this division can actually fill. Standings is gated on
    // having teams at all (it ranks by record when no official final_standing
    // exists); pools/bracket on having those games. Order is the reading order:
    // pools → bracket → standings.
    const visibleTabs: WfdfTabKey[] = [];
    if (poolGames.length > 0) visibleTabs.push('pools');
    if (bracketGames.length > 0) visibleTabs.push('bracket');
    if (standings.length > 0) visibleTabs.push('standings');

    // Resolve synchronously rather than via an effect — switching divisions can
    // invalidate the current tab (a division with no bracket), and waiting a
    // render to correct it paints one frame of an empty section. Per-division
    // so the neighbor being live-previewed mid-swipe falls back to ITS OWN
    // first-filled section instead of inheriting the active division's tab.
    const effectiveTab: WfdfTabKey = visibleTabs.includes(activeTab)
      ? activeTab
      : (visibleTabs[0] ?? 'pools');

    return {
      teams,
      games,
      standings,
      hasOfficialStanding,
      poolGames,
      bracketGames,
      hasBracketTree,
      uncoveredBracketGames,
      visibleTabs,
      effectiveTab,
    };
  };

  const active = deriveDivision(activeDiv);
  const { visibleTabs, effectiveTab } = active;

  const divisionOptions = useMemo(
    () => divisions.map((d) => ({ value: d.name, label: d.name })),
    [divisions],
  );

  if (divisions.length === 0) {
    return <p className="text-muted font-tight text-[13px]">No divisions found for this event.</p>;
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Section tabs (underline style, left) share a row with the division
          control (right) — Hunter's tournament-header layout, 2026-08-20.
          Each tab appears only when this division can fill it, so a pool-only
          legacy event never shows an empty Bracket tab. Tap a division pill
          or swipe the content on touch to change division. */}
      <DivisionPager
        divisions={divisionOptions}
        active={activeDiv}
        onChange={setActiveDiv}
        tabRowLeading={
          visibleTabs.length > 1 ? (
            <div role="tablist" aria-label="Event views" className="flex items-center justify-between gap-5 lg:justify-start">
              {visibleTabs.map((t) => {
                const on = t === effectiveTab;
                return (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={(e) => {
                      setActiveTab(t);
                      scrollToSectionTop(e.currentTarget);
                    }}
                    className={[
                      'flex-1 lg:flex-none flex justify-center lg:justify-start whitespace-nowrap',
                      'text-[12px] font-bold tracking-[0.1em] uppercase font-tight cursor-pointer',
                      'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      on ? 'text-ink' : 'text-muted hover:text-ink',
                    ].join(' ')}
                  >
                    <span className={['pb-1 border-b-2 transition-colors', on ? 'border-accent' : 'border-transparent'].join(' ')}>
                      {TAB_LABELS[t]}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : undefined
        }
        renderDivision={(div) => (
          <DivisionContent div={div} event={event} derive={deriveDivision} />
        )}
        contentClassName="flex flex-col gap-8"
      />
    </div>
  );
}

function DivisionContent({
  div,
  event,
  derive,
}: {
  div: string;
  event: WfdfEvent;
  derive: (div: string) => {
    teams: WfdfEvent['teams'];
    games: WfdfEvent['games'];
    standings: WfdfEvent['teams'];
    hasOfficialStanding: boolean;
    poolGames: WfdfEvent['games'];
    bracketGames: WfdfEvent['games'];
    hasBracketTree: boolean;
    uncoveredBracketGames: WfdfEvent['games'];
    visibleTabs: WfdfTabKey[];
    effectiveTab: WfdfTabKey;
  };
}) {
  const {
    teams,
    games,
    standings,
    hasOfficialStanding,
    poolGames,
    bracketGames,
    hasBracketTree,
    uncoveredBracketGames,
    effectiveTab,
  } = derive(div);

  return (
    <>
      {/* Bracket — the trees when the shape parses, else the flat list. Games
          the trees don't place (Pre-quarter, Crossover, Round of 32, placement
          round-robins) still list below, so no played game is ever invisible. */}
      {effectiveTab === 'bracket' && bracketGames.length > 0 && (
        hasBracketTree ? (
          <>
            <WfdfBracketTree divisionName={div} games={event.games} teams={event.teams} />
            {uncoveredBracketGames.length > 0 && (
              <GameSection heading="More bracket games" games={uncoveredBracketGames} groupByPool />
            )}
          </>
        ) : (
          <GameSection heading="Bracket Games" games={bracketGames} />
        )
      )}

      {/* Pool play — teams per pool, that pool's games collapsed underneath. */}
      {effectiveTab === 'pools' && <PoolPlaySection games={poolGames} teams={teams} />}

      {effectiveTab === 'standings' && standings.length > 0 && (
      <section>
        <h2
          className={[
            'flex items-center gap-2',
            'text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight',
            'pb-2 border-b border-hairline',
          ].join(' ')}
        >
          {hasOfficialStanding ? 'Final Standings' : 'Standings · By Record'}
          <span className="text-faint tabular ml-1">{standings.length}</span>
        </h2>

        <div className="mt-3 bg-surface rounded-card-lg shadow-card overflow-hidden">
          <div className="hidden sm:grid grid-cols-[2.5rem_1fr_5rem_4rem] items-center px-4 py-2.5 border-b border-hairline text-[10px] font-bold tracking-[0.16em] uppercase text-faint font-tight">
            <span>#</span>
            <span>Team</span>
            <span className="text-right">W–L</span>
            <span className="text-right">SOTG</span>
          </div>
          <ol>
            {standings.map((t, i) => (
              <li key={t.id}>
                <Link
                  href={`/wfdf/teams/${t.id}`}
                  prefetch={false}
                  className={[
                    'grid grid-cols-[2.5rem_1fr_auto] sm:grid-cols-[2.5rem_1fr_5rem_4rem] items-center px-4 py-3',
                    'no-underline transition-colors duration-150 hover:bg-surface-hi',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                    i > 0 ? 'border-t border-hairline' : '',
                  ].join(' ')}
                >
                  {/* Rank: the official final standing when present; otherwise
                      the positional rank by record (i + 1) — never a bare "—"
                      that would make every legacy-event row look unranked. */}
                  {(() => {
                    const rank = t.finalStanding ?? i + 1;
                    return (
                      <span
                        className={[
                          'font-tight text-[13px] font-bold tabular',
                          rank <= 3 ? 'text-accent' : 'text-faint',
                        ].join(' ')}
                      >
                        {rank}
                      </span>
                    );
                  })()}
                  <span className="min-w-0 flex items-center gap-2">
                    <WfdfFlag flagFile={t.flagFile} countryCode={t.countryCode} size={16} />
                    <span className="font-tight text-[14px] font-semibold text-ink truncate">
                      {t.name}
                    </span>
                  </span>
                  <span className="font-tight text-[13px] tabular text-right text-muted">
                    {t.wins ?? '—'}–{t.losses ?? '—'}
                  </span>
                  <span className="hidden sm:block font-tight text-[13px] tabular text-right text-faint">
                    {t.spiritAvg != null ? t.spiritAvg.toFixed(1) : '—'}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      </section>
      )}

      {standings.length === 0 && games.length === 0 && (
        <p className="text-muted font-tight text-[13px]">No results in this division yet.</p>
      )}
    </>
  );
}

// ─── Pool play ────────────────────────────────────────────────────────────────
//
// Mirrors the USAU Pools tab: each pool renders its team list as a card, with
// that pool's games collapsed underneath. Teams come from the games (WFDF has
// no team→pool column — see buildWfdfPoolTeams), so there's no seed column
// guarantee and no W-L table; it's a membership list, not standings.

function PoolPlaySection({
  games,
  teams,
}: {
  games: WfdfEvent['games'];
  teams: WfdfEvent['teams'];
}) {
  const poolTeams = useMemo(() => buildWfdfPoolTeams(games, teams), [games, teams]);

  const gamesByPool = useMemo(() => {
    const byPool = new Map<string, WfdfEvent['games']>();
    for (const g of games) {
      if (!isRealPoolName(g.poolName)) continue;
      const k = g.poolName as string;
      if (!byPool.has(k)) byPool.set(k, []);
      byPool.get(k)!.push(g);
    }
    for (const arr of byPool.values()) {
      arr.sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''));
    }
    return byPool;
  }, [games]);

  // Phase labels that aren't real pools (Playoff, Crossover, Pre-quarter…)
  // still need somewhere to live, or a played game would vanish from the
  // page — they render flat below the pools.
  const otherGames = useMemo(() => games.filter((g) => !isRealPoolName(g.poolName)), [games]);

  const pools = useMemo(
    () => [...gamesByPool.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    [gamesByPool],
  );

  if (pools.length === 0 && otherGames.length === 0) return null;

  return (
    <>
      {pools.length > 0 && (
        <section>
          <h2 className="flex items-center gap-2 text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight pb-2 border-b border-hairline">
            Pool Play
            <span className="text-faint tabular ml-1">{pools.length}</span>
          </h2>

          <div className="mt-4 flex flex-col gap-6">
            {pools.map((pool) => (
              <WfdfPoolCard
                key={pool}
                label={poolDisplayLabel(pool)}
                teams={poolTeams.get(pool) ?? []}
                games={gamesByPool.get(pool) ?? []}
              />
            ))}
          </div>
        </section>
      )}

      {otherGames.length > 0 && (
        <GameSection heading="Other Games" games={otherGames} groupByPool />
      )}
    </>
  );
}

// One pool's card: standings-style team list with that pool's games in a
// collapsed footer INSIDE the card — same look/behavior as USAU's PoolCard
// (Hunter, 2026-08-20; replaced the old detached <details> pill below the card).
function WfdfPoolCard({
  label,
  teams,
  games,
}: {
  label: string;
  teams: WfdfPoolTeam[];
  games: WfdfEvent['games'];
}) {
  const [gamesOpen, setGamesOpen] = useState(false);
  const panelId = `pool-games-${label.replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <div className="bg-surface rounded-card-lg shadow-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-[10.5px] font-bold tracking-[0.18em] uppercase text-accent font-tight">
          {label}
        </span>
        <span className="text-[10px] tabular text-faint font-tight">{teams.length} teams</span>
      </div>
      <ul>
        {teams.map((t, i) => (
          <li key={t.id}>
            <Link
              href={`/wfdf/teams/${t.id}`}
              prefetch={false}
              className={[
                'flex items-center gap-2.5 px-4 py-2.5 no-underline',
                'transition-colors duration-150 hover:bg-surface-hi',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                i > 0 ? 'border-t border-hairline' : '',
              ].join(' ')}
            >
              <span className="w-5 text-right text-[11px] font-bold tabular text-faint font-tight">
                {t.seed ?? '–'}
              </span>
              <WfdfFlag flagFile={t.flagFile} countryCode={t.countryCode} size={16} />
              <span className="flex-1 min-w-0 font-tight text-[14px] font-semibold text-ink truncate">
                {t.name}
              </span>
              {/* In-pool record only — event-wide t.wins/t.losses include
                  bracket games (those live on Standings). */}
              <span className="text-[11px] tabular text-faint font-tight">
                {t.poolWins}–{t.poolLosses}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {games.length > 0 && (
        <div className="border-t border-hairline">
          <button
            type="button"
            aria-expanded={gamesOpen}
            aria-controls={panelId}
            onClick={() => setGamesOpen((o) => !o)}
            className={[
              'w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left cursor-pointer',
              'hover:bg-ink/[0.03] transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
            ].join(' ')}
          >
            <span className="flex items-center gap-2 min-w-0">
              <PoolGamesChevron open={gamesOpen} />
              <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-ink font-tight">
                Games
              </span>
            </span>
            <span className="tabular text-[10px] font-bold text-faint font-tight">
              {games.length}
            </span>
          </button>
          {gamesOpen && (
            <div id={panelId} className="flex flex-col gap-2 px-3 pb-3">
              {games.map((g) => (
                <GameRow key={g.id} game={g} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PoolGamesChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={['shrink-0 text-faint transition-transform duration-150', open ? 'rotate-90' : ''].join(' ')}
    >
      <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Games ────────────────────────────────────────────────────────────────────

type Game = WfdfEvent['games'][number];

function GameSection({
  heading,
  games,
  groupByPool = false,
}: {
  heading: string;
  games: Game[];
  groupByPool?: boolean;
}) {
  const groups = useMemo(() => {
    if (!groupByPool) return [{ label: null as string | null, games }];
    const byPool = new Map<string, Game[]>();
    for (const g of games) {
      const k = g.poolName ?? 'Other';
      if (!byPool.has(k)) byPool.set(k, []);
      byPool.get(k)!.push(g);
    }
    return [...byPool.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, gs]) => ({ label, games: gs }));
  }, [games, groupByPool]);

  return (
    <section>
      <h2 className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight mb-3 pb-2 border-b border-hairline">
        {heading}
      </h2>
      <div className="flex flex-col gap-5">
        {groups.map((grp, gi) => (
          <div key={grp.label ?? gi}>
            {grp.label && (
              <div className="text-[10px] font-bold tracking-[0.16em] uppercase text-faint font-tight mb-2">
                {grp.label}
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {grp.games.map((g) => (
                <GameRow key={g.id} game={g} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function GameRow({ game: g }: { game: Game }) {
  const router = useRouter();
  const done = g.status === 'completed' && g.homeScore != null && g.awayScore != null;
  const homeWon = done && (g.homeScore ?? 0) > (g.awayScore ?? 0);
  const awayWon = done && (g.awayScore ?? 0) > (g.homeScore ?? 0);
  // WFDF records a single spirit-of-the-game score per game (in away_sotg);
  // there is no separate home value in the source, so we show it once.
  const sotg = g.awaySotg ?? g.homeSotg;
  const timeLabel = wfdfGameTime(g.scheduledAt);
  // Field number from the reservation join. Bare numbers ("12") get a "Field"
  // prefix (USAU-card convention); full venue strings render as-is.
  const fieldLabel = g.fieldName
    ? /^\d+[A-Za-z]?$/.test(g.fieldName.trim())
      ? `Field ${g.fieldName.trim()}`
      : g.fieldName.trim()
    : null;
  const hasFooter =
    timeLabel != null || fieldLabel != null || sotg != null || (!done && g.status === 'scheduled');
  return (
    <div
      className="bg-surface rounded-card shadow-card px-3 py-2.5 cursor-pointer hover:shadow-card-hover transition-shadow"
      role="link"
      tabIndex={0}
      onClick={() => router.push(`/wfdf/g/${g.id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') router.push(`/wfdf/g/${g.id}`);
      }}
    >
      <TeamLine
        name={g.homeTeam}
        teamId={g.homeTeamId}
        country={g.homeCountry}
        score={g.homeScore}
        won={homeWon}
        done={done}
      />
      <div className="h-px bg-hairline my-1" />
      <TeamLine
        name={g.awayTeam}
        teamId={g.awayTeamId}
        country={g.awayCountry}
        score={g.awayScore}
        won={awayWon}
        done={done}
      />
      {hasFooter && (
        <div className="flex items-center justify-between gap-2 mt-1.5 pt-1.5 border-t border-hairline text-[10px] font-tight text-faint">
          <span className="truncate">
            {[fieldLabel, timeLabel ?? (g.status === 'scheduled' ? 'Scheduled' : null)]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {sotg != null && (
            <span className="tabular flex-shrink-0" title="Spirit of the Game">
              SOTG {sotg}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function TeamLine({
  name,
  teamId,
  country,
  score,
  won,
  done,
}: {
  name: string | null;
  teamId: string | null;
  country: string | null;
  score: number | null;
  won: boolean;
  done: boolean;
}) {
  const label = (
    <span className="flex items-center gap-2 min-w-0">
      <WfdfFlag flagFile={null} countryCode={country} size={14} />
      <span
        className={[
          'font-tight text-[13px] font-bold truncate',
          done ? (won ? 'text-ink' : 'text-muted') : 'text-ink',
        ].join(' ')}
      >
        {name ?? 'TBD'}
      </span>
    </span>
  );
  return (
    <div className="flex items-center justify-between gap-2">
      {teamId ? (
        <Link
          href={`/wfdf/teams/${teamId}`}
          prefetch={false}
          className="min-w-0 no-underline hover:text-accent"
          onClick={(e) => e.stopPropagation()}
        >
          {label}
        </Link>
      ) : (
        label
      )}
      <span
        className={[
          'font-tight text-[14px] tabular flex-shrink-0',
          done ? (won ? 'font-bold text-ink' : 'text-muted') : 'text-faint',
        ].join(' ')}
      >
        {score ?? '–'}
      </span>
    </div>
  );
}
