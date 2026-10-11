// euf-ingest — ingest one EUCS/EUF event from the Ultiorganizer schedule site.
//
// Cron-driven since 2026-08-04 (jobs 14 refresh / 16 discover) and runnable by
// hand: POST a season id; the function scrapes and upserts the whole event:
// teams, rosters, games, final placements, and per-game box scores.
//
// Request body: { "season": "e2cf25", "name": "2025 EUCF Wroclaw", "year": 2025,
//                 "kind": "eucf", "location": "Wrocław, Poland",
//                 "stats": true }        // stats=false skips box scores
//
// Scrape order matters — each step feeds the next:
//   1. ?view=teams    → team ids + countries (NO division here)
//   2. ?view=teamcard → division + roster totals  [the team→division authority]
//   3. ?view=games    → games, resolved to teams by (division, name)
//   4. ?view=gameplay → per-game box scores
//
// Auto-injected by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  parseGames,
  parseGameplay,
  parseTeamcard,
  parseTeamList,
  type Division,
} from './parse.ts';

const BASE = 'https://eucs-schedule.ultimatefederation.eu';
const UA = 'Mozilla/5.0 (the-layout/euf-ingest)';
// Polite serial pacing. The site has no WAF and did not rate-limit during
// research, but an event is ~200 requests — keep it slow and sequential.
const FETCH_DELAY_MS = 250;
const CONCURRENCY = 4;

// FAR TIER (Hunter, 2026-10-06: "pull event info AS SOON as the league source
// has it"). The refresh window starts at start_date-21d, so once EUCS posts
// teams/games further out the event sat frozen until then. Events starting in
// (today+LOOKAHEAD, today+FAR_LOOKAHEAD_DAYS] get a separate capped check on the
// hourly refresh: the FAR_PER_RUN least-recently-scraped whose last scrape is
// older than FAR_MIN_INTERVAL_MIN. One stats:false ingest is ~2 requests plus
// one teamcard per team (≤ ~56). Nothing sits in this band today, so the cap
// bounds peak load, not current load. Interval < 60 so cron drift (the :41 tick
// lands a few seconds before the previous stamp + 60min) can't skip an hour.
// Constants, not body overrides — this endpoint is reachable by anyone with a key.
const FAR_LOOKAHEAD_DAYS = 120;
const FAR_PER_RUN = 3;
const FAR_MIN_INTERVAL_MIN = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const teamKey = (d: Division, n: string) => `${d}|${normName(n)}`;

function db(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function fetchHtml(url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    if (res.status >= 500) return null; // Ultiorganizer 500s are permanent
    if (res.ok) return await res.text();
    if (attempt === 1) throw new Error(`HTTP ${res.status} for ${url}`);
    await sleep(800);
  }
  return null;
}

/** Run tasks with a small concurrency cap, preserving input order. */
async function pooled<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
        await sleep(FETCH_DELAY_MS);
      }
    }),
  );
  return out;
}

/**
 * Season ids + names from the Ultiorganizer season selector.
 *
 * Every page renders it, and it is the ONLY index the site exposes — there is
 * no ?view=seasons/tournaments listing (checked). Shape:
 *   <select class='seasondropdown' name='selseason'>
 *     <option class='dropdown' value='26SUMBORD'>2026 Summer Tour Bordeaux</option>
 *
 * Scoped to the <select name='selseason'> block specifically so unrelated
 * dropdowns on the page (division/pool pickers) can't leak in as seasons.
 */
