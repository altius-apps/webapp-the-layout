// wfdf-ingest — ingest WFDF "Worlds" events from the results static cache.
//
// Three modes:
//   { "base": "https://…" }        one event, explicit (operator-driven)
//   { "dispatch": "live" }         refresh events in/near their date window (cron)
//   { "dispatch": "discover" }     crawl the results index for NEW events (cron)
//
// Discovery + live-refresh are BOTH cron-driven (see Cron Schedule.md). That is
// deliberate and does NOT contradict the no-cron-for-backfill rule: these poll a
// cheap static JSON cache for CURRENT events, they don't bulk-walk history.
//
// Request body: { "base": "https://wmucc.wfdf.sport" }
//   base = any modern WFDF event root — a subdomain (https://wmucc.wfdf.sport)
//   OR a path event (https://results.wfdf.sport/wjuc-2026). The heartbeat at
//   {base}/live/data/_heartbeat.json self-describes season + static path.
//
// Data model (see memory project_wfdf_results_source):
//   {origin}{STATIC_CACHE_BASE_URL}{season}_{entity}.json
//   reference.json → season/series/pools/teams/countries (the master join)
//   games.json     → scores + spirit
//   teams_{id}.json→ per-team named roster + record + spirit rollups
//
// Only MODERN events (2025+) use this static cache. Legacy (≤2024) events run
// Ultiorganizer HTML and need a different scraper — this function 400s on them.
//
// Auto-injected by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { ingestLegacy, type LegacyIngestConfig } from './legacy.ts';

const UA = 'Mozilla/5.0 (the-layout/wfdf-ingest)';
const FETCH_DELAY_MS = 120; // polite pacing between the per-team roster fetches
const ROSTER_CONCURRENCY = 6;

// FAR TIER (Hunter, 2026-10-06: "pull event info AS SOON as the league source
// has it"). The live window starts at start_date-21d, so a known event whose
// pools/schedule/rosters go up earlier sat frozen at its first snapshot. Events
// starting in (today+LOOKAHEAD, today+FAR_LOOKAHEAD_DAYS] — plus modern events
// with no start_date yet — get a separate capped check on the 15-min live cron:
// the FAR_PER_RUN least-recently-scraped whose last scrape is older than
// FAR_MIN_INTERVAL_MIN. One ingest is ~3 + one request per team (up to ~100 at
// a Worlds); nothing sits in this band today, so the cap bounds peak load, not
// current load. Interval < 60 so cron drift can't push a check to 75 min.
// Constants, not body overrides — this endpoint is reachable by anyone with a key.
const FAR_LOOKAHEAD_DAYS = 120;
const FAR_PER_RUN = 2;
const FAR_MIN_INTERVAL_MIN = 50;
const LIVE_CRON_INTERVAL_MIN = 15;

