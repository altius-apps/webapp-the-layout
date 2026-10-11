// sync-ufa: keep the UFA game + per-player-stat tables fresh during live
// weekends, so the fantasy scorer (score-fantasy, pg_cron) has real stats to
// score. Runs on pg_cron on game days, a few minutes BEFORE score-fantasy.
//
// WHY this exists: UFA stats used to be populated ONLY by a manual script
// (scripts/sync-ufa.ts). When nobody ran it, weeks went unscored — every
// fantasy team scored 0 because ufa_game_player_stats was empty for those
// weeks (bit weeks 11–12, 2026). This function is the automation.
//
// SCOPE — recent games only (NOT a full-season backfill). The full 800-player
// fan-out takes minutes and would blow the Edge Function wall-clock (~150s).
// Instead this processes only RECENT games (start within the last `WINDOW_DAYS`)
// that are non-Upcoming, in bounded batches (`MAX_GAMES_PER_RUN`). pg_cron runs
// it hourly on game days, so it catches up across invocations. The manual
// script stays the tool for a full-season (re)baseline.
//
// Per game processed:
//   1. upsert the game row (so score/status/week flip Upcoming→Final)
//   2. roster-reports?gameID=X → the ~50 players on both sides
//   3. roster-game-stats-for-player?playerID=P&year=Y → that player's game log;
//      keep the row matching THIS gameID → one ufa_game_player_stats row
//   4. upsert ufa_players + ufa_game_player_stats
//
// Idempotent: everything upserts on its key; safe to re-run. A blank/malformed
// upstream player id is SKIPPED (never aborts the run — that exact crash is why
// the manual script silently stopped landing stats).
//
// The one DESTRUCTIVE step is the orphan prune (step 1b): season rows whose
// gameID vanished upstream are deleted, but ONLY when we're certain we fetched
// the complete season (short terminal page AND count == the feed's `total`).
// ufa_game_player_stats cascades off ufa_games, so an ungated prune on a partial
// fetch would wipe real stats — see the comment at the prune for why the gate
// matters more than the prune does.
//
// Request body (all optional):
//   { "year": 2026, "windowDays": 14, "maxGames": 12, "retryDays": 5,
//     "maxPlayerFetches": 120, "prune": true }
//   (larger for manual repair runs; wall-clock caps ~400)
// Auth: deployed with verify_jwt OFF — the cron's key is a new-style sb_secret
// key, not a JWT, so the gateway check would reject it. Instead the caller's
// bearer must work as a secret key against the Auth admin API before anything
// runs; otherwise anyone could trigger a re-scrape (year/windowDays/prune
// included) against the DB.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { Image } from 'https://deno.land/x/imagescript@1.3.0/mod.ts';

const UFA_BASE = 'https://www.backend.ufastats.com/web-v1';
const UA = 'Mozilla/5.0 (the-layout fantasy sync)';
const MAX_GAMES_LIMIT = 20; // upstream games page cap
const FETCH_GAP_MS = 150;   // gentle pacing to the UFA backend

// Defaults — tuned so a run stays well under the Edge wall-clock (~150s). The
// real cost is per-PLAYER season-game-log fetches (~50 per game). We therefore
// cap the TOTAL player fetches per run (MAX_PLAYER_FETCHES), not just games, and
// skip Final games that already have their stats (they won't change). A live
// weekend's newly-final / in-progress games are what get processed; the next
// hourly run catches any remainder. ~120 fetches × ~120ms ≈ 15–20s of fetching.
const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_MAX_GAMES = 12;
// How long we keep retrying a Final game whose stats exist but don't reconcile
// with the final score. Mid-game freezes heal on the next run; but some games'
// upstream stat sheets are PERMANENTLY short (e.g. 2026-07-18-MTL-BOS sums to
// 10 away goals against a real score of 11 — verified at the source), and
// without a cutoff those would re-fan-out ~40 player logs every hourly run
// until they age out of the window.
const DEFAULT_RETRY_DAYS = 5;
const MAX_PLAYER_FETCHES = 120;
// Headshots (watchufa profile-page scrape) are only fetched for players we don't
// already have one for, capped per run so a big first-time sweep never blows the
// wall-clock — subsequent hourly runs finish the rest. Once set, never re-fetched.
const MAX_HEADSHOT_FETCHES = 40;

