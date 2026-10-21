'use server';

// Server actions for UFA player search.
//
// The upstream UFA API has no name-search param — only year, team, and
// sort. To find a player by partial name we have to walk the entire
// season leaderboard (paged, ~30 rows per page) and filter on this side.
//
// We cap at `getAllPlayerStats`'s default (30 pages × 30 = 900 rows),
// which comfortably covers every player who's logged a 2026 minute. The
// upstream caches each page for 1h via the call() helper, so repeated
// searches within the same hour are cheap.

import { createClient } from '@supabase/supabase-js';
import { getAllPlayerStats, currentSeasonYear } from '@/lib/ufa/client';
import type { UfaPlayerStat } from '@/lib/ufa/types';
import {
  search as searchUsau,
  compareByNameThenYearDesc,
  findUsauPlayerByName,
  type SearchResult,
} from '@/lib/usau/data';
import { namesMatch } from '@/lib/name-match';
import { loadNameAliases } from '@/lib/name-aliases';
import { allUfaTeams, teamEras } from '@/lib/ufa/teams';
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabase/env';
import { listPulTeams, searchPulPlayers } from '@/lib/pul/data';
import { listWulTeams, searchWulPlayers } from '@/lib/wul/data';
import { searchWfdfTeams, searchWfdfPlayersForSearch, searchWfdfEvents } from '@/lib/wfdf/data';
import { searchEufTeams, searchEufPlayers, searchEufEvents } from '@/lib/euf/data';

/**
 * DB-side fuzzy UFA player search (pg_trgm) via search_ufa_players_fuzzy.
 * Used by the global search dropdown — replaces walking the whole UFA API
 * leaderboard (~30 paged HTTP calls) then filtering names in Node. Reads the
 * ufa_players table (one row per player, the same set the leaderboard covers),
 * so no data is lost. The full-stats players page still uses searchUfaPlayers
 * (the API walk) because it needs per-season stat rows, not just names.
 */
async function searchUfaPlayersDb(
  query: string,
  limit = 12,
): Promise<{ id: string; fullName: string }[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const db = createClient(supabaseUrl(), supabaseAnonKey(), {
    auth: { persistSession: false },
  });
  const { data, error } = await db.rpc('search_ufa_players_fuzzy', { q, lim: limit });
  if (error) throw error;
  return ((data ?? []) as { id: string; full_name: string }[]).map((r) => ({
    id: r.id,
    fullName: r.full_name,
  }));
}

/**
 * Search the year's full UFA leaderboard for players whose name includes
 * the needle (case-insensitive). Returns at most `limit` results, sorted
 * by scores descending so the highest-impact matches come first.
 *
 * Empty / very short queries return [] — let the client keep showing the
 * default top-200 view in that case.
 */
