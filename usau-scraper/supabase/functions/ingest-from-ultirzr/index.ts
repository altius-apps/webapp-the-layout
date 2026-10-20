// ingest-from-ultirzr: pull events + games for one (year, division) from
// ultirzr.app's public JSON API and upsert into our usau_* tables.
//
// Why this exists: USAU's calendar form blocks programmatic POSTs from
// non-browser clients, so we couldn't enumerate historical events through
// HTML scraping alone. ultirzr.app already scrapes USAU and exposes the
// same data as a JSON API — we leverage their work.
//
// Request body:
//   { year: number,
//     division?: 'mens-club' | 'womens-club' | 'mixed-club' | 'masters' | string,
//     page?: number       // start at this /search page (default 1)
//     maxPages?: number   // hard cap on /search pagination from this start (default 1)
//     dryRun?: boolean }  // skip DB writes, just report what we'd do
//
// MASTERS MODE (division: 'masters'):
//   Club divisions map 1:1 to an ultirzr EventGroupName, but masters events
//   host up to 7 age×gender groups on one EventId ('Masters - Men',
//   'Grand Masters - Mixed', 'Great Grand Masters - Women', …) and ultirzr's
//   /search division filter doesn't cover them. So masters mode searches by
//   `query=masters` (name substring) and ingests EVERY masters-family group
//   per event, classifying each group independently:
//     - team competition_level: 'Masters - *' → MASTERS; 'Grand Masters - *'
//       → GRAND_MASTERS; 'Great Grand Masters - *' → GREAT_GRAND_MASTERS (its
//       own level as of 2026-07 — was previously folded into GRAND_MASTERS).
//     - bracket_name is prefixed with a short group label ("GM Women · Pool A")
//       so the combined championships' divisions stay distinguishable.
//   Non-masters events surfaced by the name search (clinics, "Masters Minus"
//   club tournaments) have no masters-family group → quietly skipped.
//
// Edge Functions cap CPU per invocation, so we work one /search page (20
// events) per call. The response includes `nextPage` so the caller can
// loop until null. A future cron wrapper would call us once per page and
// stop when nextPage is null.
//
// What it writes:
//   - usau_events (one row per ultirzr event, keyed on usau_event_id)
//   - usau_teams (one row per persistent USAU team id, keyed on usau_team_id)
//   - usau_event_teams (per-event participation; PK event_id + team_id)
//   - usau_games (one row per ultirzr EventGameId, keyed on usau_event_game_id)
//
// What it does NOT write:
//   - usau_players / usau_rosters / usau_player_event_stats — ultirzr
//     doesn't expose rosters or per-event player stats. Those still come
//     from sync-event-rosters (HTML scrape of the team page).

import { supabase, withRunLogging } from '../_shared/supabase.ts';
import { tzForState, localWallTimeToUtcIso } from '../_shared/tz.ts';
import { refreshEventPlacements } from '../_shared/event-placements.ts';

interface RequestBody {
  year?: number;
  division?: string;
  page?: number;
  maxPages?: number;
  dryRun?: boolean;
  /** Optional name-search override. ultirzr's `division=` search filter is
   *  broken for some older seasons (2015 mens/womens-club return generic HS
   *  results), so a name query lets us reach a specific event by title while
   *  still filtering to the requested division's GROUP. Mirrors the masters
   *  path, which always searches by `query=masters`. */
  query?: string;
  /** Targeted backfill: ingest ONLY this ultirzr EventId from the search
   *  results, skipping all other hits. Pairs with `query` to load one known
   *  event without pulling look-alikes the fuzzy search also returns. */
  onlyEventId?: number;
}

interface UltirzrEventSearchHit {
  EventId: number;
  EventName: string;
  EventLogo?: string;
  EventType?: string;
  EventTypeName?: string;
  City?: string | null;
  State?: string | null;
  StartDate?: string;
  EndDate?: string;
  EventGroups?: unknown[];
}

interface UltirzrGame {
  EventGameId: number;
  GameName?: string;
  StartDate?: string;
  StartTime?: string;
  HomeTeamId?: number;
  AwayTeamId?: number;
  HomeTeamName?: string;
  AwayTeamName?: string;
  HomeTeamScore?: string | number;
  AwayTeamScore?: string | number;
  FieldName?: string;
  GameStatus?: string;
}

interface UltirzrPool {
  Name?: string;
  PoolId?: number;
  Games?: UltirzrGame[];
}

interface UltirzrStage {
  StageId?: number;
  StageName?: string;
  Games?: UltirzrGame[];
}

interface UltirzrBracket {
  BracketId?: number;
  BracketName?: string;
  Stage?: UltirzrStage[];
}

interface UltirzrRound {
  RoundId?: number;
  Pools?: UltirzrPool[];
  Brackets?: UltirzrBracket[];
  Clusters?: unknown[];
}

interface UltirzrGroup {
  EventGroupId?: number;
  EventGroupName?: string;
  UsauUrl?: string;
  EventRounds?: UltirzrRound[];
}

interface UltirzrEventFull {
  EventName: string;
  EventLogo?: string;
  City?: string | null;
  State?: string | null;
  StartDate?: string;
  EndDate?: string;
  EventType?: string;
  EventTypeName?: string;
  EventGroups?: UltirzrGroup[];
}

// ─── HTTP ──────────────────────────────────────────────────────────────

const BASE = 'https://ultirzr.app/api/v1';
const MIN_GAP_MS = 600; // be polite, well under any reasonable rate limit
let lastFetchAt = 0;