// ── Orphan pruning ───────────────────────────────────────────────────────────
// UFA has NO "Cancelled" status. When a game is rescheduled or dropped they
// simply DELETE the row and (for a reschedule) publish a new one under a new
// date-keyed gameID. Because this sync is upsert-only, the superseded row used
// to live in ufa_games forever, frozen at 'Upcoming' with null scores.
//
// That is not cosmetic. Two real 2026 orphans were found on 2026-08-29:
//   • 2026-07-17-IND-PIT — 'Upcoming', superseded by 2026-07-19-IND-PIT
//     (Final 29-25, same teams, same week-13). It was the ONLY non-terminal
//     row of the season, and the player-profile champion gate keyed on
//     "every game Final", so this single row suppressed the "UFA Champion
//     2026" chip for the entire championship roster.
//   • 2026-08-27-OAK-NY — week '', score 0-0, start_timestamp in 2025 but
//     stored under year=2026: a corrupt duplicate of the real semifinal
//     2026-08-27-NY-OAK, showing up as a phantom game in schedules/records.
//
// So: after a SUCCESSFUL, COMPLETE season fetch, delete rows for that year that
// upstream no longer lists.
//
// SAFETY — pruning is a delete, so it only runs when we are certain the fetch
// is trustworthy. All of these must hold:
//   1. fetchGames() reported a clean termination (a short final page), NOT a
//      page-cap bailout. A truncated fetch would look like "upstream dropped
//      the tail of the season" and delete real games.
//   2. The fetch returned at least MIN_PRUNE_GAMES rows. Guards against an
//      upstream blip returning an empty/near-empty season (their `limit>20`
//      handling already returns an error object rather than games — see
//      MAX_GAMES_LIMIT — and we must never read that as "delete everything").
//   3. The number of rows to delete is at most MAX_PRUNE_PER_RUN. A correct
//      prune removes a handful of superseded rows; wanting to delete dozens
//      means something is wrong upstream or in our year bookkeeping, so we
//      refuse and report instead of destroying the season.
// Any guard failing skips the prune and surfaces the reason in the response —
// the run still succeeds, the orphans just survive to the next run.
//
// Child rows in ufa_game_player_stats are removed first (explicit, rather than
// relying on an FK cascade that may not be declared).
const MIN_PRUNE_GAMES = 50;
const MAX_PRUNE_PER_RUN = 10;

/** Long-edge px for stored headshots — matches scripts/backfill-ufa-headshots.ts.
 *  The app renders a ~176px (retina) avatar box from the PLAIN stored object. */
const HEADSHOT_MAX_PX = 400;

const WATCHUFA_PLAYER = 'https://www.watchufa.com/league/players';
const HEADSHOT_RE = /src="(https:\/\/[^"]*\/profile-images\/[^"]*_profile\.[A-Za-z]+)"/i;
const HEADSHOT_BUCKET = 'ufa-headshots';
const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
};

/**
 * Self-host a player's UFA headshot: scrape the watchufa profile page for the
 * image src, download it, downscale it, upload to the ufa-headshots bucket as
 * {id}.{ext}, and return OUR public object URL (served PLAIN — the app does not
 * use Supabase's image transform, which bills per unique origin image).
 * We self-host rather than store the watchufa hotlink because those are full-res
 * multi-MB originals off a third-party CDN — slow, flaky, and they can vanish.
 * Never throws, so a missing/blocked headshot never breaks the sync. Returns
 * 'none' only when upstream answered and has no image (remembered, never
 * re-scraped), and 'failed' for anything transient (network, 5xx, 429, upload
 * error) so the player is retried on a later run instead of being written off
 * as imageless forever.
 */
type HeadshotResult = { url: string } | 'none' | 'failed';

/** 4xx other than 429 = upstream's answer; 5xx/429 = try again later. */
const isTransient = (status: number) => status >= 500 || status === 429;