function db(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key, { auth: { persistSession: false } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      const ct = res.headers.get('content-type') || '';
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      // The SPA returns an HTML 200 fallback for missing files — reject those.
      if (!ct.includes('json')) throw new Error(`not JSON (${ct}) for ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt === 1) throw err;
      await sleep(600);
    }
  }
}

// ── Discovery helpers ───────────────────────────────────────────────────────

/**
 * Full event base URL for a stored wfdf_events row.
 *
 * source_origin holds the ORIGIN only; a path event's segment lives inside
 * static_base ("/wucc-2026/live/data/" → "/wucc-2026"). Subdomain events have
 * static_base "/live/data/", which yields no segment and returns the origin.
 * Both the live-refresh and the discovery dedup depend on this being exact.
 */
function eventBase(e: { source_origin?: string | null; static_base?: string | null }): string {
  const origin = String(e.source_origin ?? '').replace(/\/+$/, '');
  const sb = String(e.static_base ?? '');
  const m = sb.match(/^\/([^/]+)\/live\/data\/?$/);
  return m ? `${origin}/${m[1]}` : origin;
}

/**
 * The event base after following any canonical redirect, derived from where the
 * heartbeat actually resolved (`res.url` reflects the final URL after redirects).
 * Returns null when the base is already canonical or the probe fails.
 *
 * Same host allow-list as candidateEventUrls: a redirect is attacker-influenced
 * input in the same way a link is, so it must not be able to point the ingest
 * at an arbitrary host.
 */
async function resolveCanonicalBase(base: string): Promise<string | null> {
  try {
    const probe = `${base}/live/data/_heartbeat.json`;
    const res = await fetch(probe, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) return null;
    const finalUrl = new URL(res.url);
    if (!/(^|\.)wfdf\.sport$/i.test(finalUrl.hostname) && !/(^|\.)sport$/i.test(finalUrl.hostname)) {
      return null;
    }
    // Strip the probe suffix to get back to the event base.
    const resolved = res.url.replace(/\/live\/data\/_heartbeat\.json.*$/, '');
    return resolved.replace(/\/$/, '') || null;
  } catch {
    return null;
  }
}

/**
 * Event base URLs linked from the results index page.
 *
 * Accepts two shapes, both present on results.wfdf.sport:
 *   - relative path events:  href="wucc-2026/"       → {origin}/wucc-2026
 *   - subdomain events:      href="https://wmucc.wfdf.sport/"
 *
 * Everything else is rejected: anchors, mailto/javascript, the bare origin, and
 * any off-site host (the index also links Google Sheets). Restricting to
 * *.wfdf.sport / *.sport keeps a compromised or edited index from pointing our
 * fetcher at an arbitrary host — this value is used to build fetch URLs, so it
 * must not be attacker-steerable into SSRF against an internal address.
 */
function candidateEventUrls(html: string, indexUrl: string): string[] {
  const origin = new URL(indexUrl).origin;
  const out = new Set<string>();

  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith('#') || /^(mailto|javascript|tel):/i.test(raw)) continue;

    let u: URL;
    try {
      u = new URL(raw, indexUrl);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    // Only the WFDF results estate — never an arbitrary third-party host.
    if (!/(^|\.)wfdf\.sport$/i.test(u.hostname) && !/(^|\.)sport$/i.test(u.hostname)) continue;
    // Drop query/hash; an event base is a bare path.
    u.search = '';
    u.hash = '';

    const path = u.pathname.replace(/\/+$/, '');
    // Same-origin links must be a SINGLE path segment ("/wucc-2026"). The bare
    // origin (path === '') is the index itself; deeper paths are sub-views.
    if (u.origin === origin) {
      if (!path || path.split('/').length !== 2) continue;
      out.add(`${u.origin}${path}`);
    } else {
      // Subdomain event — its base is the origin itself.
      if (path) continue;
      out.add(u.origin);
    }
  }
  return [...out];
}

// ── Classify the event kind from its season id / name / national flag ────────
function classifyKind(seasonId: string, isNational: boolean): string {
  const s = seasonId.toLowerCase();
  if (s.includes('wbuc') || s.includes('beach')) return 'beach';
  if (s.includes('wjuc') || s.includes('juc')) return 'junior';
  if (s.includes('u24')) return 'u24';
  if (s.includes('wmucc') || s.includes('mucc')) return 'masters';
  if (s.includes('wcc') || s.includes('cc')) return 'club';
  return isNational ? 'national' : 'other';
}

// Build "First Last" for name-matching. Falls back to whichever half exists.
function fullName(first?: string, last?: string): string {
  return [first, last].filter((x) => x && String(x).trim()).join(' ').trim();
}

// WFDF Worlds (WUC/WUGC) run the GUTS discipline alongside ultimate. It is a
// different sport and must never enter our ultimate data. Its series are named
// "Guts Open" / "Guts Women's". Match on a word boundary so a real division
// can't false-positive.
const GUTS_RE = /\bguts\b/i;
function isGuts(name: unknown): boolean {
  return typeof name === 'string' && GUTS_RE.test(name);
}

interface IngestResult {
  season: string;
  event: string;
  divisions: number;
  teams: number;
  rosterPlayers: number;
  games: number;
  gamesDetailed: number;
  goalLogRows: number;
}

async function ingest(base: string, seasonOverride?: string): Promise<IngestResult> {
  const supabase = db();
  let cleanBase = base.replace(/\/$/, '');

  // Follow a canonical redirect BEFORE deriving anything from the URL.
  // results.wfdf.sport/pauc 301s to results.pauc.sport — fetch follows that
  // transparently, so the heartbeat loads, but every subsequent data URL was
  // still built from the ORIGINAL base and 404'd
  // (results.wfdf.sport/live/data/pauc2025_reference.json). Resolve to the
  // final host first. This also stops the same event being stored twice under
  // two different hosts.
  const canonical = await resolveCanonicalBase(cleanBase);
  if (canonical && canonical !== cleanBase) {
    console.log(`[wfdf-ingest] ${cleanBase} → ${canonical} (redirect)`);
    cleanBase = canonical;
  }
  const origin = new URL(cleanBase).origin;

  // 1. Heartbeat self-describes season + static path. Join STATIC_CACHE_BASE_URL
  //    to the ORIGIN (it's absolute-from-root; path events already include the
  //    path segment, so joining to cleanBase would double it up).
  //
  // Most events carry a full `config` block. A few older-but-still-static
  // events (e.g. AOUC 2025, app_version 1.8.x) ship a MINIMAL heartbeat with no
  // config — for those we derive the season id from the caller override, else
  // from the schedule page's `season=` param, and assume the default /live/data
  // static path.
  const hb = await getJson(`${cleanBase}/live/data/_heartbeat.json`).catch(() => ({}));
  const cfg = hb.config ?? {};
  let seasonId: string = String(cfg.LIVE_SEASON_ID || seasonOverride || '').replace(
    /[^a-zA-Z0-9]/g,
    '',
  );
  if (!seasonId) {
    // Scrape the schedule page for its season= param.
    try {
      const html = await (await fetch(`${cleanBase}/?view=games`, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
      })).text();
      const m = html.match(/[?&](?:sel)?season=([A-Za-z0-9_-]+)/);
      if (m) seasonId = m[1].replace(/[^a-zA-Z0-9]/g, '');
    } catch {
      // fall through to the error below
    }
  }
  if (!seasonId) throw new Error('no LIVE_SEASON_ID (heartbeat + schedule both empty)');
  // Static-cache base. Prefer the config value; otherwise derive it from the
  // event path — a subdomain event (https://x.wfdf.sport) uses /live/data/, a
  // path event (https://results.wfdf.sport/aouc) uses /aouc/live/data/.
  const pathPrefix = new URL(cleanBase).pathname.replace(/\/$/, ''); // '' or '/aouc'
  const staticBase = `${origin}${cfg.STATIC_CACHE_BASE_URL || `${pathPrefix}/live/data/`}`;
  const dataUrl = (entity: string) => `${staticBase}${seasonId}_${entity}.json?cb=${Date.now()}`;

  // 2. Reference = master join.
  const ref = await getJson(dataUrl('reference'));
  const season = ref.season ?? {};
  const seriesById = new Map<number, any>((ref.series ?? []).map((s: any) => [s.series_id, s]));
  const teamsById = new Map<number, any>((ref.teams ?? []).map((t: any) => [t.team_id, t]));
  const countriesById = new Map<number, any>((ref.countries ?? []).map((c: any) => [c.country_id, c]));
  const poolsById = new Map<number, any>((ref.pools ?? []).map((p: any) => [p.pool_id, p]));
  // Field reservations: id → { fieldname ("1", "2", …), location, name }.
  // fieldname carries the field number at WUCC; other events may only populate
  // name/location, so those are the fallbacks.
  const reservationsById = new Map<number, any>(
    (ref.reservations ?? []).map((r: any) => [r.id, r]),
  );

  const year = Number(String(season.starttime || '').slice(0, 4)) || new Date().getUTCFullYear();
  const isNational = Number(season.isnationalteams) === 1;
  const kind = classifyKind(seasonId, isNational);

  // 3. Upsert the event row.
  const { data: eventRow, error: evErr } = await supabase
    .from('wfdf_events')
    .upsert(
      {
        season_id: seasonId,
        slug: seasonId,
        name: season.name || seasonId,
        year,
        kind,
        location: cfg.TOURNAMENT_LOCATION || null,
        start_date: (season.starttime || '').slice(0, 10) || null,
        end_date: (season.endtime || '').slice(0, 10) || null,
        is_national_teams: isNational,
        logo_url: cfg.HOME_LOGO_PATH ? `${origin}${cfg.HOME_LOGO_PATH}` : null,
        source_origin: origin,
        // Store the DERIVED static path, not the raw config value. Minimal
        // heartbeats (app_version 1.8.x, e.g. AOUC 2025) carry no config, so
        // cfg.STATIC_CACHE_BASE_URL is null — persisting that lost which PATH
        // event the row was ("https://results.wfdf.sport" + null tells you
        // nothing about /aouc). The derived form always identifies the event,
        // which both the live-refresh and discovery-dedup paths depend on.
        static_base: staticBase.startsWith(origin) ? staticBase.slice(origin.length) : staticBase,
        last_scraped_at: new Date().toISOString(),
        last_scraped_status: 'ok',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'season_id' },
    )
    .select('id')
    .single();
  if (evErr) throw evErr;
  const eventId = eventRow.id as string;

  // Guts sets — exclude these series/teams from every table below (Guts is not
  // ultimate; see isGuts). Team is Guts if its own name is Guts OR it belongs to
  // a Guts series (defensive: some feeds only name the series).
  const gutsSeriesIds = new Set<number>(
    (ref.series ?? []).filter((s: any) => isGuts(s.name)).map((s: any) => s.series_id),
  );
  const gutsTeamIds = new Set<number>(
    (ref.teams ?? [])
      .filter((t: any) => isGuts(t.name) || gutsSeriesIds.has(t.series))
      .map((t: any) => t.team_id),
  );

  // 4. Divisions (series). Upsert, then map series_id → our uuid. Guts series
  //    are dropped entirely.
  const divRows = (ref.series ?? [])
    .filter((s: any) => !gutsSeriesIds.has(s.series_id))
    .map((s: any) => ({
      event_id: eventId,
      wfdf_series_id: s.series_id,
      name: s.name,
      ordering: s.ordering ?? null,
    }));
  if (divRows.length) {
    const { error } = await supabase
      .from('wfdf_divisions')
      .upsert(divRows, { onConflict: 'event_id,wfdf_series_id' });
    if (error) throw error;
  }
  const { data: divs } = await supabase
    .from('wfdf_divisions')
    .select('id, wfdf_series_id')
    .eq('event_id', eventId);
  const divUuidBySeries = new Map<number, string>((divs ?? []).map((d: any) => [d.wfdf_series_id, d.id]));

  // 5. Teams (from reference.teams). Basic row now; record/spirit rollups get
  //    filled from the per-team detail below. Guts teams excluded.
  const teamRows = (ref.teams ?? []).filter((t: any) => !gutsTeamIds.has(t.team_id)).map((t: any) => {
    const country = countriesById.get(t.country);
    return {
      event_id: eventId,
      wfdf_team_id: t.team_id,
      division_id: divUuidBySeries.get(t.series) ?? null,
      name: t.name,
      abbreviation: t.abbreviation ?? null,
      club_name: t.clubname ?? t.club ?? null,
      country_code: country?.abbreviation ?? null,
      country_name: country?.name ?? null,
      flag_file: country?.flagfile ?? null,
      seed: t.rank ?? t.seed ?? null,
      final_standing: t.final_standing_calculated || null,
      updated_at: new Date().toISOString(),
    };
  });
  if (teamRows.length) {
    const { error } = await supabase
      .from('wfdf_teams')
      .upsert(teamRows, { onConflict: 'event_id,wfdf_team_id' });
    if (error) throw error;
  }
  const { data: teamRowsDb } = await supabase
    .from('wfdf_teams')
    .select('id, wfdf_team_id')
    .eq('event_id', eventId);
  const teamUuidByWfdf = new Map<number, string>((teamRowsDb ?? []).map((t: any) => [t.wfdf_team_id, t.id]));

  // 6. Per-team rosters + record rollups (teams_{id}.json). Bounded concurrency.
  let rosterPlayers = 0;
  const teamIds = [...teamsById.keys()].filter((id) => !gutsTeamIds.has(id));
  for (let i = 0; i < teamIds.length; i += ROSTER_CONCURRENCY) {
    const batch = teamIds.slice(i, i + ROSTER_CONCURRENCY);
    await Promise.all(
      batch.map(async (wfdfTeamId) => {
        const teamUuid = teamUuidByWfdf.get(wfdfTeamId);
        if (!teamUuid) return;
        let detail: any;
        try {
          detail = await getJson(dataUrl(`teams_${wfdfTeamId}`));
        } catch {
          return; // a missing per-team file shouldn't abort the whole ingest
        }
        // Record + spirit rollup back onto the team row.
        const pts = detail.points ?? {};
        const st = detail.stats ?? {};
        await supabase
          .from('wfdf_teams')
          .update({
            games: st.games ?? null,
            wins: st.wins ?? null,
            losses: st.games != null && st.wins != null ? st.games - st.wins : null,
            scores_for: pts.scores ?? null,
            scores_against: pts.against ?? null,
            spirit_avg: pts.spiritavg ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', teamUuid);

        // Named roster.
        const players = (detail.players ?? []).filter((p: any) => p && p.player_id != null);
        if (players.length) {
          const rows = players.map((p: any) => ({
            team_id: teamUuid,
            event_id: eventId,
            wfdf_player_id: p.player_id,
            first_name: p.firstname ?? null,
            last_name: p.lastname ?? null,
            full_name: fullName(p.firstname, p.lastname) || `Player ${p.player_id}`,
            jersey_number: p.num != null ? String(p.num) : null,
            goals: p.done ?? null,
            assists: p.fedin ?? null,
            callahans: p.callahan ?? null,
            total: p.total ?? null,
            games: p.games ?? null,
          }));
          // DIFF BEFORE WRITE (2026-08-12). This function runs every 15 min
          // (96x/day) and used to blind-upsert every roster row every time:
          // ~24.5k rows x 96 = ~2.35M no-op writes/day, each one burning WAL,
          // dead tuples and the Micro instance's 11 MB/s disk budget for zero
          // new data. One cheap read per team replaces all of it.
          const { data: priorRows } = await supabase
            .from('wfdf_rosters')
            .select('wfdf_player_id, first_name, last_name, full_name, jersey_number, goals, assists, callahans, total, games')
            .eq('team_id', teamUuid);
          const prior = new Map(
            (priorRows ?? []).map((r: any) => [String(r.wfdf_player_id), r]),
          );
          const changed = rows.filter((r: any) => {
            const p: any = prior.get(String(r.wfdf_player_id));
            if (!p) return true; // new player on this roster
            return (
              p.first_name !== r.first_name ||
              p.last_name !== r.last_name ||
              p.full_name !== r.full_name ||
              p.jersey_number !== r.jersey_number ||
              p.goals !== r.goals ||
              p.assists !== r.assists ||
              p.callahans !== r.callahans ||
              p.total !== r.total ||
              p.games !== r.games
            );
          });
          if (changed.length === 0) {
            rosterPlayers += rows.length;
          } else {
            const { error } = await supabase
              .from('wfdf_rosters')
              .upsert(changed, { onConflict: 'team_id,wfdf_player_id' });
            if (!error) rosterPlayers += rows.length;
          }
        }
        await sleep(FETCH_DELAY_MS);
      }),
    );
  }

  // 7. Games (scores + spirit). Division inferred from the home team's series.
  //    Drop any game involving a Guts team (a Guts-vs-Guts matchup, or defensively
  //    a Guts team appearing on either side).
  const games = ((await getJson(dataUrl('games'))).games ?? []).filter(
    (g: any) => !gutsTeamIds.has(g.hometeam) && !gutsTeamIds.has(g.visitorteam),
  );
  const gameRows = games.map((g: any) => {
    const home = teamsById.get(g.hometeam);
    const pool = poolsById.get(g.pool);
    const isBracket = pool ? Number(pool.type) !== 1 || Number(pool.placementpool) === 1 : false;
    const statusMap: Record<string, string> = {
      completed: 'completed',
      inprogress: 'in_progress',
      scheduled: 'scheduled',
    };
    // VENUE-LOCAL WALL CLOCK, stored as UTC — same convention as EUCS/USAU
    // masters (see src/lib/euf/format-date.ts). Prefer `time`, NOT `time_utc`:
    // `time` is what the schedule site prints (13:00 = the 1:00 PM slot), while
    // `time_utc` is that instant shifted to real UTC (12:00 at a UTC+1 venue).
    // Since readers render this back in UTC unshifted, taking `time_utc` showed
    // every WUCC game an hour early. `time_utc` is also absent on ~46% of rows.
    const t = g.time || g.time_utc || null;
    return {
      event_id: eventId,
      wfdf_game_id: g.game_id,
      // Division from the home team's series when seeded; a TBD future bracket
      // slot has no home team, so fall back to the game's POOL's series —
      // without this every unseeded bracket game had division_id null and was
      // invisible to the division-filtered event screens.
      division_id: home
        ? divUuidBySeries.get(home.series) ?? null
        : pool
          ? divUuidBySeries.get(pool.series_id) ?? null
          : null,
      home_team_id: teamUuidByWfdf.get(g.hometeam) ?? null,
      away_team_id: teamUuidByWfdf.get(g.visitorteam) ?? null,
      // Placeholder slot metadata — display text ("R1 Winner 3", "1A") plus the
      // NAME of the pool the slot is fed from (unique within a division), which
      // the bracket-structure resolver keys on. Null once/if the source drops
      // them; harmless on seeded games.
      home_scheduling_name: g.homeschedulingname != null ? String(g.homeschedulingname) : null,
      away_scheduling_name: g.visitorschedulingname != null ? String(g.visitorschedulingname) : null,
      home_scheduling_pool: poolsById.get(g.home_scheduling_frompool)?.poolname ?? null,
      away_scheduling_pool: poolsById.get(g.visitor_scheduling_frompool)?.poolname ?? null,
      home_score: g.homescore ?? null,
      away_score: g.visitorscore ?? null,
      home_sotg: g.homesotg ?? null,
      away_sotg: g.visitorsotg ?? null,
      pool_name: pool?.poolname ?? null,
      field_name: (() => {
        const r = reservationsById.get(g.reservation);
        if (!r) return null;
        const v = r.fieldname ?? r.name ?? r.location;
        const s = v != null ? String(v).trim() : '';
        return s || null;
      })(),
      is_bracket: isBracket,
      status: statusMap[String(g.status)] ?? 'scheduled',
      scheduled_at: t ? new Date(t.replace(' ', 'T') + 'Z').toISOString() : null,
      updated_at: new Date().toISOString(),
    };
  });
  if (gameRows.length) {
    // Chunk to stay well under any payload limits.
    for (let i = 0; i < gameRows.length; i += 500) {
      const { error } = await supabase
        .from('wfdf_games')
        .upsert(gameRows.slice(i, i + 500), { onConflict: 'event_id,wfdf_game_id' });
      if (error) throw error;
    }
  }

  // 8. Per-game detail: point-by-point goal log + per-player game stats
  //    (games_{id}.json) — powers the matchup screen's Game Progress chart.
  //    Fetched only for games that have started; a completed game whose goal
  //    log is already complete (goals_count = home+away) is skipped, so
  //    steady-state live refreshes only touch in-progress and newly-finished
  //    games. Never-live-scored games keep goals_count 0 and re-check each
  //    run — bounded, since live refresh only runs during the event window.
  let gamesDetailed = 0;
  let goalLogRows = 0;
  // Page the read: PostgREST silently caps un-ranged selects at 1000 rows.
  const dbGames: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('wfdf_games')
      .select('id, wfdf_game_id, home_team_id, away_team_id, home_score, away_score, status, goals_count, detail_synced_at')
      .eq('event_id', eventId)
      // A stable order, or pages can skip/repeat rows.
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    dbGames.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const detailCandidates = dbGames.filter((g: any) => {
    if (g.status === 'scheduled') return false;
    if (g.status !== 'completed') return true; // in-progress: always refresh
    const logComplete =
      g.goals_count != null &&
      g.home_score != null &&
      g.away_score != null &&
      g.goals_count >= g.home_score + g.away_score;
    // Checked after completion and found no goal log at all → the game was
    // never live-scored; don't re-fetch it every cron cycle for the rest of
    // the event (a large non-WUCC event can have hundreds of these).
    const confirmedUnscored = g.detail_synced_at != null && g.goals_count === 0;
    return !logComplete && !confirmedUnscored;
  });
  for (let i = 0; i < detailCandidates.length; i += ROSTER_CONCURRENCY) {
    const batch = detailCandidates.slice(i, i + ROSTER_CONCURRENCY);
    await Promise.all(
      batch.map(async (g: any) => {
        let detail: any;
        try {
          detail = await getJson(dataUrl(`games_${g.wfdf_game_id}`));
        } catch {
          // No per-game file. For a COMPLETED game, record the miss so the
          // candidate filter stops re-fetching it every run; an in-progress
          // game's file may simply not exist yet, so leave it unmarked.
          if (g.status === 'completed') {
            await supabase
              .from('wfdf_games')
              .update({ goals_count: 0, detail_synced_at: new Date().toISOString() })
              .eq('id', g.id);
          }
          return;
        }
        const goals = (detail.goals ?? []).filter((x: any) => x && x.homescore != null);
        // Replace wholesale: a refetch can shrink the log (score corrections),
        // so delete-and-insert beats upsert-and-strand.
        const { error: delGoals } = await supabase
          .from('wfdf_game_goals')
          .delete()
          .eq('game_id', g.id);
        if (delGoals) throw delGoals;
        if (goals.length) {
          // Chunked like the gameRows write; also a cap against a corrupted
          // source file ballooning a single insert.
          const goalRows = goals.slice(0, 2000).map((x: any, idx: number) => ({
              game_id: g.id,
              event_id: eventId,
              num: x.num ?? idx,
              time_s: x.time ?? null,
              // Goal timestamps ARE real UTC in the source (unlike game `time`,
              // which is venue-local — see the scheduled_at note above).
              scored_at: x.timestamp
                ? new Date(x.timestamp.replace(' ', 'T') + 'Z').toISOString()
                : null,
              is_home_goal: !!x.ishomegoal,
              is_callahan: !!x.iscallahan,
              home_score: x.homescore,
              away_score: x.visitorscore,
              scorer_wfdf_player_id: x.scorer ?? null,
              assist_wfdf_player_id: x.assist ?? null,
            }));
          for (let j = 0; j < goalRows.length; j += 500) {
            const { error } = await supabase
              .from('wfdf_game_goals')
              .insert(goalRows.slice(j, j + 500));
            if (error) throw error;
          }
        }
        const statRows = [
          ...(detail.hometeam_scoreboard ?? []).map((p: any) => ({ p, teamId: g.home_team_id })),
          ...(detail.visitorteam_scoreboard ?? []).map((p: any) => ({ p, teamId: g.away_team_id })),
        ].filter(({ p }: { p: any }) => p && p.player_id != null);
        const { error: delStats } = await supabase
          .from('wfdf_game_player_stats')
          .delete()
          .eq('game_id', g.id);
        if (delStats) throw delStats;
        if (statRows.length) {
          const statInsertRows = statRows
            .slice(0, 500)
            .map(({ p, teamId }: { p: any; teamId: string | null }) => ({
              game_id: g.id,
              event_id: eventId,
              team_id: teamId ?? null,
              wfdf_player_id: p.player_id,
              jersey_number: p.num != null ? String(p.num) : null,
              goals: p.done ?? 0,
              assists: p.fedin ?? 0,
              callahans: p.callahan ?? 0,
              total: p.total ?? 0,
            }));
          const { error } = await supabase
            .from('wfdf_game_player_stats')
            .insert(statInsertRows);
          if (error) throw error;
        }
        const { error: mark } = await supabase
          .from('wfdf_games')
          .update({ goals_count: goals.length, detail_synced_at: new Date().toISOString() })
          .eq('id', g.id);
        if (mark) throw mark;
        gamesDetailed++;
        goalLogRows += goals.length;
        await sleep(FETCH_DELAY_MS);
      }),
    );
  }

  return {
    season: seasonId,
    event: season.name || seasonId,
    divisions: divRows.length,
    teams: teamRows.length,
    rosterPlayers,
    games: gameRows.length,
    gamesDetailed,
    goalLogRows,
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // empty body ok — we'll error on missing base below
  }

  // ── Discovery mode (cron) ────────────────────────────────────────────────
  // { "dispatch": "discover" } → find WFDF events we don't have yet.
  //
  // results.wfdf.sport's ROOT PAGE is a real index: it links every event, both
  // path-style ("wucc-2026/") and subdomain ("https://wmucc.wfdf.sport/"). That
  // is authoritative and self-maintaining, so we crawl it rather than probing a
  // hardcoded slug list — a new Worlds shows up the week WFDF publishes it.
  //
  // Each candidate is confirmed by fetching its heartbeat: a real modern event
  // returns JSON, a bad path returns the SPA's HTML 404 (getJson rejects
  // non-JSON, so that check is already exact). Anything already in wfdf_events
  // is skipped — the live-dispatch job owns refreshing those.
  //
  // Legacy (Ultiorganizer) events have no heartbeat and are deliberately NOT
  // auto-ingested: they need a per-event season/name config (see
  // resolveLegacyConfig) and they're all historical, so there's nothing new to
  // find. They're reported under `skippedLegacy` for visibility.
  if (body?.dispatch === 'discover') {
    const supabase = db();
    const indexUrl = typeof body?.index === 'string' ? body.index : 'https://results.wfdf.sport/';
    // Cap the crawl so a source change can't turn this into an unbounded fan-out.
    const MAX_CANDIDATES = 40;

    let html = '';
    try {
      const res = await fetch(indexUrl, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (err) {
      return new Response(
        JSON.stringify({
          ok: false,
          mode: 'dispatch-discover',
          error: `index fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const candidates = candidateEventUrls(html, indexUrl).slice(0, MAX_CANDIDATES);

    // Dedup on SEASON_ID, not on the URL.
    //
    // URL-matching is not reliable here, and all three ways it fails are real:
    //   - AOUC2025 is stored with static_base = null, so there's no path prefix
    //     to reconstruct "…/aouc" from.
    //   - pauc2025 is stored under a DIFFERENT HOST (results.pauc.sport) than
    //     the index link (results.wfdf.sport/pauc) — same event, two URLs.
    //   - subdomain vs path aliases point at the same season.
    // The heartbeat's LIVE_SEASON_ID is the event's real identity (it's the
    // upsert's onConflict key), so read that first and compare on it. One extra
    // cheap JSON fetch per candidate buys exact dedup.
    const { data: known } = await supabase
      .from('wfdf_events')
      .select('season_id, source_origin, static_base');
    const knownSeasons = new Set(
      (known ?? []).map((e: any) => String(e.season_id ?? '').toLowerCase()),
    );
    // Fallback identity for MINIMAL heartbeats (app_version 1.8.x, e.g. AOUC
    // 2025) that ship no `config` block and therefore no LIVE_SEASON_ID — we
    // can't learn the season without a full ingest, so match on the base URL.
    const knownUrlKeys = new Set(
      (known ?? []).map((e: any) => eventBase(e).toLowerCase()).filter(Boolean),
    );

    const discovered: any[] = [];
    let skippedKnown = 0;
    let skippedLegacy = 0;
    const failed: any[] = [];

    for (const base of candidates) {
      // Confirm it's a modern event AND learn its season id before ingesting.
      const hb = await getJson(`${base}/live/data/_heartbeat.json`).catch(() => null);
      if (!hb) {
        // No heartbeat → legacy Ultiorganizer event; those need a per-event
        // config and are all historical, so discovery leaves them alone.
        skippedLegacy++;
        continue;
      }
      const seasonId = String(hb?.config?.LIVE_SEASON_ID ?? '').trim();
      if (seasonId) {
        if (knownSeasons.has(seasonId.toLowerCase())) {
          skippedKnown++;
          continue;
        }
      } else {
        // Minimal heartbeat — no season id to compare. Fall back to the URL,
        // resolved through any canonical redirect so an aliased host still
        // matches what we stored.
        const canon = ((await resolveCanonicalBase(base)) ?? base)
          .replace(/\/+$/, '')
          .toLowerCase();
        if (knownUrlKeys.has(canon)) {
          skippedKnown++;
          continue;
        }
      }
      try {
        const r = await ingest(base);
        discovered.push({ base, ...r });
        // Guard against two index links resolving to the same season in one run.
        if (r.season) knownSeasons.add(String(r.season).toLowerCase());
        console.log(`[wfdf-ingest] discovered ${r.event} (${r.teams} teams, ${r.games} games)`);
      } catch (err) {
        failed.push({ base, error: err instanceof Error ? err.message : String(err) });
        console.error(`[wfdf-ingest] discovery ingest failed for ${base}:`, err);
      }
      await sleep(FETCH_DELAY_MS);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        mode: 'dispatch-discover',
        candidates: candidates.length,
        discovered,
        skippedKnown,
        skippedLegacy,
        failed,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ── Live-dispatch mode (cron) ────────────────────────────────────────────
  // { "dispatch": "live" } → re-ingest every MODERN WFDF event in or NEAR its
  // date window. Modern events are the ones the static-cache path can refresh
  // cheaply (last_scraped_status = 'ok', not the 'ok-legacy' Ultiorganizer
  // ones). Used by the every-15-min cron so a live tournament (e.g. WMUCC /
  // WJUC) stays fresh; idle when nothing is on.
  //
  // PRE-EVENT LOOKAHEAD (LOOKAHEAD_DAYS): the window used to be strictly
  // start_date ≤ today ≤ end_date, which meant pools, schedule and rosters —
  // published WEEKS before a Worlds — were never refreshed until the day play
  // began. WUCC 2026 was the case that exposed it. Mirrors USAU's +7-day
  // lookahead (sync-live-events), but wider: WFDF publishes earlier.
  //
  // TRAILING_DAYS keeps polling briefly after the end date so late score
  // corrections and final placements land.
  if (body?.dispatch === 'live') {
    const supabase = db();
    const LOOKAHEAD_DAYS = Number(body?.lookaheadDays ?? 21);
    const TRAILING_DAYS = 2;
    const dayOffset = (n: number) =>
      new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    // start_date ≤ today+LOOKAHEAD  AND  end_date ≥ today-TRAILING
    const notAfter = dayOffset(LOOKAHEAD_DAYS);
    const notBefore = dayOffset(-TRAILING_DAYS);
    const { data: events, error } = await supabase
      .from('wfdf_events')
      // static_base is REQUIRED here — eventBase() needs it to rebuild a path
      // event's full URL. Without it every path event refreshes the bare origin.
      .select('slug, name, source_origin, static_base, start_date, end_date, last_scraped_status')
      .eq('last_scraped_status', 'ok') // modern static-cache events only
      .lte('start_date', notAfter)
      .gte('end_date', notBefore);
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const live = (events ?? []).filter((e: any) => e.source_origin);

    const thisYear = new Date().getUTCFullYear();
    const { data: farRows, error: farErr } = await supabase
      .from('wfdf_events')
      .select('slug, name, source_origin, static_base, start_date, end_date, last_scraped_at')
      .eq('last_scraped_status', 'ok')
      .or(
        // Lower bound floors at 21 so a body lookaheadDays can't drag the far
        // tier back over finished events.
        `and(start_date.gt.${dayOffset(Math.max(LOOKAHEAD_DAYS, 21))},start_date.lte.${dayOffset(FAR_LOOKAHEAD_DAYS)}),` +
          `and(start_date.is.null,year.gte.${thisYear})`,
      );
    if (farErr) {
      return new Response(JSON.stringify({ ok: false, error: farErr.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const scrapedAt = (e: any) => (e.last_scraped_at ? Date.parse(e.last_scraped_at) : 0);
    const staleBefore = Date.now() - FAR_MIN_INTERVAL_MIN * 60_000;
    const farStale = (farRows ?? [])
      .filter((e: any) => e.source_origin && scrapedAt(e) < staleBefore)
      .sort((a: any, b: any) => scrapedAt(a) - scrapedAt(b));
    // Rotate by cron firing: an event that fails before the upsert never stamps
    // last_scraped_at, so oldest-first alone would give it the slot forever.
    const farSlots = Math.max(1, Math.ceil(farStale.length / FAR_PER_RUN));
    const farOffset =
      (Math.floor(Date.now() / 60_000 / LIVE_CRON_INTERVAL_MIN) % farSlots) * FAR_PER_RUN;
    const far = farStale.slice(farOffset, farOffset + FAR_PER_RUN);

    const results: any[] = [];
    // Sequential — polite to the source, and each event's ingest is quick.
    // Far events go last so live events always refresh first.
    for (const e of [...live, ...far]) {
      try {
        // source_origin is the ORIGIN only; a path event's segment lives in
        // static_base ("/wucc-2026/live/data/"). Re-ingesting the bare origin
        // would hit the wrong event (or the index), so rebuild the full base.
        const r = await ingest(eventBase(e));
        results.push({ slug: e.slug, ok: true, teams: r.teams, games: r.games });
      } catch (err) {
        results.push({ slug: e.slug, ok: false, error: err instanceof Error ? err.message : String(err) });
        console.error(`[wfdf-ingest] live re-ingest failed for ${e.slug}:`, err);
      }
    }
    return new Response(JSON.stringify({ ok: true, mode: 'dispatch-live', liveEvents: live.length, farWindow: farRows?.length ?? 0, farRefreshed: far.length, results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const base = body?.base;
  if (!base || typeof base !== 'string' || !/^https?:\/\//.test(base)) {
    return new Response(
      JSON.stringify({ error: 'body must be { base: "https://<event>.wfdf.sport" }' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    // MODERN vs LEGACY: modern events self-describe via a heartbeat. If that's
    // absent, it's an older Ultiorganizer event → the legacy HTML path. The
    // caller may pass an explicit `legacy` config to override auto-detection
    // (e.g. to force the season param for a year-less slug).
    const legacyOverride = body?.legacy as Partial<LegacyIngestConfig> | undefined;
    const cleanBase = base.replace(/\/$/, '');
    let hb: any = null;
    if (!legacyOverride) {
      hb = await getJson(`${cleanBase}/live/data/_heartbeat.json`).catch(() => null);
    }

    if (hb && !legacyOverride) {
      const result = await ingest(base, body?.season);
      return new Response(JSON.stringify({ ok: true, mode: 'modern', ...result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Legacy path — resolve the season + metadata (from the body override, else
    // scrape the schedule page <title> like "Schedule WMUCC 2022").
    const cfg = await resolveLegacyConfig(cleanBase, legacyOverride);
    if (!cfg) {
      return new Response(
        JSON.stringify({
          ok: false,
          error:
            'not a modern event (no heartbeat) and could not resolve legacy season — pass { legacy: { season, name, year } }',
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const result = await ingestLegacy(db(), cfg);
    return new Response(JSON.stringify({ ok: true, mode: 'legacy', ...result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[wfdf-ingest] failed:', err);
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
});

// ── Legacy config resolution ─────────────────────────────────────────────────
// Derive { season, name, year, kind, isNational } for a legacy Ultiorganizer
// event from its schedule-page <title> (e.g. "Schedule WMUCC 2022") + the
// season= param used by its view links. Body `override` wins per-field.
async function resolveLegacyConfig(
  base: string,
  override?: Partial<LegacyIngestConfig>,
): Promise<LegacyIngestConfig | null> {
  let season = override?.season ?? '';
  let name = override?.name ?? '';
  let year = override?.year ?? 0;

  if (!season || !name || !year) {
    // Fetch the SCHEDULE view — its <title> is reliably "Schedule XXX YYYY"
    // (the bare root redirects to a Teams page titled just "Teams").
    let html = '';
    try {
      const res = await fetch(`${base}/?view=games`, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
      });
      html = await res.text();
    } catch {
      return override?.season ? (override as LegacyIngestConfig) : null;
    }
    // season= param (the one used by view links, not selseason).
    if (!season) {
      const counts = new Map<string, number>();
      for (const m of html.matchAll(/[?&](?:sel)?season=([A-Za-z0-9_-]+)/g)) {
        counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
      }
      season = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    }
    // name + year from <title> "Schedule WMUCC 2022".
    const titleM = html.match(/<title>\s*(?:Schedule\s+)?([^<]+?)\s*<\/title>/i);
    if (titleM) {
      const t = titleM[1].replace(/\s*[-–].*$/, '').trim();
      if (!name && /20\d{2}/.test(t) && !/^schedule$/i.test(t)) name = t;
      if (!year) {
        const ym = t.match(/(20\d{2})/);
        if (ym) year = Number(ym[1]);
      }
    }
    // Year fallback: from the season param digits.
    if (!year && season) {
      const ym = season.match(/(20\d{2})|(\d{2})$/);
      if (ym) year = Number(ym[1] ?? (ym[2] ? `20${ym[2]}` : ''));
    }
  }

  if (!season || !year) return null;
  // Name fallback: prettify the season id ("WMUCC2022" → "WMUCC 2022").
  if (!name) {
    const m = season.match(/^([A-Za-z]+?)-?(\d{2,4})$/);
    name = m ? `${m[1].toUpperCase()} ${m[2].length === 2 ? '20' + m[2] : m[2]}` : season;
  }

  const isNational =
    override?.isNational !== undefined
      ? override.isNational
      : /wbuc|wwuc|wjuc|wuc|wu24|pauc|aouc|aougc/i.test(season);
  const kind = classifyKind(season, isNational);

  return { base, season, name, year, kind: override?.kind ?? kind, isNational };
}