async function fetchUltirzr<T>(path: string): Promise<T> {
  const now = Date.now();
  const wait = Math.max(0, lastFetchAt + MIN_GAP_MS - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt = Date.now();

  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      // Identify ourselves so the operator can rate-limit / block if needed.
      'User-Agent': 'the-layout-scraper/1.0 (huntermay@altiusapps.com)',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`ultirzr ${path} → HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

// ─── Helpers ───────────────────────────────────────────────────────────

/** USAU sheet slot from ultirzr's GameName ("G2" → 2). */
function parseGameSlot(name: string | undefined): number | null {
  const m = (name ?? '').trim().match(/^G\s*(\d+)$/i);
  const n = m ? parseInt(m[1], 10) : null;
  // smallint column: out-of-range would throw and abort the event's ingest.
  return n != null && n >= 0 && n <= 32767 ? n : null;
}

/** Sortable venue wall-clock instant for an ultirzr game; null when it has no
 *  real date/time (unscheduled games carry 01/01/0001). */
function gameClock(gm: UltirzrGame): number | null {
  const md = (gm.StartDate ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const mt = (gm.StartTime ?? '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!md || !mt || parseInt(md[3], 10) < 2000) return null;
  const h = (parseInt(mt[1], 10) % 12) + (mt[3].toUpperCase() === 'PM' ? 12 : 0);
  return Date.UTC(parseInt(md[3], 10), parseInt(md[1], 10) - 1, parseInt(md[2], 10), h, parseInt(mt[2], 10));
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function gameWinner(gm: UltirzrGame): number | null {
  const a = parseScore(gm.HomeTeamScore);
  const b = parseScore(gm.AwayTeamScore);
  if (a == null || b == null || a === b) return null;
  return (a > b ? gm.HomeTeamId : gm.AwayTeamId) ?? null;
}

/** +1 when stages read final-first, -1 when reversed, 0 when the data can't
 *  tell — by whatever times exist, else by which stage's winners reappear in
 *  which. Only used when some stage has no times at all. */
function stageOrientation(stages: UltirzrStage[]): number {
  let score = 0;
  for (let i = 0; i + 1 < stages.length; i++) {
    const ti = (stages[i].Games ?? []).map(gameClock).filter((t): t is number => t != null);
    const tj = (stages[i + 1].Games ?? []).map(gameClock).filter((t): t is number => t != null);
    if (ti.length && tj.length) score += Math.sign(median(ti) - median(tj));
  }
  if (score !== 0) return Math.sign(score);
  let flow = 0;
  for (let i = 0; i + 1 < stages.length; i++) {
    const teamsOf = (gs: UltirzrGame[]) => new Set(gs.flatMap((g) => [g.HomeTeamId, g.AwayTeamId]).filter((t) => t));
    const inI = teamsOf(stages[i].Games ?? []);
    const inJ = teamsOf(stages[i + 1].Games ?? []);
    flow += (stages[i + 1].Games ?? []).filter((g) => inI.has(gameWinner(g) ?? undefined)).length;
    flow -= (stages[i].Games ?? []).filter((g) => inJ.has(gameWinner(g) ?? undefined)).length;
  }
  return Math.sign(flow);
}

/** Round depth a column title names (0 = decider), or null if unclear.
 *  "Play-in" is not a depth: 2025 Club Nationals' "Pro Flight Play-In / 7th
 *  Place (tie)" is its section's decider. */
function stageLabelRank(name: string | undefined): number | null {
  const t = (name ?? '').toLowerCase();
  if (/play.?in|cross|game.?to.?go|backdoor|consol/.test(t)) return null;
  if (t.includes('semi')) return 1;
  if (/pre.?(quart|quater|qtr)/.test(t)) return 3;
  if (/quart|quater|qtr/.test(t)) return 2;
  if (/final|champ/.test(t)) return 0;
  return null;
}

/** Column index per stage, 0 = the deciding column. ultirzr usually lists
 *  stages final-first, but not always: Philly Invite 2018 lists Finals, then
 *  Pre-Quarters, Quarters, Semis; others are scrambled. Rank by play time
 *  (latest = 0, ties keep list order), then let titles that name a round put
 *  those stages in round order among their own positions — ultirzr's times are
 *  sometimes wrong too (Riverside Classic 2019 lists its Final at 10 AM). Same
 *  rule as usau-scraper/scripts/backfill-bracket-structure.py. */
function stageIndexes(stages: UltirzrStage[]): number[] {
  const n = stages.length;
  const meds = stages.map((st) => {
    const ts = (st.Games ?? []).map(gameClock).filter((t): t is number => t != null);
    return ts.length ? median(ts) : null;
  });
  const idx = Array.from({ length: n }, (_, i) => i);
  const cols = meds.every((m) => m != null)
    ? idx.slice().sort((a, b) => meds[b]! - meds[a]! || a - b)
    : stageOrientation(stages) >= 0 ? idx : idx.slice().reverse();
  const ranks = stages.map((st) => stageLabelRank(st.StageName));
  const named = cols.map((s, k) => (ranks[s] != null ? k : -1)).filter((k) => k >= 0);
  const reordered = named.map((k) => cols[k]).sort((a, b) => ranks[a]! - ranks[b]! || cols.indexOf(a) - cols.indexOf(b));
  named.forEach((k, j) => { cols[k] = reordered[j]; });
  const out = new Array<number>(n);
  cols.forEach((s, k) => { out[s] = k; });
  return out;
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    return [o.message, o.code && `(${o.code})`, o.details && `— ${o.details}`]
      .filter(Boolean)
      .join(' ') || JSON.stringify(err);
  }
  return String(err);
}

/** "Revolver (1)" → { name: "Revolver", seed: 1 }. Mirrors the helper in
 *  _shared/parse.ts for HTML scraping. */
function splitNameAndSeed(raw: string): { name: string; seed: number | null } {
  const trimmed = raw.trim();
  const m = trimmed.match(/^(.+?)\s*\((\d+)\)\s*$/);
  if (m) return { name: m[1].trim(), seed: parseInt(m[2], 10) };
  return { name: trimmed, seed: null };
}

/** ultirzr returns `2025-08-30T00:00:00.000Z` style — we want yyyy-mm-dd. */
function dateOnly(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Their per-game StartDate is "MM/DD/YYYY" plus a separate StartTime, both
 *  in the VENUE'S LOCAL clock (ultirzr mirrors USAU verbatim). Convert to a
 *  true UTC instant via the event's venue timezone — writing the wall clock
 *  with a bare `Z` (the old behavior) stored a wrong instant that clashed
 *  with the HTML pipeline's correct UTC and broke time display + "upcoming"
 *  comparisons. When the zone is unknown, keep date-only (midnight) rather
 *  than a wrong instant; with a known zone, date-only means venue midnight. */
function combineDateTime(date?: string, time?: string, tz?: string | null): string | null {
  if (!date) return null;
  const md = date.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!md) return null;
  const [, mm, dd, yyyy] = md;
  const year = parseInt(yyyy, 10);
  const month = parseInt(mm, 10);
  const day = parseInt(dd, 10);
  const isoDate = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  // "9:00 AM" / "12:30 PM"
  const mt = time ? time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i) : null;
  if (!tz) return `${isoDate}T00:00:00Z`; // zone unknown → date-only
  if (!mt) {
    return localWallTimeToUtcIso(year, month, day, 0, 0, tz) ?? `${isoDate}T00:00:00Z`;
  }
  let h = parseInt(mt[1], 10);
  const min = parseInt(mt[2], 10);
  const ampm = mt[3].toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return localWallTimeToUtcIso(year, month, day, h, min, tz) ?? `${isoDate}T00:00:00Z`;
}

/** Pull the lowercase slug out of UsauUrl. ultirzr returns URLs like
 *  https://play.usaultimate.org/events/{slug}/schedule/men/club-men/  */
function slugFromUsauUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/events\/([^/]+)/);
  return m ? m[1] : null;
}

/** Status string from ultirzr ('Final', 'Scheduled', 'In Progress') →
 *  our usau_game_status enum value. */
function classifyStatus(raw: string | undefined): string {
  const t = (raw ?? '').toLowerCase();
  if (t.includes('final')) return 'final';
  if (t.includes('progress')) return 'in_progress';
  if (t.includes('forfeit')) return 'forfeit';
  if (t.includes('cancel')) return 'cancelled';
  return 'scheduled';
}

/** Heuristic: classify a bracket/stage name into our game_round enum.
 *
 *  USAU (and therefore ultirzr) labels the championship title game
 *  "First Place" inside a "1st Place" bracket — NOT "Final". The scraper's
 *  classifier (sync-event-details) already knows this vocabulary; this one
 *  originally didn't, which left every ultirzr-ingested title game tagged
 *  'other' (no champion banner, no final column in the bracket tree). */
function classifyRound(stageName: string | undefined, bracketName: string | undefined): string {
  const stage = (stageName ?? '').toLowerCase().trim();
  const bracket = (bracketName ?? '').toLowerCase().trim();
  const t = `${bracket} ${stage}`;
  // Pool play. The pool-ingest path passes stage='pool' and bracket='Pool X'
  // (see the Pools loop below); without this, pool games fell through to
  // 'other', which made round-robin events read as "Results pending" on the
  // scores cards (the pool-leader fallback keyed on round='pool'). Check FIRST
  // so a group prefix like "GM Women · Pool A" can't be mis-hit by later rules.
  if (stage === 'pool' || /(^|·\s*)pool\b/.test(bracket)) return 'pool';
  if (/(prequarter|pre-quarter|pre quarter)/.test(t)) return 'prequarter';
  if (/semi/.test(t)) return 'semi';
  if (/quarter/.test(t)) return 'quarter';
  if (/consolation/.test(t)) return 'consolation';
  // Championship title game: a "First Place"/"final" stage inside a
  // championship/1st-place bracket (semis/quarters already returned above).
  // Masters combined events prefix brackets with the group ("GM Women ·
  // 1st Place"), so match by inclusion, not equality.
  const isChampBracket =
    bracket.includes('championship') ||
    bracket.includes('1st place') ||
    bracket.includes('first place') ||
    bracket === '';
  if (
    isChampBracket &&
    (stage.includes('first place') || stage.includes('1st place') || stage.includes('final') || stage === '1st')
  ) {
    return 'final';
  }
  if (/(^|\s)final(s)?($|\s)/.test(t) && !/third|fifth|seventh|placement/.test(t)) {
    return 'final';
  }
  // "2nd Place" … "15th Place" (but NOT "1st Place" — that's the champ
  // bracket; an unmatched stage there stays 'other', e.g. "Round 1").
  if (
    /\b([2-9]|\d{2})(nd|rd|th|st)\s+place\b/.test(t) ||
    /placement/.test(t) ||
    (/^\d+(st|nd|rd|th)$/.test(stage) && stage !== '1st')
  ) {
    return 'placement';
  }
  return 'other';
}

// ─── Core ingest ────────────────────────────────────────────────────────

interface IngestStats {
  events: number;
  teams: number;
  participations: number;
  games: number;
  errors: Array<{ eventId: number; eventName?: string; error: string }>;
}

/**
 * Probe USAU for a synthesized slug, returning the form that actually resolves
 * (or null if none do). Tries our slug first, then the "usa-ultimate-" prefixed
 * variant USAU used for some championship events (2018 college is the known
 * case).
 *
 * MUST be GET, not HEAD. USAU's ASP.NET stack answers HEAD with 500 even for
 * pages that GET returns 200 for — verified against three known-good slugs — so
 * a HEAD probe would reject every valid slug and "correct" it to nothing. We
 * discard the body; the status code is all we need.
 *
 * Failures to reach USAU return null rather than throwing — a network blip must
 * not abort an ingest whose real payload (games, standings) comes from ultirzr.
 */
async function verifyUsauSlug(slug: string): Promise<string | null> {
  const candidates = [slug];
  if (!slug.startsWith('usa-ultimate-')) candidates.push(`usa-ultimate-${slug}`);

  for (const cand of candidates) {
    try {
      const res = await fetch(`https://play.usaultimate.org/events/${cand}/`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
            '(KHTML, like Gecko) Version/17.0 Safari/605.1.15',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15_000),
      });
      // Drain the body so the connection is released promptly.
      await res.text().catch(() => '');
      if (res.status === 200) return cand;
      // 403 = WAF block, not a verdict on the slug. Stop probing and keep ours.
      if (res.status === 403) return null;
    } catch {
      return null;
    }
    // Space out the second probe; USAU rate-limits sustained bursts.
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