function parseSeasonOptions(html: string): Array<{ season: string; name: string }> {
  const block = html.match(/<select[^>]*name=['"]selseason['"][\s\S]*?<\/select>/i);
  if (!block) return [];
  const out: Array<{ season: string; name: string }> = [];
  const seen = new Set<string>();
  for (const m of block[0].matchAll(
    /<option[^>]*value=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/option>/gi,
  )) {
    const season = m[1].trim();
    // Strip tags/entities from the label and collapse whitespace.
    const name = m[2]
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Season ids are short alphanumeric slugs; reject anything else so a
    // placeholder option ("", "Select a season…") can't become a season.
    if (!season || !/^[A-Za-z0-9_-]{2,40}$/.test(season)) continue;
    if (seen.has(season)) continue;
    seen.add(season);
    out.push({ season, name: name || season });
  }
  return out;
}

/** Event kind from its display name, matching the vocabulary already in
 *  euf_events (eucf/e2cf/elite_invite/spring_tour/summer_tour/regional/other). */
function kindFromName(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('e2cf')) return 'e2cf';
  if (n.includes('eucf')) return 'eucf';
  if (n.includes('eucr')) return 'regional';
  if (n.includes('elite invite')) return 'elite_invite';
  if (n.includes('spring tour')) return 'spring_tour';
  if (n.includes('summer tour')) return 'summer_tour';
  if (n.includes('invite')) return 'regional';
  return 'other';
}

interface IngestBody {
  season: string;
  name?: string;
  year?: number;
  kind?: string;
  location?: string;
  slug?: string;
  stats?: boolean;
  /** Override the dates derived from the schedule's day headers (YYYY-MM-DD).
   *  Only needed when an event's schedule page omits them. */
  startDate?: string;
  endDate?: string;
}

/** "9:05" → "09:05". The source emits single-digit hours, which are not a
 *  valid ISO timestamp component. */
function padTime(t: string): string {
  const [h, m] = t.split(':');
  return `${h.padStart(2, '0')}:${m}`;
}

async function ingest(supabase: SupabaseClient, body: IngestBody) {
  const season = body.season;
  if (!season) throw new Error('season is required');
  const url = (view: string, extra = '') =>
    `${BASE}/?view=${view}&season=${encodeURIComponent(season)}${extra}`;

  // ── 1. Team list (ids + countries) ────────────────────────────────────────
  const teamsHtml = await fetchHtml(url('teams', '&list=allteams'));
  if (!teamsHtml) throw new Error(`teams view empty for season ${season}`);
  const teamRefs = parseTeamList(teamsHtml);
  if (!teamRefs.length) throw new Error(`no teams parsed for season ${season}`);

  // ── 2. Teamcards → division (authoritative) + roster totals ───────────────
  const cards = await pooled(teamRefs, async (t) => {
    const html = await fetchHtml(`${BASE}/?view=teamcard&team=${t.eufTeamId}`);
    return { ref: t, card: html ? parseTeamcard(html) : null };
  });

  // ── 3. Upsert event ───────────────────────────────────────────────────────
  // Games are fetched HERE (not at step 6) because the event's start/end dates
  // are DERIVED from the games' day headers ("<h3>Sat 20.9.2025</h3>") — the
  // source has no event-level date field, and these columns were left NULL
  // before, which made any schedule surface impossible.
  const gamesHtml = await fetchHtml(url('games', '&filter=tournaments&group=all'));
  if (!gamesHtml) throw new Error(`games view empty for season ${season}`);
  const games = parseGames(gamesHtml);

  const gameDates = games.map((g) => g.date).filter((d): d is string => Boolean(d)).sort();
  const startDate = body.startDate ?? gameDates[0] ?? null;
  const endDate = body.endDate ?? gameDates[gameDates.length - 1] ?? null;

  // Prefer a year we can prove from the schedule over one guessed from the name.
  const year =
    body.year ??
    (startDate ? Number(startDate.slice(0, 4)) : null) ??
    Number(body.name?.match(/(20\d{2})/)?.[1]) ??
    new Date().getFullYear();

  const { data: eventRow, error: evErr } = await supabase
    .from('euf_events')
    .upsert(
      {
        season_id: season,
        slug: body.slug ?? season.toLowerCase(),
        name: body.name ?? season,
        year,
        kind: body.kind ?? 'other',
        location: body.location ?? null,
        start_date: startDate,
        end_date: endDate,
        source_origin: BASE,
        last_scraped_at: new Date().toISOString(),
        last_scraped_status: 'ok',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'season_id' },
    )
    .select('id')
    .single();
  if (evErr) throw new Error(`event upsert: ${evErr.message}`);
  const eventId = eventRow.id as string;

  // ── 4. Upsert teams ───────────────────────────────────────────────────────
  const teamRows = cards
    .filter((c) => c.card?.division)
    .map((c) => ({
      event_id: eventId,
      euf_team_id: c.ref.eufTeamId,
      division: c.card!.division as Division,
      name: c.card!.name ?? c.ref.name,
      country_name: c.ref.country,
      updated_at: new Date().toISOString(),
    }));
  const skippedTeams = cards.length - teamRows.length;
  if (teamRows.length) {
    const { error } = await supabase
      .from('euf_teams')
      .upsert(teamRows, { onConflict: 'event_id,euf_team_id' });
    if (error) throw new Error(`teams upsert: ${error.message}`);
  }

  const { data: storedTeams, error: stErr } = await supabase
    .from('euf_teams')
    .select('id, euf_team_id, division, name')
    .eq('event_id', eventId);
  if (stErr) throw new Error(`teams read-back: ${stErr.message}`);

  const bySourceId = new Map(storedTeams!.map((t) => [t.euf_team_id as number, t.id as string]));
  // Games name teams WITHOUT ids, and names repeat across divisions — so the
  // lookup key must include the division.
  const byDivName = new Map(
    storedTeams!.map((t) => [teamKey(t.division as Division, t.name as string), t.id as string]),
  );

  // ── 5. Rosters (per-event player totals from the teamcards) ───────────────
  const rosterRows = cards.flatMap((c) => {
    const teamId = bySourceId.get(c.ref.eufTeamId);
    if (!teamId || !c.card) return [];
    return c.card.players.map((p) => ({
      team_id: teamId,
      event_id: eventId,
      euf_player_id: p.eufPlayerId,
      full_name: p.name,
      jersey_number: p.jersey,
      games: p.games,
      goals: p.goals,
      assists: p.assists,
      total: p.total,
    }));
  });
  for (let i = 0; i < rosterRows.length; i += 500) {
    const { error } = await supabase
      .from('euf_rosters')
      .upsert(rosterRows.slice(i, i + 500), { onConflict: 'team_id,euf_player_id' });
    if (error) throw new Error(`rosters upsert: ${error.message}`);
  }

  // ── 6. Games ──────────────────────────────────────────────────────────────
  // (fetched + parsed at step 3 — the event's dates are derived from them)
  let unresolved = 0;
  const gameRows = games.map((g) => {
    const home = byDivName.get(teamKey(g.division, g.home)) ?? null;
    const away = byDivName.get(teamKey(g.division, g.away)) ?? null;
    if (!home || !away) unresolved++;
    return {
      event_id: eventId,
      euf_game_id: g.eufGameId,
      division: g.division,
      round_name: g.round,
      stage: g.stage,
      is_bracket: g.isBracket,
      home_team_id: home,
      away_team_id: away,
      home_score: g.homeScore,
      away_score: g.awayScore,
      field: g.field,
      start_time: g.time,
      // start_time alone is a bare "10:15" with no day. Combining it with the
      // day header gives a real instant so games can be ordered and scheduled
      // across an event. Times are VENUE-LOCAL and the source publishes no
      // offset, so this is stored as UTC — treat it as wall-clock, the same
      // convention the USAU masters ingest uses.
      scheduled_at: g.date && g.time ? `${g.date}T${padTime(g.time)}:00Z` : null,
      status: g.forfeit ? 'forfeit' : 'completed',
      updated_at: new Date().toISOString(),
    };
  });

  const withId = gameRows.filter((r) => r.euf_game_id !== null);
  if (withId.length) {
    const { error } = await supabase
      .from('euf_games')
      .upsert(withId, { onConflict: 'event_id,euf_game_id' });
    if (error) throw new Error(`games upsert: ${error.message}`);
  }
  // Forfeits carry no source id, so they can't participate in the unique index.
  // Delete-then-insert keeps re-ingest idempotent for them.
  const noId = gameRows.filter((r) => r.euf_game_id === null);
  if (noId.length) {
    await supabase.from('euf_games').delete().eq('event_id', eventId).is('euf_game_id', null);
    const { error } = await supabase.from('euf_games').insert(noId);
    if (error) throw new Error(`forfeit games insert: ${error.message}`);
  }

  // Final placements from the bracket games just stored. Scoped to this event
  // and a no-op until its brackets have results; before 2026-10-11 nothing
  // called it after the hourly refresh, so finished events sat unplaced.
  const { data: placed, error: placeErr } = await supabase.rpc('derive_euf_placements', { p_event_id: eventId });
  if (placeErr) throw new Error(`derive placements: ${placeErr.message}`);

  // ── 7. Per-game box scores ────────────────────────────────────────────────
  let statLines = 0;
  let gamesWithStats = 0;
  if (body.stats !== false) {
    const { data: storedGames, error: sgErr } = await supabase
      .from('euf_games')
      .select('id, euf_game_id, home_team_id, away_team_id')
      .eq('event_id', eventId)
      .not('euf_game_id', 'is', null);
    if (sgErr) throw new Error(`games read-back: ${sgErr.message}`);

    const batches = await pooled(storedGames!, async (g) => {
      const html = await fetchHtml(`${BASE}/?view=gameplay&game=${g.euf_game_id}`);
      if (!html) return [];
      const blocks = parseGameplay(html);
      if (blocks.length < 2) return [];
      // Block order is home then away, matching the games-table column order.
      const sides = [g.home_team_id, g.away_team_id];
      return blocks.slice(0, 2).flatMap((block, i) =>
        block.map((p) => ({
          game_id: g.id,
          event_id: eventId,
          team_id: sides[i],
          full_name: p.name,
          jersey_number: p.jersey,
          goals: p.goals,
          assists: p.assists,
          total: p.total,
        })),
      );
    });

    const statRows = batches.flat();
    gamesWithStats = batches.filter((b) => b.length > 0).length;
    statLines = statRows.length;

    // DIFF BEFORE WRITE (2026-08-12). euf-refresh runs hourly and used to
    // blind-upsert every stat line every run (~59.8k no-op updates observed in
    // a single 2h window, with ZERO inserts) — pure WAL + dead-tuple + disk-IO
    // cost on a 2vCPU/2GB instance for no new data. Historical EUCS stats are
    // immutable once scraped, so almost every row is unchanged.
    // ONE paginated read scoped to the event — not one read per game. A
    // per-game loop would be ~180 round trips on the biggest event, costing
    // more than the writes it saves (App Health Rule #2 applies to our own
    // ingest, not just the read path). PostgREST caps responses at 1,000 rows,
    // so page explicitly rather than trusting a large .limit().
    const priorByKey = new Map<string, any>();
    const STAT_PAGE = 1000;
    for (let from = 0; ; from += STAT_PAGE) {
      const { data: priorRows, error: priorErr } = await supabase
        .from('euf_game_player_stats')
        .select('game_id, team_id, full_name, jersey_number, goals, assists, total')
        .eq('event_id', eventId)
        .order('game_id', { ascending: true })
        .range(from, from + STAT_PAGE - 1);
      if (priorErr) throw new Error(`stats read-back: ${priorErr.message}`);
      const batch = priorRows ?? [];
      for (const r of batch) {
        priorByKey.set(`${r.game_id}|${r.team_id}|${r.full_name}`, r);
      }
      if (batch.length < STAT_PAGE) break;
    }
    const changedStats = statRows.filter((r: any) => {
      const p = priorByKey.get(`${r.game_id}|${r.team_id}|${r.full_name}`);
      if (!p) return true; // new stat line
      return (
        p.jersey_number !== r.jersey_number ||
        p.goals !== r.goals ||
        p.assists !== r.assists ||
        p.total !== r.total
      );
    });
    for (let i = 0; i < changedStats.length; i += 500) {
      const { error } = await supabase
        .from('euf_game_player_stats')
        .upsert(changedStats.slice(i, i + 500), { onConflict: 'game_id,team_id,full_name' });
      if (error) throw new Error(`game stats upsert: ${error.message}`);
    }
  }

  return {
    season,
    event: body.name ?? season,
    teams: teamRows.length,
    skippedTeams,
    rosterPlayers: rosterRows.length,
    games: gameRows.length,
    unresolvedGameTeams: unresolved,
    placementsUpdated: placed as number,
    gamesWithStats,
    statLines,
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    const body = (await req.json()) as IngestBody & {
      dispatch?: string;
      lookaheadDays?: number;
      trailingDays?: number;
      stats?: boolean;
    };

    // ── Discovery dispatch (cron) ────────────────────────────────────────────
    // { "dispatch": "discover" } → find EUCS seasons we don't have yet.
    //
    // Every Ultiorganizer page renders a SEASON SELECTOR listing every season
    // the site knows about:
    //   <select name='selseason'><option value='26SUMBORD'>2026 Summer Tour
    //   Bordeaux</option>…</select>
    // That's an authoritative index (32 options today = exactly our 32 events),
    // and it carries the display NAME too, so a discovered event gets real
    // metadata rather than a bare id.
    //
    // Unknown seasons are ingested; known ones are left to the refresh job.
    if (body?.dispatch === 'discover') {
      const supabase = db();
      const MAX_NEW = 12; // bound the work in one run; the rest come next tick

      // Any event page renders the full selector — use a season we already have,
      // else the bare index.
      const { data: seed } = await supabase
        .from('euf_events')
        .select('season_id')
        .order('year', { ascending: false })
        .limit(1);
      const seedSeason = seed?.[0]?.season_id as string | undefined;
      const indexUrl = seedSeason
        ? `${BASE}/?view=games&season=${encodeURIComponent(seedSeason)}`
        : `${BASE}/?view=index`;

      const html = await fetchHtml(indexUrl);
      if (!html) {
        return new Response(
          JSON.stringify({ ok: false, mode: 'dispatch-discover', error: 'index fetch failed' }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
      }

      const options = parseSeasonOptions(html);
      if (options.length === 0) {
        // Never silently report "all clear" when the parse broke — an empty
        // list is indistinguishable from "nothing new" to a caller.
        return new Response(
          JSON.stringify({
            ok: false,
            mode: 'dispatch-discover',
            error: 'season selector not found or empty — markup may have changed',
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
      }

      const { data: known } = await supabase.from('euf_events').select('season_id');
      const knownIds = new Set(
        (known ?? []).map((e: any) => String(e.season_id ?? '').toLowerCase()),
      );

      const fresh = options.filter((o) => !knownIds.has(o.season.toLowerCase()));
      const discovered: any[] = [];
      const failed: any[] = [];

      for (const o of fresh.slice(0, MAX_NEW)) {
        try {
          const r = await ingest(supabase, {
            season: o.season,
            name: o.name,
            slug: o.season.toLowerCase(),
            kind: kindFromName(o.name),
            // year/dates are derived from the schedule's day headers by ingest().
            stats: body.stats === true,
          } as IngestBody);
          discovered.push({ season: o.season, name: o.name, teams: r.teams, games: r.games });
          console.log(`[euf-ingest] discovered ${o.name} (${r.teams} teams, ${r.games} games)`);
        } catch (err) {
          failed.push({
            season: o.season,
            name: o.name,
            error: err instanceof Error ? err.message : String(err),
          });
          console.error(`[euf-ingest] discovery failed for ${o.season}:`, err);
        }
      }

      return new Response(
        JSON.stringify({
          ok: true,
          mode: 'dispatch-discover',
          seasonsListed: options.length,
          newFound: fresh.length,
          ingested: discovered.length,
          skipped: fresh.length - Math.min(fresh.length, MAX_NEW),
          discovered,
          failed,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    // ── Refresh dispatch (cron) ──────────────────────────────────────────────
    // { "dispatch": "refresh" } → re-ingest every event in or near its date
    // window, so a LIVE EUCS season stays current without manual invocation.
    //
    // EUCS has no season index (the site exposes no list of season ids — see
    // the vault note), so this can only refresh events we already know about.
    // NEW events still have to be added once by hand; after that this keeps
    // them fresh automatically.
    //
    // Re-ingest ECHOES BACK the stored name/kind/slug/location. That matters:
    // ingest() defaults those fields, so NOT echoing them would rewrite good
    // metadata with defaults (documented gotcha in the vault's re-ingest recipe).
    //
    // stats:false by default — the per-game box-score refetch is the expensive
    // part and rarely changes for a played game. Pass {stats:true} to include it.
    if (body?.dispatch === 'refresh') {
      const supabase = db();
      const LOOKAHEAD = Number(body.lookaheadDays ?? 21);
      const TRAILING = Number(body.trailingDays ?? 3);
      const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

      // In-window events, PLUS any dateless event for the current/next year —
      // a registered-but-unplayed stop (e.g. 26SUMBORD) has no dates yet and
      // would otherwise never be picked up once its schedule is published.
      const thisYear = new Date().getUTCFullYear();
      const { data: rows, error } = await supabase
        .from('euf_events')
        .select('season_id, slug, name, year, kind, location, start_date, end_date')
        .or(
          `and(start_date.lte.${day(LOOKAHEAD)},end_date.gte.${day(-TRAILING)}),` +
            `and(start_date.is.null,year.gte.${thisYear})`,
        );
      if (error) {
        return new Response(JSON.stringify({ ok: false, error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const { data: farRows, error: farErr } = await supabase
        .from('euf_events')
        .select('season_id, slug, name, year, kind, location, start_date, end_date, last_scraped_at')
        // Floors at 21 so a body lookaheadDays can't drag the far tier back over
        // finished events.
        .gt('start_date', day(Math.max(LOOKAHEAD, 21)))
        .lte('start_date', day(FAR_LOOKAHEAD_DAYS));
      if (farErr) {
        return new Response(JSON.stringify({ ok: false, error: farErr.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const scrapedAt = (e: { last_scraped_at: string | null }) =>
        e.last_scraped_at ? Date.parse(e.last_scraped_at) : 0;
      const staleBefore = Date.now() - FAR_MIN_INTERVAL_MIN * 60_000;
      const farStale = (farRows ?? [])
        .filter((e) => scrapedAt(e) < staleBefore)
        .sort((a, b) => scrapedAt(a) - scrapedAt(b));
      // Rotate by hour: an event that fails before stamping last_scraped_at
      // would otherwise be oldest forever and pin a slot.
      const farSlots = Math.max(1, Math.ceil(farStale.length / FAR_PER_RUN));
      const farOffset = (Math.floor(Date.now() / 3_600_000) % farSlots) * FAR_PER_RUN;
      const far = farStale.slice(farOffset, farOffset + FAR_PER_RUN);

      const results: any[] = [];
      // Far events go last so in-window events always refresh first.
      for (const e of [...(rows ?? []), ...far]) {
        try {
          const r = await ingest(supabase, {
            season: e.season_id as string,
            // Echo stored metadata back so defaults can't overwrite it.
            slug: e.slug as string,
            name: e.name as string,
            year: e.year as number,
            kind: e.kind as string,
            location: (e.location as string) ?? undefined,
            stats: body.stats === true,
          } as IngestBody);
          results.push({ season: e.season_id, ok: true, teams: r.teams, games: r.games });
        } catch (err) {
          results.push({
            season: e.season_id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
          console.error(`[euf-ingest] refresh failed for ${e.season_id}:`, err);
        }
      }
      const failed = results.filter((r) => !r.ok).length;
      return new Response(
        JSON.stringify({
          ok: true,
          mode: 'dispatch-refresh',
          events: results.length,
          farWindow: farRows?.length ?? 0,
          farRefreshed: far.length,
          failed,
          results,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    const result = await ingest(db(), body);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