async function fetchHeadshotUrl(supabase: SupabaseClient, playerID: string): Promise<HeadshotResult> {
  // 1. Scrape the profile page for the source image URL.
  let srcUrl: string | null = null;
  try {
    const res = await fetch(`${WATCHUFA_PLAYER}/${encodeURIComponent(playerID)}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    if (!res.ok) return isTransient(res.status) ? 'failed' : 'none';
    const m = (await res.text()).match(HEADSHOT_RE);
    srcUrl = m ? m[1] : null;
  } catch {
    return 'failed';
  }
  if (!srcUrl) return 'none';

  // 2. Download the original.
  let bytes: Uint8Array;
  try {
    const res = await fetch(srcUrl, { headers: { 'User-Agent': UA } });
    if (!res.ok) return isTransient(res.status) ? 'failed' : 'none';
    bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) return 'failed';
  } catch {
    return 'failed';
  }

  // 3. Downscale before storing. Upstream images are ~3.4 MB 2400x3000 camera
  // originals; the app serves these objects PLAIN (no image transform — that
  // endpoint bills per unique origin image, 100/cycle on Pro) into a ~176px
  // avatar box, so storing the original ships ~99% waste on every render.
  // Soft-fails to the original bytes if decode/encode throws.
  let ext = (srcUrl.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (ext === 'jpeg') ext = 'jpg';
  try {
    const img = await Image.decode(bytes);
    const scale = HEADSHOT_MAX_PX / Math.max(img.width, img.height);
    if (scale < 1) {
      img.resize(Math.round(img.width * scale), Math.round(img.height * scale));
      bytes = await img.encodeJPEG(80);
      ext = 'jpg'; // re-encoded as JPEG regardless of the source container
    }
  } catch { /* keep the original bytes */ }

  // 4. Upload to our bucket as {id}.{ext} (upsert → self-heals on change).
  const objectPath = `${playerID}.${ext}`;
  const { error } = await supabase.storage
    .from(HEADSHOT_BUCKET)
    .upload(objectPath, bytes, {
      contentType: MIME[ext] ?? 'image/jpeg',
      upsert: true,
      cacheControl: '31536000',
    });
  if (error) return 'failed';
  return { url: supabase.storage.from(HEADSHOT_BUCKET).getPublicUrl(objectPath).data.publicUrl };
}

// ── roster-reports fallback for championship-weekend / all-star games ───────
// roster-reports returns {home:[],away:[]} for those games (confirmed live),
// which silently left the title game's stat rows out of every hourly sync —
// same gap the app's own boxscore/jersey-number fallbacks work around via
// stats-pages/game/{gameID}. Ported here so the cron doesn't permanently skip
// a championship weekend every season.

/** Collapse a name to comparable letters — case, accents, punctuation and
 *  spacing all drift between the two feeds. */
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');
}

/** name → playerID for one season, from player-stats?year=Y. Colliding names
 *  map to null so they're skipped rather than resolved to the wrong player. */
async function buildPlayerNameIndex(year: number): Promise<Map<string, string | null>> {
  const byName = new Map<string, string | null>();
  for (let page = 1; page <= 30; page++) {
    const data = await ufaGet<{ stats?: ApiPlayerStat[] }>(
      `player-stats?year=${year}&limit=30&page=${page}`,
    );
    const rows = data.stats ?? [];
    for (const p of rows) {
      const key = normalizeName(p.name ?? '');
      if (!key) continue;
      byName.set(key, byName.has(key) ? null : p.playerID);
    }
    if (rows.length < 30) break;
    await sleep(FETCH_GAP_MS);
  }
  return byName;
}

/** Roster for one game via stats-pages, with playerIDs resolved by name
 *  against the season's player index. Returns null when stats-pages has no
 *  roster for the game either. */
async function fetchRosterViaStatsPages(
  gameID: string,
  nameIndex: Map<string, string | null>,
): Promise<ApiRosterReports | null> {
  const data = await ufaStatsPagesGet<ApiStatsPagesGame>(gameID);
  if (!data) return null;
  const convert = (rows: StatsPagesRosterEntry[]): ApiRosterPlayer[] => {
    const out: ApiRosterPlayer[] = [];
    for (const e of rows) {
      const first = e.player?.first_name ?? '';
      const last = e.player?.last_name ?? '';
      const playerID = nameIndex.get(normalizeName(`${first}${last}`));
      if (!playerID) continue;
      out.push({ playerID, firstName: first, lastName: last });
    }
    return out;
  };
  const home = convert(data.rostersHome ?? []);
  const away = convert(data.rostersAway ?? []);
  if (home.length === 0 && away.length === 0) return null;
  return { home, away };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function db(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function ufaGet<T>(path: string, attempt = 1): Promise<T> {
  try {
    const res = await fetch(`${UFA_BASE}/${path}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (attempt < 3) {
      await sleep(500 * attempt);
      return ufaGet<T>(path, attempt + 1);
    }
    throw new Error(`UFA ${path} failed after ${attempt} tries: ${(err as Error).message}`);
  }
}

const STATS_PAGES_BASE = 'https://www.backend.ufastats.com/stats-pages';

/** Best-effort — same endpoint watchufa's own game center uses. Returns null
 *  on any failure rather than retrying; the caller already has a game to
 *  process either way (roster-reports may just be genuinely empty). */
async function ufaStatsPagesGet<T>(gameID: string): Promise<T | null> {
  try {
    const res = await fetch(`${STATS_PAGES_BASE}/game/${encodeURIComponent(gameID)}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const KNOWN_FINAL = 'Final';
const KNOWN_UPCOMING = 'Upcoming';
function normalizeStatus(raw: string | undefined): string {
  if (!raw) return KNOWN_UPCOMING;
  if (raw === KNOWN_UPCOMING || raw === KNOWN_FINAL) return raw;
  return 'InProgress'; // any non-terminal phase is an in-play game
}

// A per-game/player id we accept as a safe PK. Blank/malformed → caller skips.
function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && /^[\w\-./]+$/.test(id);
}

function splitName(full: string): { first: string; last: string } {
  const parts = (full ?? '').trim().split(/\s+/);
  if (parts.length <= 1) return { first: parts[0] ?? '', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// ── Wire shapes (subset) ─────────────────────────────────────────────────────
interface ApiGame {
  gameID: string;
  awayTeamID: string;
  homeTeamID: string;
  awayScore: number;
  homeScore: number;
  status: string;
  week?: string;
  startTimestamp?: string;
  locationName?: string;
}
interface ApiRosterPlayer { playerID: string; firstName?: string; lastName?: string; status?: string }
interface ApiRosterReports { home?: ApiRosterPlayer[]; away?: ApiRosterPlayer[] }
interface ApiPlayerStat { playerID: string; name?: string }
interface StatsPagesRosterEntry {
  jersey_number?: string | number | null;
  player: { first_name?: string; last_name?: string } | null;
}
interface ApiStatsPagesGame {
  rostersHome?: StatsPagesRosterEntry[] | null;
  rostersAway?: StatsPagesRosterEntry[] | null;
}
interface ApiPlayerGameRow {
  gameID: string; isHome: boolean;
  goals: number; assists: number; hockeyAssists: number; blocks: number; callahans: number;
  throwaways: number; drops: number; stalls: number; completions: number; throwsAttempted: number;
  catches: number; yardsThrown: number; yardsReceived: number;
  oPointsPlayed: number; oPointsScored: number; dPointsPlayed: number; dPointsScored: number;
  secondsPlayed: number; pulls: number; hucksCompleted: number; hucksAttempted: number;
}

/**
 * Walk the season's games pages.
 *
 * `complete` reports whether we are certain we saw the WHOLE season: the walk
 * ended on a short page (upstream's terminal signal) AND the row count matches
 * the `total` the feed reports alongside every page. Anything else — a page cap
 * hit, a mid-walk shortfall — leaves it false. Only the orphan prune reads this;
 * the upsert path is safe either way (it only ever writes what it saw).
 */
async function fetchGames(year: number): Promise<{ games: ApiGame[]; complete: boolean }> {
  const out: ApiGame[] = [];
  let total: number | null = null;
  let sawShortPage = false;
  for (let page = 1; page <= 30; page++) {
    const data = await ufaGet<{ games?: ApiGame[]; total?: number }>(
      `games?years=${year}&limit=${MAX_GAMES_LIMIT}&page=${page}`,
    );
    if (typeof data.total === 'number') total = data.total;
    const rows = data.games ?? [];
    out.push(...rows);
    if (rows.length < MAX_GAMES_LIMIT) { sawShortPage = true; break; }
    await sleep(FETCH_GAP_MS);
  }
  return { games: out, complete: sawShortPage && total !== null && out.length === total };
}

async function upsert(supabase: SupabaseClient, table: string, rows: Record<string, unknown>[], onConflict: string) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + CHUNK), { onConflict });
    if (error) throw new Error(`upsert ${table}: ${error.message}`);
  }
}

function gameRowOf(g: ApiGame, year: number) {
  const status = normalizeStatus(g.status);
  const played = status !== KNOWN_UPCOMING;
  return {
    id: g.gameID,
    year,
    week: g.week ?? null,
    start_timestamp: g.startTimestamp ?? null,
    status,
    home_team_id: g.homeTeamID || null,
    away_team_id: g.awayTeamID || null,
    home_score: played ? g.homeScore : null,
    away_score: played ? g.awayScore : null,
    location_name: g.locationName ?? null,
    updated_at: new Date().toISOString(),
  };
}

interface PruneResult {
  pruned: number;
  prunedIds: string[];
  skipped: string | null;
}

/**
 * Delete stored games for `year` that upstream no longer lists. See the
 * "Orphan pruning" block above for why this exists and what each guard
 * protects against. Never throws: a prune failure must not fail the sync.
 */
async function pruneOrphans(
  supabase: SupabaseClient,
  year: number,
  upstreamIds: Set<string>,
  fetchComplete: boolean,
): Promise<PruneResult> {
  const none: PruneResult = { pruned: 0, prunedIds: [], skipped: null };

  if (!fetchComplete) {
    return { ...none, skipped: 'season fetch hit the page cap (possibly truncated)' };
  }
  if (upstreamIds.size < MIN_PRUNE_GAMES) {
    return {
      ...none,
      skipped: `upstream returned only ${upstreamIds.size} games (< ${MIN_PRUNE_GAMES})`,
    };
  }

  // Paged explicitly: PostgREST caps a single response at 1000 rows and
  // truncates SILENTLY. A truncated scan can't invent an orphan (unseen rows
  // are simply not considered), but paging keeps that true if a season ever
  // exceeds the cap rather than leaving it a latent under-prune.
  const held: string[] = [];
  {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('ufa_games')
        .select('id')
        .eq('year', year)
        .range(from, from + PAGE - 1);
      if (error) return { ...none, skipped: `could not read stored games: ${error.message}` };
      const rows = data ?? [];
      for (const r of rows) held.push((r as { id: string }).id);
      if (rows.length < PAGE) break;
    }
  }

  const orphans = held.filter((id) => !upstreamIds.has(id));

  if (orphans.length === 0) return none;
  if (orphans.length > MAX_PRUNE_PER_RUN) {
    return {
      ...none,
      skipped:
        `${orphans.length} orphans exceeds the ${MAX_PRUNE_PER_RUN}-per-run safety cap ` +
        `— refusing to delete; investigate before pruning`,
    };
  }

  // Child stat rows first (don't rely on an FK cascade being declared).
  const { error: statErr } = await supabase
    .from('ufa_game_player_stats')
    .delete()
    .in('game_id', orphans);
  if (statErr) return { ...none, skipped: `could not delete stat rows: ${statErr.message}` };

  const { error: gameErr } = await supabase
    .from('ufa_games')
    .delete()
    .eq('year', year)
    .in('id', orphans);
  if (gameErr) return { ...none, skipped: `could not delete game rows: ${gameErr.message}` };

  console.warn(`[sync-ufa] pruned ${orphans.length} orphan game(s) for ${year}: ${orphans.join(', ')}`);
  return { pruned: orphans.length, prunedIds: orphans, skipped: null };
}

async function run(body: { year?: number; windowDays?: number; maxGames?: number; retryDays?: number; maxPlayerFetches?: number; prune?: boolean }) {
  const supabase = db();
  const now = new Date();
  // The calendar year: UFA publishes a new season's schedule in winter, and
  // fantasy weeks are built from ufa_games, so the schedule has to land as soon
  // as it exists — not in April. Before it's published the fetch returns no
  // games, and pruneOrphans skips (< MIN_PRUNE_GAMES), so nothing is touched.
  const year = body.year ?? now.getUTCFullYear();
  const windowDays = body.windowDays ?? DEFAULT_WINDOW_DAYS;
  const maxGames = body.maxGames ?? DEFAULT_MAX_GAMES;
  const retryDays = body.retryDays ?? DEFAULT_RETRY_DAYS;
  const maxPlayerFetches = body.maxPlayerFetches ?? MAX_PLAYER_FETCHES;
  const prune = body.prune ?? true;
  const windowStartMs = now.getTime() - windowDays * 86400_000;
  const retryStartMs = now.getTime() - retryDays * 86400_000;

  // 1. Season games. Upsert ALL of them (cheap) so schedule/scores/status stay
  //    fresh even for games we don't fan-out stats for this run.
  const { games, complete: seasonFetchComplete } = await fetchGames(year);
  const gameRows = games.filter((g) => isSafeId(g.gameID)).map((g) => gameRowOf(g, year));

  // Make sure every team slug referenced by these games exists (minimal row —
  // the full-season manual sync seeds richer metadata; this is just an FK guard
  // so a brand-new team never breaks the game upsert).
  const teamSlugs = new Set<string>();
  for (const g of games) {
    if (isSafeId(g.homeTeamID)) teamSlugs.add(g.homeTeamID);
    if (isSafeId(g.awayTeamID)) teamSlugs.add(g.awayTeamID);
  }
  if (teamSlugs.size > 0) {
    const { data: existing } = await supabase.from('ufa_teams').select('id').in('id', [...teamSlugs]);
    const have = new Set((existing ?? []).map((r) => (r as { id: string }).id));
    const missing = [...teamSlugs].filter((s) => !have.has(s)).map((slug) => ({
      id: slug,
      name: slug,
      abbr: slug.slice(0, 3).toUpperCase(),
      updated_at: new Date().toISOString(),
    }));
    if (missing.length > 0) await upsert(supabase, 'ufa_teams', missing, 'id');
  }
  if (gameRows.length > 0) await upsert(supabase, 'ufa_games', gameRows, 'id');

  // 1b. Drop rows upstream no longer lists (reschedules, removals, corrupt
  //     duplicates). Runs AFTER the upsert so a rescheduled game's replacement
  //     row is already present before its predecessor is removed. Every safety
  //     guard lives in pruneOrphans() — see the "Orphan pruning" block above.
  const pruneResult: PruneResult = prune
    ? await pruneOrphans(supabase, year, new Set(gameRows.map((r) => r.id as string)), seasonFetchComplete)
    : { pruned: 0, prunedIds: [], skipped: 'prune disabled by request' };

  // 2. Recent, non-Upcoming games in the window — candidates for stat sync.
  const candidates = games
    .filter((g) => isSafeId(g.gameID) && normalizeStatus(g.status) !== KNOWN_UPCOMING)
    .filter((g) => {
      const t = g.startTimestamp ? new Date(g.startTimestamp).getTime() : NaN;
      return !Number.isNaN(t) && t >= windowStartMs;
    })
    .sort((a, b) => (b.startTimestamp ?? '').localeCompare(a.startTimestamp ?? ''));

  // Skip Final games only when their stats are COMPLETE (per-side goal sums
  // match the final score — ufa_complete_stat_game_ids). "Has any stats" is NOT
  // enough: a game synced while InProgress froze at its mid-game snapshot the
  // moment it flipped Final, and 10 of the Jul 17-19 2026 weekend's games got
  // stuck partial that way (feeding standouts + fantasy bad lines). In-progress
  // games are always (re)processed. A game whose upstream stat sheet never
  // reconciles re-fetches until it ages out of the window — bounded waste.
  const candidateIds = candidates.map((g) => g.gameID);
  const completeStats = new Set<string>();
  const anyStats = new Set<string>();
  if (candidateIds.length > 0) {
    const { data: complete, error: completeErr } = await supabase
      .rpc('ufa_complete_stat_game_ids', { p_ids: candidateIds });
    if (completeErr) throw new Error(`ufa_complete_stat_game_ids: ${completeErr.message}`);
    for (const r of complete ?? []) completeStats.add((r as { game_id: string }).game_id);
    const { data: withStats } = await supabase
      .from('ufa_game_player_stats')
      .select('game_id')
      .in('game_id', candidateIds);
    for (const r of withStats ?? []) anyStats.add((r as { game_id: string }).game_id);
  }
  const recent = candidates
    .filter((g) => {
      if (normalizeStatus(g.status) === 'InProgress') return true; // still moving
      if (completeStats.has(g.gameID)) return false;               // done, reconciled
      if (!anyStats.has(g.gameID)) return true;                    // never synced
      // Partial Final game: retry only while recent (retryDays). Beyond that the
      // shortfall is upstream's, not a mid-game freeze — stop burning the budget.
      const t = g.startTimestamp ? new Date(g.startTimestamp).getTime() : NaN;
      return !Number.isNaN(t) && t >= retryStartMs;
    })
    .slice(0, maxGames);

  // Players we should NOT spend a headshot fetch on: those who already have a
  // self-hosted headshot, PLUS those we've already checked and found to have no
  // image upstream (headshot_checked_at set).
  //
  // The second half matters: the per-run budget is only MAX_HEADSHOT_FETCHES,
  // and ~half of all players have no watchufa photo at all. Without the
  // checked-at filter every run burned its whole budget re-scraping the same
  // imageless early-alphabet ids, so players later in the alphabet were never
  // reached — that's why ~1,858 rows sat null indefinitely.
  const existingHeadshots = new Set<string>();
  {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data } = await supabase
        .from('ufa_players')
        .select('id')
        .or('headshot_url.not.is.null,headshot_checked_at.not.is.null')
        .range(from, from + PAGE - 1);
      const rows = data ?? [];
      for (const r of rows) existingHeadshots.add((r as { id: string }).id);
      if (rows.length < PAGE) break;
    }
  }

  const gameById = new Map(games.map((g) => [g.gameID, g]));
  let statRowCount = 0;
  let skippedPlayers = 0;
  let playerFetches = 0;      // total upstream game-log fetches this run
  let headshotFetches = 0;    // watchufa profile-page scrapes this run
  let fetchBudgetHit = false; // true once we stop starting new games mid-cap
  const playersSeen = new Set<string>();
  const playerRows: Record<string, unknown>[] = [];
  // Headshot results applied after the bulk upsert (see PGRST102 note below).
  const headshotUpdates: { id: string; url: string | null }[] = [];
  const statRows: Record<string, unknown>[] = [];

  // Built lazily, once, only if a game actually needs it (championship-weekend
  // / all-star games where roster-reports comes back empty) — the 30-page walk
  // isn't worth the cost on a normal run where every game resolves directly.
  let playerNameIndex: Map<string, string | null> | null = null;

  for (const g of recent) {
    // Stop starting new games once the fetch budget is (nearly) spent — a game
    // needs a full roster's worth of fetches to be useful, so don't begin one we
    // can't finish. The next hourly run resumes with the leftover games.
    if (playerFetches >= maxPlayerFetches) { fetchBudgetHit = true; break; }
    let roster: ApiRosterReports;
    try {
      roster = await ufaGet<ApiRosterReports>(`roster-reports?gameID=${encodeURIComponent(g.gameID)}`);
    } catch (err) {
      console.warn(`[sync-ufa] roster failed for ${g.gameID}: ${(err as Error).message}`);
      continue;
    }
    // roster-reports returns {home:[],away:[]} for championship-weekend and
    // all-star games (confirmed live against the upstream API) — without this
    // fallback the title game was silently skipped on EVERY hourly run,
    // forever, with no error (the player-of-the-game / champion badge on
    // /players/[id] reads this table and stayed permanently stale for the
    // season's biggest game). Same stats-pages fallback the app's own
    // boxscore/jersey-number code uses.
    if ((roster.home ?? []).length === 0 && (roster.away ?? []).length === 0) {
      if (!playerNameIndex) {
        try {
          playerNameIndex = await buildPlayerNameIndex(year);
        } catch (err) {
          console.warn(`[sync-ufa] player name index failed: ${(err as Error).message}`);
          playerNameIndex = new Map();
        }
      }
      const fallback = await fetchRosterViaStatsPages(g.gameID, playerNameIndex);
      if (fallback) roster = fallback;
    }
    // Drop "Not Rostered" org players — roster-reports returns the WHOLE org
    // (~70+ entries incl. practice squad); only game-rostered players can have a
    // stat line, and fetching dead logs was burning most of the fetch budget
    // (~30 wasted fetches/game — starved multi-game runs). The stats-pages
    // fallback has no "Not Rostered" concept (it only returns dressed players),
    // so `status` is undefined there and this filter is a no-op for it.
    const rosterPlayers = [...(roster.home ?? []), ...(roster.away ?? [])]
      .filter((rp) => rp.status !== 'Not Rostered');

    for (const rp of rosterPlayers) {
      if (!isSafeId(rp.playerID)) { skippedPlayers++; continue; }
      // Fetch this player's season game log ONCE per run (a player can appear in
      // several of this run's recent games — the log already contains all of
      // them, so we cache and reuse it).
      let log: ApiPlayerGameRow[] = playerLogCache.get(rp.playerID) ?? [];
      if (!playerLogCache.has(rp.playerID)) {
        try {
          const data = await ufaGet<{ stats?: ApiPlayerGameRow[] }>(
            `roster-game-stats-for-player?playerID=${encodeURIComponent(rp.playerID)}&year=${year}`,
          );
          log = data.stats ?? [];
        } catch (err) {
          console.warn(`[sync-ufa] game log failed for ${rp.playerID}: ${(err as Error).message}`);
          log = [];
        }
        playerLogCache.set(rp.playerID, log);
        playerFetches++;
        await sleep(FETCH_GAP_MS);
      }

      // player row (infer team from any logged game side)
      if (!playersSeen.has(rp.playerID)) {
        playersSeen.add(rp.playerID);
        let teamId: string | null = null;
        for (const r of log) {
          const lg = gameById.get(r.gameID);
          if (lg) { teamId = r.isHome ? lg.homeTeamID : lg.awayTeamID; if (teamId) break; }
        }
        const full = `${rp.firstName ?? ''} ${rp.lastName ?? ''}`.trim();
        const { first, last } = splitName(full);

        // Headshot: only scrape (watchufa profile page) when we DON'T already
        // have one for this player (or haven't already checked) and we're under
        // the per-run budget. Headshots almost never change, so once resolved we
        // skip forever.
        //
        // The result is applied as a SEPARATE targeted update, never as a key on
        // this bulk-upsert row: PostgREST requires every row in one upsert to
        // have identical keys (PGRST102), so a conditionally-present column
        // would fail the whole batch as soon as one player is scraped and
        // another isn't. It also avoids clobbering an existing headshot_url
        // with null.
        playerRows.push({
          id: rp.playerID,
          first_name: rp.firstName ?? first,
          last_name: rp.lastName ?? last,
          full_name: full || rp.playerID,
          current_team_id: teamId,
          updated_at: new Date().toISOString(),
        });
        if (headshotFetches < MAX_HEADSHOT_FETCHES && !existingHeadshots.has(rp.playerID)) {
          const result = await fetchHeadshotUrl(supabase, rp.playerID);
          headshotFetches++;
          existingHeadshots.add(rp.playerID); // don't re-scrape within this run
          // Stamp found and 'none' — "no image upstream" must be remembered so
          // the next run spends its budget on someone else. A 'failed' fetch is
          // NOT stamped, so a blip doesn't mark the player imageless forever.
          if (result !== 'failed') {
            headshotUpdates.push({ id: rp.playerID, url: result === 'none' ? null : result.url });
          }
        }
      }

      // the stat line for THIS game
      const row = log.find((r) => r.gameID === g.gameID);
      if (!row) continue;
      const sideTeam = row.isHome ? g.homeTeamID : g.awayTeamID;
      statRows.push({
        game_id: g.gameID,
        player_id: rp.playerID,
        team_id: sideTeam || null,
        is_home: row.isHome,
        goals: row.goals ?? 0,
        assists: row.assists ?? 0,
        hockey_assists: row.hockeyAssists ?? 0,
        blocks: row.blocks ?? 0,
        callahans: row.callahans ?? 0,
        throwaways: row.throwaways ?? 0,
        drops: row.drops ?? 0,
        stalls: row.stalls ?? 0,
        completions: row.completions ?? 0,
        throws_attempted: row.throwsAttempted ?? 0,
        catches: row.catches ?? 0,
        yards_thrown: row.yardsThrown ?? 0,
        yards_received: row.yardsReceived ?? 0,
        o_points_played: row.oPointsPlayed ?? 0,
        o_points_scored: row.oPointsScored ?? 0,
        d_points_played: row.dPointsPlayed ?? 0,
        d_points_scored: row.dPointsScored ?? 0,
        seconds_played: row.secondsPlayed ?? 0,
        pulls: row.pulls ?? 0,
        hucks_completed: row.hucksCompleted ?? 0,
        hucks_attempted: row.hucksAttempted ?? 0,
        updated_at: new Date().toISOString(),
      });
      statRowCount++;
    }
  }

  // FK order: players first, then their stat lines.
  if (playerRows.length > 0) await upsert(supabase, 'ufa_players', playerRows, 'id');
  if (statRows.length > 0) await upsert(supabase, 'ufa_game_player_stats', statRows, 'game_id,player_id');

  // Headshot results: one targeted update per scraped player. Runs AFTER the
  // upsert so the row exists, and stays out of that batch to keep its keys
  // uniform (PGRST102). Capped by MAX_HEADSHOT_FETCHES, so this is <=40 updates.
  for (const h of headshotUpdates) {
    const patch: Record<string, unknown> = { headshot_checked_at: new Date().toISOString() };
    if (h.url) patch.headshot_url = h.url;
    await supabase.from('ufa_players').update(patch).eq('id', h.id);
  }

  return {
    year,
    gamesUpserted: gameRows.length,
    seasonFetchComplete,
    orphansPruned: pruneResult.pruned,
    prunedIds: pruneResult.prunedIds,
    pruneSkipped: pruneResult.skipped,
    recentGamesProcessed: recent.length,
    playerFetches,
    headshotFetches,
    fetchBudgetHit,
    playersUpserted: playerRows.length,
    statRowsUpserted: statRowCount,
    skippedPlayers,
  };
}

// Per-invocation cache: a player logged in >1 recent game shouldn't be fetched
// twice in the same run. Declared at module scope but only ever read/written
// within a single run() (Edge invocations are one-shot).
const playerLogCache = new Map<string, ApiPlayerGameRow[]>();

/** True when the bearer is a secret/service-role key for this project: only
 *  those can call the Auth admin API. */
async function callerHoldsSecretKey(req: Request): Promise<boolean> {
  const url = Deno.env.get('SUPABASE_URL');
  const key = /^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') ?? '')?.[1];
  if (!url || !key) return false;
  const caller = createClient(url, key, { auth: { persistSession: false } });
  const { error } = await caller.auth.admin.listUsers({ page: 1, perPage: 1 });
  return !error;
}

Deno.serve(async (req) => {
  if (!(await callerHoldsSecretKey(req))) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    });
  }
  playerLogCache.clear();
  let body: {
    year?: number; windowDays?: number; maxGames?: number; retryDays?: number;
    maxPlayerFetches?: number; prune?: boolean;
  } = {};
  try { body = await req.json(); } catch { /* empty ok */ }
  try {
    const result = await run(body);
    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[sync-ufa] failed:', err);
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
});