export async function searchUfaPlayers(
  query: string,
  year: number,
  limit = 200,
): Promise<UfaPlayerStat[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];

  try {
    const all = await getAllPlayerStats({ year, per: 'total' });
    return all
      .filter((p) => p.name.toLowerCase().includes(needle))
      .sort((a, b) => (b.scores ?? 0) - (a.scores ?? 0))
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Unified search across USAU (teams + players) AND UFA players. The client
 * search bar calls THIS (not the USAU-only search()) so UFA-only players —
 * e.g. a UFA "Ben Harris" with no USAU row — are findable. This lives in a
 * 'use server' module because it pulls the server-only UFA client.
 *
 * Dedupe: a UFA player who is the SAME human as a USAU result (cross-league
 * name rule, handling Ben Harris ↔ Benjamin Harris) is dropped — the USAU
 * row already opens the unified /players/[id] profile which merges both careers.
 */
export async function searchAll(query: string, limit = 8): Promise<SearchResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const needle = q.toLowerCase();
  // Per-league contribution cap so a big roster table can't flood / slow the
  // dropdown. We over-fetch a little, then the final sort + slice trims.
  const cap = limit * 2;

  // Fan out every DB-side search (USAU + all leagues' players) + the UFA API
  // player search in ONE parallel batch. Each is name-filtered server-side —
  // no more "pull the whole roster, filter in Node".
  const [usau, ufaPlayers, pulPlayers, wulPlayers, pulTeams, wulTeams, wfdfTeams, wfdfPlayers, wfdfEvents,
         eufTeams, eufPlayers, eufEvents, aliases] =
    await Promise.all([
      searchUsau(q, limit),
      searchUfaPlayersDb(q, cap).catch(() => []),
      searchPulPlayers(q, cap).catch(() => []),
      searchWulPlayers(q, cap).catch(() => []),
      listPulTeams().catch(() => []),
      listWulTeams().catch(() => []),
      searchWfdfTeams(query, cap).catch(() => []),
      searchWfdfPlayersForSearch(query, cap).catch(() => []),
      searchWfdfEvents(query, cap).catch(() => []),
      searchEufTeams(query, cap).catch(() => []),
      searchEufPlayers(query, cap).catch(() => []),
      searchEufEvents(query, cap).catch(() => []),
      loadNameAliases(),
    ]);

  // Names already covered by a USAU player row — used to dedupe same-human
  // matches from the other leagues' player lists (the unified /players/[id]
  // profile merges every league, so one row is enough).
  const usauPlayerNames = usau.filter((r) => r.kind === 'player').map((r) => r.name);

  // ── UFA players (DB fuzzy) ────────────────────────────────────────────
  let ufaResults: SearchResult[] = [];
  {
    const seen = new Set<string>();
    for (const p of ufaPlayers) {
      const key = p.fullName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Same human as a USAU result already shown? Skip (profile merges them).
      if (usauPlayerNames.some((n) => namesMatch(n, p.fullName, aliases))) continue;
      ufaResults.push({ kind: 'player', id: p.id, name: p.fullName, hint: 'UFA', league: 'ufa' });
    }
  }

  // Names covered by an ANCHOR-league row (USAU or UFA) — both route to the
  // unified /players/[id] profile, which already merges every league's stints
  // by name, so a PUL/WUL/WFDF/EUCS row for the same human is redundant. UFA
  // matters for European pros with no USAU record (Miglioretto, Gasperini, …)
  // who would otherwise double-list next to their EUCS entry.
  const coveredNames = [...usauPlayerNames, ...ufaResults.map((r) => r.name)];

  // ── UFA teams (synchronous, in-memory) ────────────────────────────────
  // ALL teams (not just currently-active) so folded/historical franchises are
  // still findable. Match on team name OR city — "Boston" should surface
  // "Boston Glory" — and display the full "City Name" the way UFA brands teams.
  let ufaTeamResults: SearchResult[] = [];
  try {
    ufaTeamResults = allUfaTeams()
      .map((t) => ({ meta: t, mascot: t.name ?? t.abbr, city: t.city ?? '' }))
      .filter(
        (t) =>
          t.mascot.toLowerCase().includes(needle) ||
          t.city.toLowerCase().includes(needle) ||
          `${t.city} ${t.mascot}`.toLowerCase().includes(needle),
      )
      .slice(0, cap)
      .map((t) => ({
        kind: 'team' as const,
        id: t.meta.id,
        name: [t.city, t.mascot].filter(Boolean).join(' '),
        hint: 'UFA',
        league: 'ufa' as const,
        logoUrl: t.meta.logo ?? null,
        prominence: 3, // pro league — top-tier
      }));

    // Former identities as their own rows — "Roughnecks" finds Dallas even
    // though TEAM_META only carries the current brand (Legion). These link to
    // the same franchise page; the year label is what distinguishes them.
    ufaTeamResults = ufaTeamResults.concat(
      teamEras()
        .filter(
          (e) =>
            e.name.toLowerCase().includes(needle) ||
            e.city.toLowerCase().includes(needle) ||
            `${e.city} ${e.name}`.toLowerCase().includes(needle),
        )
        .slice(0, cap)
        .map((e) => ({
          kind: 'team' as const,
          id: e.id,
          name: [e.city, e.name].filter(Boolean).join(' '),
          hint: `UFA · ${e.yearLabel}`,
          league: 'ufa' as const,
          logoUrl: e.logo ?? null,
          prominence: 3,
        })),
    );
  } catch {
    ufaTeamResults = [];
  }

  // PUL teams — tiny in-memory list (14 rows); match on name OR city so
  // "Philadelphia" surfaces the Surge.
  const pulTeamResults: SearchResult[] = pulTeams
    .filter(
      (t) =>
        t.name.toLowerCase().includes(needle) ||
        (t.city ?? '').toLowerCase().includes(needle),
    )
    .slice(0, cap)
    .map((t) => ({
      kind: 'team',
      id: t.id,
      name: t.name,
      hint: ['PUL', t.city].filter(Boolean).join(' · '),
      league: 'pul',
      logoUrl: t.logoUrl ?? null,
      prominence: 3, // pro league — top-tier
    }));

  // PUL players — already name-filtered + deduped by the RPC (one row per
  // name, most-recent season). Just drop same-humans covered by a USAU row.
  const pulPlayerResults: SearchResult[] = [];
  for (const p of pulPlayers) {
    if (pulPlayerResults.length >= cap) break;
    if (coveredNames.some((n) => namesMatch(n, p.playerName, aliases))) continue;
    pulPlayerResults.push({
      kind: 'player',
      id: p.id,
      name: p.playerName,
      hint: ['PUL', p.teamName].filter(Boolean).join(' · '),
      league: 'pul',
    });
  }

  // WUL teams — tiny in-memory list (9 rows); match on name OR city.
  const wulTeamResults: SearchResult[] = wulTeams
    .filter(
      (t) =>
        t.name.toLowerCase().includes(needle) ||
        (t.city ?? '').toLowerCase().includes(needle),
    )
    .slice(0, cap)
    .map((t) => ({
      kind: 'team',
      id: t.id,
      name: t.name,
      hint: ['WUL', t.city].filter(Boolean).join(' · '),
      league: 'wul',
      logoUrl: t.logoUrl ?? null,
      prominence: 3, // pro league — top-tier
    }));

  // WUL players — already name-filtered + deduped by the RPC.
  const wulPlayerResults: SearchResult[] = [];
  for (const p of wulPlayers) {
    if (wulPlayerResults.length >= cap) break;
    if (coveredNames.some((n) => namesMatch(n, p.playerName, aliases))) continue;
    wulPlayerResults.push({
      kind: 'player',
      id: p.id,
      name: p.playerName,
      hint: ['WUL', p.teamName].filter(Boolean).join(' · '),
      league: 'wul',
    });
  }

  // WFDF teams — DB fuzzy-matched already; tag with the event for context.
  const wfdfTeamResults: SearchResult[] = wfdfTeams.map((t) => ({
    kind: 'team',
    id: t.id,
    name: t.name,
    hint: ['WFDF', t.eventName].filter(Boolean).join(' · '),
    league: 'wfdf',
    prominence: 2, // international event teams — neutral (not a standing club/pro team)
  }));

  // WFDF players — route via the by-name resolver (no anchor id). `id` carries
  // the full name. Dedupe against anchor-league rows (coveredNames) so a player
  // already shown from USAU/UFA — whose unified profile merges their WFDF
  // stints — isn't listed twice.
  const wfdfPlayerResults: SearchResult[] = [];
  {
    const seen = new Set<string>();
    for (const p of wfdfPlayers) {
      if (wfdfPlayerResults.length >= cap) break;
      const key = p.fullName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (coveredNames.some((n) => namesMatch(n, p.fullName, aliases))) continue;
      wfdfPlayerResults.push({
        kind: 'player',
        id: p.fullName, // by-name resolver route uses the name, not a UUID
        name: p.fullName,
        hint: ['WFDF', p.teamName].filter(Boolean).join(' · '),
        league: 'wfdf',
      });
    }
  }

  // WFDF events — tournaments (route to /wfdf/events/[slug] via resultHref).
  const wfdfEventResults: SearchResult[] = wfdfEvents.map((e) => ({
    kind: 'tournament',
    id: e.slug,
    name: e.name,
    hint: ['WFDF', String(e.year)].filter(Boolean).join(' · '),
    league: 'wfdf',
    season: e.year,
  }));

  // EUF teams — the RPC returns one row PER EVENT, so a club that has entered
  // seven events would otherwise fill the dropdown with seven identical names.
  // Dedupe to one result per CLUB-DIVISION (Grut's Open and Women's squads are
  // separate clubs), with `id` carrying "name|division" for resultHref. Label by
  // country + division rather than whichever event happened to sort first.
  const eufTeamResults: SearchResult[] = [];
  {
    const seen = new Set<string>();
    for (const t of eufTeams) {
      const key = `${t.name.trim().toLowerCase()}|${t.division.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      eufTeamResults.push({
        kind: 'team',
        id: `${t.name}|${t.division}`,
        name: t.name,
        hint: ['EUCS', t.division, t.countryName].filter(Boolean).join(' · '),
        league: 'euf',
        prominence: 2,
      });
    }
  }

  // EUF players — by-name route (ids are per-event). Same anchor-league dedupe
  // as WFDF so a player already surfaced from USAU/UFA isn't listed twice.
  const eufPlayerResults: SearchResult[] = [];
  {
    const seen = new Set<string>();
    for (const p of eufPlayers) {
      if (eufPlayerResults.length >= cap) break;
      const key = p.fullName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (coveredNames.some((n) => namesMatch(n, p.fullName, aliases))) continue;
      eufPlayerResults.push({
        kind: 'player',
        id: p.fullName,
        name: p.fullName,
        hint: ['EUCS', p.teamName].filter(Boolean).join(' · '),
        league: 'euf',
      });
    }
  }

  const eufEventResults: SearchResult[] = eufEvents.map((e) => ({
    kind: 'tournament',
    id: e.slug,
    name: e.name,
    hint: ['EUCS', String(e.year)].filter(Boolean).join(' · '),
    league: 'euf',
    season: e.year,
  }));

  const merged = [
    ...usau,
    ...ufaResults,
    ...ufaTeamResults,
    ...pulTeamResults,
    ...pulPlayerResults,
    ...wulTeamResults,
    ...wulPlayerResults,
    ...wfdfTeamResults,
    ...wfdfPlayerResults,
    ...wfdfEventResults,
    ...eufTeamResults,
    ...eufPlayerResults,
    ...eufEventResults,
  ];

  // Rank by: (1) match quality via `matchTier` — exact (0) > name-starts-with /
  // FIRST NAME (1) > whole-word elsewhere (2) > contains (3); then (2)
  // prominence DESC — adult club + pro-league teams above college, above
  // youth/HS, so "Colorado" floats real clubs over U-20/Academy noise; then (3)
  // alphabetical. Missing prominence defaults to 2 (neutral), which is where
  // bare players/tournaments land.
  //
  // FIRST-NAME PRIORITY: tier 1 (name starts with the query) sits ABOVE the
  // whole-word tier, so "hunter" ranks "Hunter May" (first name) over "John
  // Hunter" (surname) — the surname is still a whole-word hit (tier 2), just
  // below. The whole-word tier is what makes "bravo" surface "Johnny Bravo".
  const prom = (r: SearchResult): number => r.prominence ?? 2;
  // Stamp each result with its match tier so the client can also ORDER THE
  // GROUPS by best match (a strong player hit can outrank weak team hits,
  // instead of Teams always rendering first).
  // USAU tournaments arrive pre-ranked by the event RPC (year filter +
  // "nationals" synonym), which a name check can't reproduce.
  for (const r of merged) r.matchRank ??= matchTier(r.name, needle);

  merged.sort((a, b) => {
    const ra = a.matchRank ?? 3;
    const rb = b.matchRank ?? 3;
    if (ra !== rb) return ra - rb;
    const pa = prom(a);
    const pb = prom(b);
    if (pa !== pb) return pb - pa; // higher prominence first
    // Tournaments newest season first (Hunter, 2026-10-20).
    if (a.season != null && b.season != null && a.season !== b.season) return b.season - a.season;
    // Same event across years (e.g. Heavyweights 2024/2026) → newest first.
    return compareByNameThenYearDesc(a.name, b.name);
  });

  // ── Final cross-league PLAYER dedup ──────────────────────────────────────
  // The per-league dedup above only skips players already covered by a USAU
  // row. A human who is in two NON-USAU leagues (e.g. UFA + WFDF) — or whose
  // USAU player row got sliced off USAU search's own capped result set — still
  // yields two identical rows. Since every league's player row opens the same
  // unified /players/[id] profile (which merges careers by name), one row is
  // enough. Collapse player rows sharing an EXACT display name (lowercased +
  // trimmed — the conservative rule; we deliberately do NOT fuzzy-merge here so
  // two genuinely-distinct same-surname people aren't hidden from search).
  //
  // Runs AFTER the sort, so the FIRST surviving row per name is the best-ranked
  // one; insertion order + stable sort also make an anchor-league row (UFA/PUL/
  // WUL, real /players/[id]) win a tie over a WFDF by-name row. Only `kind ===
  // 'player'` participates — a team/tournament sharing a person's name is left
  // untouched.
  const seenPlayerName = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const r of merged) {
    if (r.kind === 'player') {
      const nameKey = r.name.trim().toLowerCase();
      if (seenPlayerName.has(nameKey)) continue;
      seenPlayerName.add(nameKey);
    }
    deduped.push(r);
  }

  return deduped.slice(0, limit * 2);
}

/**
 * Match-quality tier for ranking a result name against the query.
 *   0 = exact (name === query)
 *   1 = name STARTS WITH the query — for "First Last" names this is the FIRST
 *       NAME ("hunter" -> "Hunter May", "hunt" -> "Hunt for Drunk October").
 *       Deliberately above the whole-word tier so first-name hits beat surname
 *       hits.
 *   2 = whole-word match elsewhere (query is a standalone word but not the
 *       start — "hunter" in "John Hunter", "bravo" in "Johnny Bravo")
 *   3 = contains / fuzzy-only (substring anywhere, or a trigram match the RPC
 *       surfaced that isn't even a substring)
 * `needle` must already be lowercased + trimmed.
 *
 * NOT exported: this file is a `'use server'` module, where Next.js requires
 * every EXPORT to be an async server action. A plain sync helper must stay
 * module-private (it's only used by searchAll above).
 */
/**
 * Thread-popover name → unified-profile id (client-callable). USAU ids have
 * the widest coverage and the unified profile merges the other leagues from
 * there — same resolution the Connections card uses. Null = no match; the
 * caller leaves the name as plain text rather than a dead link.
 */
export async function resolveThreadPlayerByName(name: string): Promise<string | null> {
  return findUsauPlayerByName(name);
}

function matchTier(name: string, needle: string): number {
  const n = name.toLowerCase();
  if (n === needle) return 0;
  if (n.startsWith(needle)) return 1; // first name / name prefix — top priority
  // Whole-word elsewhere: query bounded by non-alphanumerics (or string edges).
  // Escape regex metacharacters in the needle so a name with punctuation is safe.
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`, 'i').test(n)) return 2;
  return 3;
}