async function ingestEvent(
  db: ReturnType<typeof supabase>,
  hit: UltirzrEventSearchHit,
  divisionFilter: string,
  stats: IngestStats,
  dryRun: boolean,
): Promise<void> {
  // Fetch the full event tree.
  const full = await fetchUltirzr<{ success: boolean; event: UltirzrEventFull }>(
    `/events/${hit.EventId}`,
  );
  const e = full.event;
  if (!e) {
    stats.errors.push({ eventId: hit.EventId, eventName: hit.EventName, error: 'no event payload' });
    return;
  }

  // Resolve our division label to ultirzr's EventGroupName. The /search
  // endpoint filters by division but a single event can have multiple
  // groups (e.g. Pro Champs has Club-Men + Club-Mixed + Club-Women on the
  // same EventId). We only ingest the group the caller asked for.
  // ultirzr group names sometimes have inconsistent whitespace and casing
  // year to year (e.g. 2024 has 'Club - Men ' with a trailing space, 2025
  // has 'Club - Men'). Normalize both sides before comparing.
  //
  // Masters mode ingests EVERY masters-family group instead (one masters
  // event hosts up to 7 age×gender groups) — see header.
  const isMasters = divisionFilter === 'masters';
  const wantedGroupName = divisionLabel(divisionFilter);
  const wantedNorm = wantedGroupName ? normGroupKey(wantedGroupName) : undefined;
  const groups = (e.EventGroups ?? []).filter((g) => {
    if (isMasters) return mastersGroupMeta(g) !== null;
    if (!wantedNorm) return true;
    const n = normGroupName(g);
    // 2021 College Championships labels its groups with a sub-division
    // ("College - Men D-I Men"); an exact match skipped the whole event.
    return n === wantedNorm || (n.startsWith(`${wantedNorm} `) && /^d-i{1,3}\b/.test(n.slice(wantedNorm.length + 1)));
  });
  if (groups.length === 0) {
    // Event doesn't have this division — common (e.g. an HS-only event
    // shows up in our search results because of how ultirzr handles
    // division filtering on lookalike names, or a "Masters Minus" club
    // tournament matching the masters name search). Quiet skip.
    return;
  }

  // Find a slug (from any group's UsauUrl). Lowercase by convention.
  let slug: string | null = null;
  for (const g of groups) {
    const s = slugFromUsauUrl(g.UsauUrl);
    if (s) {
      slug = s.toLowerCase();
      break;
    }
  }
  let slugWasSynthesized = false;
  if (!slug) {
    // Fall back to a synthesized slug from the event name. Not ideal but
    // some events don't expose a UsauUrl (masters groups, cancelled events).
    // Strip apostrophes BEFORE hyphenating so "Women's" → "womens" like
    // USAU's own slugs, not "women-s" (which would miss the slug match
    // against rows discover-events created and duplicate the event).
    slug = e.EventName.toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    slugWasSynthesized = true;
  }

  const start = dateOnly(e.StartDate);
  const season = start
    ? parseInt(start.slice(0, 4), 10)
    : (hit.StartDate ? parseInt(dateOnly(hit.StartDate)?.slice(0, 4) ?? '0', 10) : 0);

  if (!season) {
    stats.errors.push({ eventId: hit.EventId, eventName: hit.EventName, error: 'no season' });
    return;
  }

  // Year-aware slug. USAU reused a YEAR-LESS slug for several consecutive
  // seasons — e.g. "usa-ultimate-national-championships" covered 2014 through
  // 2018 — and usau_slug is UNIQUE, so without the year all those seasons
  // collapse into a single event row (this merged 5 Nationals + 740 games into
  // one). Appending the season when the slug doesn't already carry a 4-digit
  // year keeps each season its own event. Modern slugs already include the year
  // (e.g. "2025-usa-ultimate-club-nationals"), so they're untouched.
  if (!/\b(19|20)\d{2}\b/.test(slug)) {
    slug = `${slug}-${season}`;
  }

  // VERIFY a synthesized slug against USAU, because a wrong one fails SILENTLY.
  // The slug is what resolve-event-team-urls and sync-event-rosters fetch; if it
  // 404s they return {ok:true, resolved:0} with no error naming the slug, so a
  // whole season's roster run can walk every event and store nothing.
  //
  // 2018 is the case that exposed it — USAU prefixed the championships:
  //   d-i-college-championships-2018              -> 404 (our synthesis)
  //   usa-ultimate-d-i-college-championships-2018 -> 200 (USAU's real slug)
  // 2019's identical synthesis happened to match, which is why it went unnoticed.
  //
  // Only runs when the slug was SYNTHESIZED (no UsauUrl from ultirzr) — a slug
  // parsed from UsauUrl is authoritative. Each probe pays the shared 5s throttle,
  // so gating on the fallback keeps a page-walk from doubling in wall-clock.
  if (slugWasSynthesized && !dryRun) {
    const verified = await verifyUsauSlug(slug);
    if (verified && verified !== slug) {
      console.log(`[ingest] slug corrected: ${slug} -> ${verified}`);
      slug = verified;
    } else if (!verified) {
      // Neither form resolves — keep ours so the event still ingests (games and
      // standings come from ultirzr, not USAU). Rosters for it will no-op until
      // the slug is corrected, so surface it rather than failing the event.
      stats.errors.push({
        eventId: hit.EventId,
        eventName: e.EventName,
        error: `usau_slug "${slug}" does not resolve on USAU — rosters for this event will find no teams`,
      });
    }
  }

  // Year-aware NAME, same reasoning as the slug. ultirzr reuses a year-less
  // event NAME across seasons ("USA Ultimate National Championships" for
  // 2014-2018). Downstream code keys off the year IN the name — the team-medal
  // derivation's guard requires `event.name.includes(year)` to trust a game's
  // season, and the UI shows the name verbatim. Overwriting a year-bearing DB
  // name with the year-less ultirzr one silently breaks both (this dropped
  // Revolver's 2015 title). Append the season when the name lacks any 4-digit
  // year; modern names already carry it and are untouched.
  const eventName = /\b(19|20)\d{2}\b/.test(e.EventName)
    ? e.EventName
    : `${e.EventName.trim()} ${season}`;

  if (dryRun) {
    stats.events++;
    return;
  }

  // ── Upsert season (FK target) ──
  await db.from('usau_seasons').upsert({ year: season }, { onConflict: 'year', ignoreDuplicates: true });

  // ── Upsert event ──
  // Match preference: by numeric usau_event_id first (most stable), then by
  // lowercased slug (handles legacy rows from HTML scrape), then — masters
  // only — by (season, name): discover-events created the 2026 masters
  // shells with REAL USAU slugs that a synthesized slug may not hit.
  //
  // Event-level competition_level is single-valued but a combined masters
  // event hosts Masters + Grand Masters + Great Grand Masters groups. We
  // classify by the "youngest" group present (Masters > Grand Masters > Great
  // Grand Masters) so a GGM-only event tags GREAT_GRAND_MASTERS while combined
  // events keep MASTERS. The per-division truth lives on the TEAMS (tagged from
  // their group below), so this coarse event tag only steers the URL path.
  const mastersLevels = new Set(
    groups.map((g) => mastersGroupMeta(g)?.level).filter(Boolean),
  );
  const eventLevel = isMasters
    ? mastersLevels.has('MASTERS')
      ? 'MASTERS'
      : mastersLevels.has('GRAND_MASTERS')
        ? 'GRAND_MASTERS'
        : 'GREAT_GRAND_MASTERS'
    : levelFromGroup(wantedGroupName, eventName);

  const eventRow = {
    usau_slug: slug,
    usau_event_id: hit.EventId,
    name: eventName,
    season,
    start_date: start,
    end_date: dateOnly(e.EndDate),
    city: e.City ?? null,
    state: e.State ?? null,
    url: `https://play.usaultimate.org/events/${slug}/`,
    last_scraped_at: new Date().toISOString(),
    last_scraped_status: 'ok',
    competition_level: eventLevel,
  };

  // On UPDATE of an existing masters row, keep its slug (discover-events
  // stored the real USAU slug — better than our synthesized one) and its
  // level (already classified). Club updates keep full-overwrite behavior.
  const updatePayload = isMasters
    ? (({ usau_slug: _s, competition_level: _l, ...rest }) => rest)(eventRow)
    : eventRow;

  const { data: existingById } = await db
    .from('usau_events')
    .select('id')
    .eq('usau_event_id', hit.EventId)
    .maybeSingle();
  let eventUuid: string | null = null;
  if (existingById) {
    eventUuid = existingById.id;
  } else {
    const { data: existingBySlug } = await db
      .from('usau_events')
      .select('id')
      .ilike('usau_slug', slug)
      .maybeSingle();
    if (existingBySlug) {
      eventUuid = existingBySlug.id;
    } else if (isMasters) {
      const { data: existingByName } = await db
        .from('usau_events')
        .select('id')
        .eq('season', season)
        .ilike('name', e.EventName.trim())
        .limit(1);
      if (existingByName && existingByName.length > 0) eventUuid = existingByName[0].id;
    }
  }

  if (eventUuid) {
    const { error } = await db.from('usau_events').update(updatePayload).eq('id', eventUuid);
    if (error) throw new Error(`update event ${hit.EventId}: ${stringifyErr(error)}`);
  } else {
    const { data: inserted, error } = await db
      .from('usau_events')
      .insert(eventRow)
      .select('id')
      .single();
    if (error) throw new Error(`insert event ${hit.EventId}: ${stringifyErr(error)}`);
    eventUuid = inserted.id;
  }
  stats.events++;

  // ── Walk every game in the wanted groups, collect teams + games ──
  // In masters mode each group carries its own level+gender (a combined
  // championships hosts up to 7 groups), so teams remember the group they
  // were seen in and bracket names get a group prefix ("GM Women · Pool A")
  // to keep the divisions distinguishable on the event page.
  type GameWithCtx = {
    game: UltirzrGame;
    bracket: string | null;
    stage: string | null;
    /** Column of the stage within its bracket, 0 = the deciding column
     *  (stageIndexes — ultirzr's list order isn't reliably final-first). */
    stageIndex: number | null;
  };
  const teamSeen = new Map<number, TeamSeenInfo>();
  const gameList: GameWithCtx[] = [];

  for (const g of groups) {
    const meta = isMasters ? mastersGroupMeta(g) : null;
    const prefix = meta ? `${meta.label} · ` : '';
    for (const r of g.EventRounds ?? []) {
      // Pool play
      for (const p of r.Pools ?? []) {
        for (const gm of p.Games ?? []) {
          collectTeam(gm.HomeTeamId, gm.HomeTeamName, teamSeen, meta);
          collectTeam(gm.AwayTeamId, gm.AwayTeamName, teamSeen, meta);
          gameList.push({ game: gm, bracket: `${prefix}${p.Name ?? 'Pool'}`, stage: 'pool', stageIndex: null });
        }
      }
      // Bracket play
      for (const b of r.Brackets ?? []) {
        const indexes = stageIndexes(b.Stage ?? []);
        (b.Stage ?? []).forEach((st, i) => {
          const stageIndex = indexes[i];
          for (const gm of st.Games ?? []) {
            collectTeam(gm.HomeTeamId, gm.HomeTeamName, teamSeen, meta);
            collectTeam(gm.AwayTeamId, gm.AwayTeamName, teamSeen, meta);
            gameList.push({
              game: gm,
              bracket: b.BracketName ? `${prefix}${b.BracketName}` : (prefix ? prefix.replace(/ · $/, '') : null),
              stage: st.StageName ?? null,
              stageIndex,
            });
          }
        });
      }
    }
  }

  // ── Upsert teams (one row per usau_team_id) ──
  const teamUuidById = new Map<number, string>();
  for (const [tid, info] of teamSeen.entries()) {
    const teamIdStr = String(tid);
    const { data: existing } = await db
      .from('usau_teams')
      .select('id, name')
      .eq('usau_team_id', teamIdStr)
      .maybeSingle();
    if (existing) {
      teamUuidById.set(tid, existing.id);
      // Keep the canonical name fresh; only overwrite if our stored value
      // is shorter (avoids losing a longer official name to a casual one).
      if (info.name && info.name.length > (existing.name?.length ?? 0)) {
        await db.from('usau_teams').update({ name: info.name }).eq('id', existing.id);
      }
    } else {
      const { data: created, error } = await db
        .from('usau_teams')
        .insert({
          usau_team_id: teamIdStr,
          name: info.name,
          // Masters teams carry the level+gender of the GROUP they were seen
          // in (MASTERS vs GRAND_MASTERS), not the event's single level.
          //
          // For every other division fall back to the level implied by the
          // GROUP we filtered on — NOT a hardcoded 'CLUB'. The old 'CLUB'
          // default silently mislabeled any non-club, non-masters ingest: a
          // college run would have written College teams as CLUB, and
          // `levelFromGroup` is what splits COLLEGE_D1 vs COLLEGE_D3.
          competition_level: info.meta?.level ?? levelFromGroup(wantedGroupName, eventName),
          gender_division: info.meta?.gender ?? genderFromGroup(wantedGroupName),
          last_scraped_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (error) throw new Error(`insert team ${tid}: ${stringifyErr(error)}`);
      teamUuidById.set(tid, created.id);
      stats.teams++;
    }
  }

  // ── Upsert event-team participations (seed from team-name parens) ──
  for (const [tid, info] of teamSeen.entries()) {
    const teamUuid = teamUuidById.get(tid);
    if (!teamUuid) continue;
    // PostgREST won't accept ON CONFLICT on a composite PK that isn't
    // backed by a unique constraint visible in the schema cache. Use
    // select-then-insert/update. Cheap: per-event row count is small.
    const { data: existing } = await db
      .from('usau_event_teams')
      .select('team_id')
      .eq('event_id', eventUuid)
      .eq('team_id', teamUuid)
      .maybeSingle();
    const row = {
      event_id: eventUuid,
      team_id: teamUuid,
      usau_event_team_id: String(tid), // we don't have a per-event id from ultirzr; reuse team id
      seed: info.seed,
    };
    if (existing) {
      const { error } = await db
        .from('usau_event_teams')
        .update({ seed: row.seed })
        .eq('event_id', eventUuid)
        .eq('team_id', teamUuid);
      if (error) throw new Error(`update event_team ${eventUuid}/${tid}: ${stringifyErr(error)}`);
    } else {
      const { error } = await db.from('usau_event_teams').insert(row);
      if (error) throw new Error(`insert event_team ${eventUuid}/${tid}: ${stringifyErr(error)}`);
    }
    stats.participations++;
  }

  // ── Upsert games (keyed on usau_event_game_id) ──
  // Filter out placeholder games where both team IDs are 0 (pre-draw
  // schedule stubs) and games with no real score updates pending — we
  // still want to record scheduled-not-played games so the bracket
  // renders, but we skip the ones with no resolved teams.
  // Venue timezone for converting ultirzr's local schedule clocks → UTC.
  const venueTz = tzForState(e.State ?? hit.State ?? null);
  for (const { game: gm, bracket, stage, stageIndex } of gameList) {
    if (!gm.EventGameId) continue;
    const homeId = gm.HomeTeamId ?? 0;
    const awayId = gm.AwayTeamId ?? 0;
    if (homeId === 0 && awayId === 0) continue;

    const teamA = homeId ? teamUuidById.get(homeId) ?? null : null;
    const teamB = awayId ? teamUuidById.get(awayId) ?? null : null;

    const homeSplit = gm.HomeTeamName ? splitNameAndSeed(gm.HomeTeamName) : { seed: null };
    const awaySplit = gm.AwayTeamName ? splitNameAndSeed(gm.AwayTeamName) : { seed: null };

    const scoreA = parseScore(gm.HomeTeamScore);
    const scoreB = parseScore(gm.AwayTeamScore);
    const ff = forfeitWinner(gm.HomeTeamScore, gm.AwayTeamScore);

    const row = {
      event_id: eventUuid,
      usau_event_game_id: String(gm.EventGameId),
      round: classifyRound(stage ?? undefined, bracket ?? undefined),
      bracket_name: bracket,
      team_a_id: teamA,
      team_b_id: teamB,
      seed_a: homeSplit.seed,
      seed_b: awaySplit.seed,
      score_a: scoreA,
      score_b: scoreB,
      winner_team_id: ff === 'home' ? teamA : ff === 'away' ? teamB : null,
      location: gm.FieldName?.trim() || null,
      scheduled_at: combineDateTime(gm.StartDate, gm.StartTime, venueTz),
      status: classifyStatus(gm.GameStatus),
      source_url: `https://play.usaultimate.org/events/${slug}/`,
      // Bracket structure (see migration 20260913170000). ultirzr carries the
      // column label + order and the sheet slot ("G2"), but no feeder link.
      bracket_stage: stageIndex == null ? null : stage,
      bracket_stage_index: stageIndex != null && stageIndex <= 32767 ? stageIndex : null,
      bracket_slot: stageIndex == null ? null : parseGameSlot(gm.GameName),
      next_usau_game_id: null,
      next_slot_side: null,
    };

    const { error } = await db
      .from('usau_games')
      .upsert(row, { onConflict: 'usau_event_game_id', ignoreDuplicates: false });
    if (error) throw new Error(`upsert game ${gm.EventGameId}: ${stringifyErr(error)}`);
    stats.games++;
  }

  // Derive the event's venue from the FieldName values we just wrote (majority
  // vote, trailing field designator stripped). Write-path only — the read path
  // serves the stored usau_events.venue column.
  await db.rpc('usau_derive_event_venue', { target_event_id: eventUuid });

  // Final placements from the bracket results, once every bracket game is
  // played (skipped until then). Write-path only.
  await refreshEventPlacements(db, eventUuid!);
}

interface TeamSeenInfo {
  name: string;
  seed: number | null;
  /** Masters mode: the group this team plays in (level + gender). */
  meta: MastersGroupMeta | null;
}

function collectTeam(
  id: number | undefined,
  name: string | undefined,
  out: Map<number, TeamSeenInfo>,
  meta: MastersGroupMeta | null,
): void {
  if (!id || id === 0) return;
  const split = name ? splitNameAndSeed(name) : { name: '', seed: null };
  const existing = out.get(id);
  // Track the deepest-seed we've seen for this team in this event (some
  // events list a team with their pool seed AND their bracket seed —
  // the latter is what we want).
  out.set(id, {
    name: split.name || existing?.name || '',
    seed: split.seed ?? existing?.seed ?? null,
    meta: existing?.meta ?? meta,
  });
}

function parseScore(v: string | number | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const m = v.trim().match(/^(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

/** Forfeits arrive as letters in the score fields ("W"/"F"). Mirrors
 *  sync-event-details' forfeitWinner so both pipelines set winner_team_id. */
function forfeitWinner(home: string | number | undefined, away: string | number | undefined): 'home' | 'away' | null {
  const h = String(home ?? '').trim().toUpperCase();
  const a = String(away ?? '').trim().toUpperCase();
  if (h === 'W' && a === 'F') return 'home';
  if (h === 'F' && a === 'W') return 'away';
  return null;
}

function divisionLabel(div: string): string | null {
  switch (div) {
    case 'mens-club': return 'Club - Men';
    case 'womens-club': return 'Club - Women';
    case 'mixed-club': return 'Club - Mixed';
    // College. ultirzr's `division=*-college` SEARCH filter is unreliable —
    // a 2022 mens-college query returns High School, League and Club groups
    // mixed in (same class of upstream bug as the 2015 club divisions). These
    // labels are what actually protects us: the per-group filter below keeps
    // ONLY the matching EventGroupName, so the junk hits are quietly skipped.
    // Without a label, `wantedNorm` is undefined and the filter passes
    // EVERYTHING through — which would ingest HS/Club groups as college.
    case 'mens-college': return 'College - Men';
    case 'womens-college': return 'College - Women';
    case 'mixed-college': return 'College - Mixed';
    default: return null;
  }
}

// ─── Masters helpers ────────────────────────────────────────────────────

interface MastersGroupMeta {
  /** Our enum value. Great Grand Masters is its own level (was folded into
   *  GRAND_MASTERS pre-2026-07; now distinct — see [[USAU Masters Ingestion Plan]]). */
  level: 'MASTERS' | 'GRAND_MASTERS' | 'GREAT_GRAND_MASTERS';
  gender: 'Men' | 'Women' | 'Mixed';
  /** Short display prefix for bracket names, e.g. "GM Women". */
  label: string;
}

/** Normalize an EventGroupName for matching. ultirzr's group names drift
 *  year to year: inconsistent whitespace / trailing spaces (all years) AND a
 *  possessive form in older seasons — 2015 uses "Club - Men's " / "Club - Women's "
 *  where 2016+ use "Club - Men" / "Club - Women". Strip a trailing possessive
 *  's so both forms collapse to the same key (this un-broke the 2015 Club
 *  Nationals men's/women's ingest). "Mixed" has no possessive, so it's safe. */
function normGroupName(g: UltirzrGroup): string {
  return normGroupKey(g.EventGroupName ?? '');
}

/** Shared normalizer so the wanted label and the group name normalize the
 *  same way (whitespace collapse + trailing-possessive strip). */
function normGroupKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/'s$/, ''); // "club - men's" → "club - men"
}

/** 'Great Grand Masters - Men ' → { GRAND_MASTERS, Men, 'GGM Men' };
 *  null for anything outside the masters family. */
function mastersGroupMeta(g: UltirzrGroup): MastersGroupMeta | null {
  const m = normGroupName(g).match(
    /^(great grand masters|grand masters|masters) - (men|women|mixed)$/,
  );
  if (!m) return null;
  const gender = (m[2][0].toUpperCase() + m[2].slice(1)) as MastersGroupMeta['gender'];
  const prefix =
    m[1] === 'great grand masters' ? 'GGM' : m[1] === 'grand masters' ? 'GM' : 'Masters';
  return {
    level:
      m[1] === 'masters'
        ? 'MASTERS'
        : m[1] === 'great grand masters'
          ? 'GREAT_GRAND_MASTERS'
          : 'GRAND_MASTERS',
    gender,
    label: `${prefix} ${gender}`,
  };
}

function genderFromGroup(group: string | null): 'Men' | 'Women' | 'Mixed' | null {
  if (!group) return null;
  if (group.includes('Mixed')) return 'Mixed';
  if (group.includes('Women')) return 'Women';
  if (group.includes('Men')) return 'Men';
  return null;
}

/** True when a string names the College Division III series.
 *  Matches "D-III", "D3" (as a whole word, so "D30" doesn't hit) and the spelled
 *  out "Division III". */
function mentionsD3(s: string | null | undefined): boolean {
  if (!s) return false;
  return /d-iii|division\s+iii|\bd3\b/i.test(s);
}

/**
 * Map an ultirzr EventGroupName to our competition_level.
 *
 * `eventName` is a SECONDARY signal for the D-I/D-III split and is required for
 * older seasons: ultirzr's 2021 group names are only ever "College - Men" /
 * "College - Women" (occasionally "College - Men D-I Men") and NEVER say D-III,
 * even for events plainly titled "Ohio Valley D-III College Men's Regionals".
 * Classifying on the group alone put all 42 of 2021's D-III events into
 * COLLEGE_D1. The event title does carry it, so we fall back to that.
 *
 * Group wins when it's explicit — it's the more precise source for 2023+, where
 * the group name itself distinguishes the divisions.
 */
function levelFromGroup(group: string | null, eventName?: string | null): string {
  if (!group) return 'OTHER';
  if (group.startsWith('Club')) return 'CLUB';
  if (group.startsWith('College')) {
    return mentionsD3(group) || mentionsD3(eventName) ? 'COLLEGE_D3' : 'COLLEGE_D1';
  }
  if (group.includes('Masters')) return 'MASTERS';
  if (group.includes('High School')) return 'HS';
  return 'OTHER';
}

// ─── Entry point ────────────────────────────────────────────────────────

async function run(body: RequestBody) {
  if (!body.year || !Number.isFinite(body.year)) throw new Error('year is required');
  const division = body.division ?? 'mens-club';
  const startPage = Math.max(1, body.page ?? 1);
  const maxPages = body.maxPages ?? 1;
  const endPage = startPage + maxPages - 1;
  const dryRun = !!body.dryRun;

  const db = supabase();
  const stats: IngestStats = { events: 0, teams: 0, participations: 0, games: 0, errors: [] };
  let nextPage: number | null = null;
  let lastPageWalked: number = startPage - 1;

  for (let page = startPage; page <= endPage; page++) {
    // Masters events aren't reachable via ultirzr's division filter — search
    // by name substring instead (see header). Non-masters keeps division.
    // An explicit `query` override wins (used to reach events whose division
    // search is broken upstream — e.g. 2015 club); masters always searches by
    // name; otherwise filter by division as usual.
    const searchQs = body.query
      ? `year=${body.year}&query=${encodeURIComponent(body.query)}&page=${page}`
      : division === 'masters'
      ? `year=${body.year}&query=masters&page=${page}`
      : `year=${body.year}&division=${encodeURIComponent(division)}&page=${page}`;
    const resp = await fetchUltirzr<{ success: boolean; hits: UltirzrEventSearchHit[] }>(
      `/events/search?${searchQs}`,
    );
    const hits = resp.hits ?? [];
    lastPageWalked = page;
    if (hits.length === 0) break;

    for (const hit of hits) {
      // Targeted backfill guard: when `onlyEventId` is set, ingest ONLY that
      // ultirzr EventId and skip every other search hit. Used to load a single
      // known event (e.g. 2015 Club Nationals #2094) without also pulling the
      // other events the fuzzy name search returns (US Open, Pan-Ams).
      if (body.onlyEventId != null && hit.EventId !== body.onlyEventId) continue;
      try {
        await ingestEvent(db, hit, division, stats, dryRun);
      } catch (err) {
        stats.errors.push({
          eventId: hit.EventId,
          eventName: hit.EventName,
          error: stringifyErr(err),
        });
      }
    }

    // If we got a full page, there might be more. Signal nextPage so the
    // caller can drive a loop without us having to fit it all in one
    // Edge Function invocation.
    if (hits.length === 20 && page === endPage) {
      nextPage = page + 1;
    }
  }

  return {
    rowsProcessed: stats.events + stats.teams + stats.participations + stats.games,
    result: {
      year: body.year,
      division,
      startPage,
      lastPageWalked,
      nextPage,
      ...stats,
    },
  };
}

Deno.serve(async (req) => {
  let body: RequestBody = {};
  try {
    if (req.headers.get('content-type')?.includes('application/json')) {
      body = await req.json();
    } else {
      const url = new URL(req.url);
      if (url.searchParams.get('year')) body.year = parseInt(url.searchParams.get('year')!, 10);
      if (url.searchParams.get('division')) body.division = url.searchParams.get('division')!;
      if (url.searchParams.get('dryRun') === 'true') body.dryRun = true;
    }
  } catch {
    // empty body OK
  }

  try {
    const res = await withRunLogging(
      'ingest-from-ultirzr',
      body as Record<string, unknown>,
      () => run(body),
    );
    return Response.json({ ok: true, ...res });
  } catch (err) {
    const message = stringifyErr(err);
    console.error('[ingest-from-ultirzr] failed:', message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});
