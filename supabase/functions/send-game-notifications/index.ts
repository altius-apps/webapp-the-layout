// send-game-notifications: the push sender the mobile app's notification_prefs
// contract has been waiting on. Runs on pg_cron every 5 minutes; finds games
// (and, since 2026-08-28, event milestones + player stats) that are ready to
// notify, computes the audience per Hunter's targeting rules, and delivers via
// Expo's push API to push_tokens.
//
// TARGETING — games (Hunter, 2026-09-07; same rule for UFA, USAU and WFDF):
//   A league favorite means EVERY game in that league; a team favorite NARROWS
//   it to that team's games. Audience per game = union of
//     (a) users with the league in user_favorite_leagues who have NO
//         user_favorite_teams row in that league ("league-only" users);
//     (b) users following the home/away (team_a/team_b) team in
//         user_favorite_teams for that league;
//     (c) users who starred the game (user_favorite_games — UFA today; the
//         leg is league-generic so PUL/WUL slot in when they get a branch).
//   Deduped per user. A league+team user gets only their team's games, even
//   in UFA playoffs / USAU Nationals; a league-only user gets every game the
//   sender sees for that league — EXCEPT USAU, where the league-only leg is
//   bounded to FLIGHTED events (template_key IS NOT NULL), mirroring event_*.
//   This REPLACED the earlier playoffs-only (UFA), Nationals-only (USAU) and
//   team-followers-only (WFDF) league legs. Spam guard for the league-only
//   leg is the per-user game_final digest cap below.
//   game_start/game_final are exempt from quiet hours (see QUIET HOURS).
//   Always intersected with notification_prefs: push_enabled AND the category
//   toggle (game_start / game_final). A MISSING prefs row means all-defaults
//   (everything on) — that contract lives in the mobile app's
//   src/lib/push/prefs.ts and must stay in sync.
//
// TARGETING — event milestones (event_start / event_bracket / event_final,
// 2026-08-28, vault Features/Push Notifications.md "PLAN" + "DECISIONS"):
//   Audience = UNION of (a) league favorites — USAU restricted to FLIGHTED
//   events (template_key IS NOT NULL); WFDF has no flighted concept, every
//   WFDF league-favorite gets every WFDF event milestone; (b) followers of a
//   team ENTERED in the event (usau_event_teams for USAU, teams appearing in
//   the event's games for WFDF); (c) user_favorite_events rows for
//   (league, event_id) — the "starred tournament" favorite, which notifies
//   regardless of flightedness. Deduped per user. Gated by push_enabled AND
//   event_updates.
//   A starred or team-entered USAU event notifies its own users even when
//   unflighted — the flighted restriction only narrows the LEAGUE-favorite
//   leg of the union.
//   USAU series groups (usau_events.series_group_key): every leg unions across
//   ALL members of the group — a star or entered team on any division reaches
//   every group notice, and the league leg applies when ANY member is flighted.
//
// TARGETING — player_stats (2026-08-28):
//   USAU: user_favorite_players rows exactly matching
//   usau_player_event_stats.player_id (uuid) — exact id, never name-fuzzy,
//   per the plan's USAU identity-sprawl note.
//   WFDF: favorites store the player's FULL NAME, which is this app's
//   canonical WFDF identity (by-name resolver routes, unified profiles).
//   wfdf_player_id is a PER-EVENT roster id — 4,364 of 18,499 distinct
//   roster names carry multiple ids across events — so an id-keyed favorite
//   would match one event and go silent at the next Worlds. The sender
//   therefore resolves the favorited NAME to the scored event's
//   wfdf_player_id set via wfdf_rosters (exact string equality, scoped to
//   that event) and matches stats through it. Still exact matching, just on
//   WFDF's actual id system. Dedup stays on the per-event roster id so two
//   same-named humans in one event remain distinct.
//
// DEDUP: game_notifications (league, game_id, category) is claimed with an
// insert-ignore BEFORE sending, so a notice fires at most once per category,
// ever — a crash after the claim loses that one send rather than duplicating
// it on the next cron tick. Event-level rows store the EVENT id in game_id.
// Player-stat rows store "<gameOrEventId>:<playerId>" in game_id so each
// player notifies once per game (WFDF) / event (USAU).
// USAU series groups (one usau_events row per division of one tournament):
// event_start / event_bracket claim "grp:<series_group_key>:<YYYY-MM-DD>" —
// one notice per group per day (dated because some groups play divisions on
// different weekends); event_final stays one per member row (bare event id).
// A single row hosting several divisions (Club Nationals, Pro Champs) claims
// event_final as "<eventId>:<winner division>" so every division's champion
// goes out.
//
// WINDOWS: game "starting soon" = start time within [now-10m, now+15m] and
// still pre-game status. game "final" = status Final/final/completed with a
// start time within [now-3h, now] — bounded below so the first deploy (and
// any sync backfill) can't spam pushes for long-finished games, and ABOVE
// because bad data exists: legacy USAU events carry status=final with
// placeholder dates months in the future. USAU rows whose scheduled_at is
// exactly midnight UTC are date-only placeholders (no real start time) and
// are skipped for both categories; the same skip extends to USAU event_start
// (start_date-only events have no real timing to hold against quiet hours).
// Event-level detection windows are similarly bounded (see each candidate
// function) so the first deploy of this code can't fire on old history.
//
// QUIET HOURS (Hunter, 2026-08-28, decision #3 "option 1"): event-level
// categories (event_start / event_bracket / event_final) only SEND when the
// venue-local wall clock is within QUIET_HOURS_START..QUIET_HOURS_END. A
// notice outside the window is NOT claimed — left unclaimed so a later cron
// tick inside the window claims and sends it once. game_start/game_final for
// a favorited TEAM are exempt (send immediately, unchanged).
//
// PER-USER DIGEST CAP: within one run, a user due more than one game_final
// for the SAME (league, event — a USAU series group counts as one event) gets
// ONE combined push instead of several —
// mitigates USAU's batched-scraper bursts (a round of finals can land at
// once). Claims stay per-game (each game_final is still claimed and counted
// individually); only the Expo DELIVERY merges. See assembleFinalDeliveries.
//
// Auth: verify_jwt off, but the request must carry the service-role key as
// the Bearer token (pg_cron injects it from Vault) — anything else is 401.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH = 100;

const START_LEAD_MS = 15 * 60_000; // notify up to 15 min before start
const START_GRACE_MS = 10 * 60_000; // still notify if the cron ran late
const FINAL_WINDOW_MS = 3 * 3600_000;

// Event-milestone windows: bounded like the game windows above so the first
// deploy of this code doesn't walk the whole DB and fire on history.
const EVENT_START_WINDOW_MS = 24 * 3600_000; // event's start_date is "today" (venue-local, see below)
const EVENT_BRACKET_LOOKBACK_MS = 3 * 3600_000; // first bracket game entering the game_start window
const EVENT_FINAL_LOOKBACK_MS = 3 * 3600_000; // championship/last game going final
const PLAYER_STATS_LOOKBACK_MS = 3 * 3600_000; // stats rows landing (created_at/scraped_at)
// scraped_at is when WE scraped, not when the event was played — a historical
// backfill stamps years-old stats "now". Only events that ended this recently
// may push (a 2017 event's stats pushed on 2026-09-03 before this guard).
const PLAYER_STATS_EVENT_RECENCY_DAYS = 3;

// Quiet hours for event-level categories, venue-local wall clock.
const QUIET_HOURS_START = 8; // 08:00
const QUIET_HOURS_END = 21; // 21:00

// UFA playoff cut: weeks are 'week-N'; any non-numeric label (semifinals,
// championship — pre-2024 seasons) is playoffs, and for label-less seasons the
// bracket lives past the regular season's last week. 2026: 14 regular-season
// weeks, playoffs are week-15 (division finals) and week-16 (Championship
// Weekend + All-Star game). Extend this map when a season's structure changes.
const UFA_PLAYOFF_START_WEEK: Record<number, number> = { 2026: 15 };
const UFA_PLAYOFF_START_DEFAULT = 15;

// ─── MIRROR — keep in lockstep ──────────────────────────────────────────────
// Deno edge functions can't import from src/, so the bracket/pool/placement
// heuristics from src/components/usau/usau-bracket-tree.tsx and
// src/components/usau/usau-event-detail.tsx are re-implemented minimally
// below. Any change to isChampionshipBracket / isPlacementName /
// isCrossoverBracket in those files needs a matching edit here.

/** Tail after the last "·" — combined masters events prefix every bracket
 *  name with its group ("GM Women · 1st Place"). MIRROR of bracketTail. */
function bracketTail(name: string | null | undefined): string {
  if (!name) return '';
  const i = name.lastIndexOf('·');
  return i >= 0 ? name.slice(i + 1).trim() : name.trim();
}

/** MIRROR of isPlacementName (usau-event-detail.tsx) — "9th Place",
 *  "Placement", "21st (3 games each)". */
function isPlacementName(name: string | null | undefined): boolean {
  const t = bracketTail(name).toLowerCase();
  if (!t) return false;
  return (
    /placement/.test(t) ||
    /\b\d+(st|nd|rd|th)\s+place\b/.test(t) ||
    /^\s*\d+(st|nd|rd|th)\b/.test(t) ||
    // Written-out ordinals: "Second Place" (game-to-go), bare "Third".
    /\b(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth)\s+place\b/.test(t) ||
    /^(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth)$/.test(t.trim()) ||
    // Next-bid games (Hunter, 2026-09-12: they belong with the placements).
    /backdoor|game[- ]to[- ]go|\bg2g\b/.test(t)
  );
}

/** MIRROR of isCrossoverBracket (usau-event-detail.tsx). */
function isCrossoverName(name: string | null | undefined): boolean {
  return bracketTail(name).toLowerCase().includes('crossover');
}

/** MIRROR of isChampionshipBracket (usau-bracket-tree.tsx), narrowed to what
 *  this sender needs: is bracket_name (paired with round='final') the MAIN
 *  championship bracket, not a placement/consolation side bracket? Combined
 *  masters events are intentionally out of scope here — champion-crowned
 *  copy for a "GM Women" sub-bracket needs the group label wired in, which
 *  the plan didn't ask for; those events simply won't get event_final until
 *  someone extends this. */
function isChampionshipBracketName(bracketName: string | null | undefined, round: string): boolean {
  const tail = bracketTail(bracketName).toLowerCase();
  if (!tail) return ['prequarter', 'quarter', 'semi', 'final'].includes(round);
  if (/\b1st place\b/.test(tail) || /\bfirst place\b/.test(tail)) return true;
  if (tail === '1st' || tail === 'champs') return true;
  if (/\b\d+(st|nd|rd|th)\b/.test(tail)) return false; // "5th Place Championship" etc — side bracket
  // Written-out ordinals too: "Second Place" (game-to-go) and "Championship
  // Bracket: Third Place" are placement games, never the title.
  if (/\b(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth)\s+place\b/.test(tail)) return false;
  if (/backdoor|game[- ]to[- ]go|\bg2g\b/.test(tail)) return false;
  if (isCrossoverName(bracketName)) return false;
  return /championship/.test(tail) || tail === 'bracket play' || tail === 'final';
}

/** Bracket-ish round for "bracket play begins" detection: a tree round, or a
 *  bracket_name that reads as bracket play and isn't a pool/crossover. */
function isBracketishRound(round: string, bracketName: string | null | undefined): boolean {
  if (['prequarter', 'quarter', 'semi', 'final'].includes(round)) return true;
  const tail = bracketTail(bracketName).toLowerCase();
  if (!tail) return false;
  if (tail.startsWith('pool') || isCrossoverName(bracketName)) return false;
  return true;
}

// USAU venue TZ — MIRROR of STATE_TO_TZ in src/lib/usau/venue-tz.ts (and its
// own mirror, usau-scraper/supabase/functions/sync-event-details/index.ts).
const USAU_STATE_TO_TZ: Record<string, string> = {
  CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York',
  FL: 'America/New_York', GA: 'America/New_York', IN: 'America/Indiana/Indianapolis',
  ME: 'America/New_York', MD: 'America/New_York', MA: 'America/New_York',
  MI: 'America/Detroit', NH: 'America/New_York', NJ: 'America/New_York',
  NY: 'America/New_York', NC: 'America/New_York', OH: 'America/New_York',
  PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York',
  VT: 'America/New_York', VA: 'America/New_York', WV: 'America/New_York',
  AL: 'America/Chicago', AR: 'America/Chicago', IL: 'America/Chicago',
  IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York',
  LA: 'America/Chicago', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', NE: 'America/Chicago', OK: 'America/Chicago',
  TN: 'America/Chicago', TX: 'America/Chicago', WI: 'America/Chicago',
  AZ: 'America/Phoenix', CO: 'America/Denver', ID: 'America/Boise',
  MT: 'America/Denver', NM: 'America/Denver', UT: 'America/Denver',
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles',
  WA: 'America/Los_Angeles',
  AK: 'America/Anchorage', HI: 'Pacific/Honolulu',
};

function usauVenueTz(state: string | null | undefined): string | null {
  if (!state) return null;
  return USAU_STATE_TO_TZ[state.trim().toUpperCase()] ?? null;
}

/** A USAU event's venue zone: usau_events.venue_tz (the scraper's resolved
 *  zone, set even when USAU lists the venue as TBD) ahead of the state map —
 *  the web's venueTimeZone(event.venueTz ?? event.state) rule. A zone string
 *  this runtime doesn't know falls through to the state instead of throwing
 *  mid-tick for every league. */
function usauEventTz(ev: { venue_tz: string | null; state: string | null }): string | null {
  const tz = ev.venue_tz?.trim();
  if (tz) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return tz;
    } catch {
      // unknown zone — use the state
    }
  }
  return usauVenueTz(ev.state);
}

/** First resolvable venue zone per series group, across ALL its members. The
 *  scraper infers venue_tz row by row from entrants, so one division can stay
 *  null (0-team rows never resolve) while its siblings resolve — left on UTC,
 *  that division would pull its group's notices into the night. */
async function seriesGroupZones(sb: SupabaseClient, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (keys.length === 0) return out;
  const { data, error } = await sb
    .from('usau_events')
    .select('series_group_key, venue_tz, state')
    .in('series_group_key', keys)
    .order('id', { ascending: true });
  if (error) throw error;
  for (const r of data ?? []) {
    const tz = usauEventTz(r);
    if (tz && !out.has(r.series_group_key)) out.set(r.series_group_key, tz);
  }
  return out;
}

/** An event's own venue zone; a series member without one borrows its group's. */
function usauZone(
  ev: { venue_tz: string | null; state: string | null; series_group_key?: string | null },
  groupZones: Map<string, string>,
): string | null {
  return usauEventTz(ev) ?? (ev.series_group_key ? groupZones.get(ev.series_group_key) ?? null : null);
}

/** The UTC dates either side of `now`: every venue's local "today" is one of them. */
function datesAround(now: number): string[] {
  return [-1, 0, 1].map((d) => new Date(now + d * 86_400_000).toISOString().slice(0, 10));
}

// WFDF venue TZ — wfdf_teams.country_code is a 3-letter IOC/WFDF code (USA,
// CAN, GBR, …), NOT ISO 3166-1 (which would be USA/CAN/GBR too for these, but
// diverges for e.g. Great Britain = GBR in both; verified live: PEO = China,
// HON = Hong Kong, PHI = Philippines — those three DO diverge from ISO). Only
// the realistic WFDF host countries seen in the live wfdf_events/wfdf_teams
// data are mapped; anything else falls back to UTC (a WFDF event in an
// unmapped country just won't get quiet-hours-windowed pushes — they'll wait
// for the UTC window, which is still a bounded, sane range, not spam).
const WFDF_COUNTRY_TO_TZ: Record<string, string> = {
  USA: 'America/New_York', // fallback for multi-timezone country; closest to the historical WFDF US-host cities
  CAN: 'America/Toronto',
  COL: 'America/Bogota',
  JPN: 'Asia/Tokyo',
  GBR: 'Europe/London',
  GER: 'Europe/Berlin',
  SGP: 'Asia/Singapore',
  AUS: 'Australia/Sydney',
  FRA: 'Europe/Paris',
  ITA: 'Europe/Rome',
  MEX: 'America/Mexico_City',
  NZL: 'Pacific/Auckland',
  ESP: 'Europe/Madrid',
  IND: 'Asia/Kolkata',
  PHI: 'Asia/Manila',
  BEL: 'Europe/Brussels',
  PEO: 'Asia/Shanghai',
  IRL: 'Europe/Dublin',
  SUI: 'Europe/Zurich',
  AUT: 'Europe/Vienna',
  VEN: 'America/Caracas',
  NED: 'Europe/Amsterdam',
  DOM: 'America/Santo_Domingo',
  PAN: 'America/Panama',
  HON: 'Asia/Hong_Kong',
  POR: 'Europe/Lisbon',
  LTU: 'Europe/Vilnius',
  UGA: 'Africa/Kampala',
};

/** wfdf_events.location is free text ("City, Country" or just "Country").
 *  Take the tail after the last comma (or the whole string) and match it
 *  against country NAMES seen in wfdf_teams.country_name — we don't have a
 *  country-name→code table, so this keeps a small direct name→tz map instead
 *  of trying to parse codes out of prose. UTC fallback when unmapped/unknown. */
const WFDF_COUNTRY_NAME_TO_TZ: Record<string, string> = {
  'united states of america': 'America/New_York',
  'united states': 'America/New_York',
  canada: 'America/Toronto',
  colombia: 'America/Bogota',
  japan: 'Asia/Tokyo',
  'united kingdom': 'Europe/London',
  'great britain': 'Europe/London',
  germany: 'Europe/Berlin',
  singapore: 'Asia/Singapore',
  australia: 'Australia/Sydney',
  france: 'Europe/Paris',
  italy: 'Europe/Rome',
  mexico: 'America/Mexico_City',
  'new zealand': 'Pacific/Auckland',
  spain: 'Europe/Madrid',
  india: 'Asia/Kolkata',
  philippines: 'Asia/Manila',
  belgium: 'Europe/Brussels',
  "people's republic of china": 'Asia/Shanghai',
  ireland: 'Europe/Dublin',
  switzerland: 'Europe/Zurich',
  austria: 'Europe/Vienna',
  venezuela: 'America/Caracas',
  netherlands: 'Europe/Amsterdam',
  'dominican republic': 'America/Santo_Domingo',
  panama: 'America/Panama',
  'hong kong, china': 'Asia/Hong_Kong',
  portugal: 'Europe/Lisbon',
  lithuania: 'Europe/Vilnius',
  uganda: 'Africa/Kampala',
};

function wfdfVenueTzFromLocation(location: string | null | undefined): string | null {
  if (!location) return null;
  const parts = location.split(',');
  const countryPart = parts[parts.length - 1]?.trim().toLowerCase();
  if (!countryPart) return null;
  return WFDF_COUNTRY_NAME_TO_TZ[countryPart] ?? null;
}

function wfdfVenueTzFromCountryCode(code: string | null | undefined): string | null {
  if (!code) return null;
  return WFDF_COUNTRY_TO_TZ[code.trim().toUpperCase()] ?? null;
}

/** Is `when` within [QUIET_HOURS_START, QUIET_HOURS_END) local wall-clock time
 *  in `tz`? Unknown tz (null) falls back to UTC — a defined, bounded window
 *  rather than no window at all. */
function withinQuietHours(when: Date, tz: string | null): boolean {
  const hour = Number(
    when.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tz ?? 'UTC' }),
  );
  // toLocaleString can return "24" for midnight in hour12:false depending on
  // runtime ICU data — normalize.
  const h = hour === 24 ? 0 : hour;
  return h >= QUIET_HOURS_START && h < QUIET_HOURS_END;
}

// Midnight-UTC scheduled_at = date-only placeholder (legacy USAU scrapes
// store no real start time) — never notify off those. Shared by game and
// event-milestone detection.
function hasRealTime(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0;
}

// Web's division order — Men is the merged event page's default tab.
const SERIES_DIVISION_ORDER = ['Men', 'Women', 'Mixed'];

/** Series member whose uuid goes in a group notice's payload (mobile routes
 *  by uuid): the web's default division first. */
function seriesRep<T extends { series_division: string | null }>(members: T[]): T {
  const rank = (d: string | null) => {
    const i = SERIES_DIVISION_ORDER.indexOf(d ?? '');
    return i < 0 ? SERIES_DIVISION_ORDER.length : i;
  };
  return [...members].sort((a, b) => rank(a.series_division) - rank(b.series_division))[0];
}

/** YYYY-MM-DD of `iso` on the venue-local wall clock (UTC when tz unknown).
 *  Built from parts, not a locale's date pattern, so the runtime's ICU data
 *  can't change the shape the start filter and group keys compare against. */
function localDate(iso: string, tz: string | null): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// .in() id lists ride in the URL: the gateway 400s past ~650 uuids, and a
// response caps at 1000 rows. Both reads below run after the claim, so a
// failure there loses the tick's notices for good.
const IN_CHUNK = 200;

function ufaIsPlayoff(week: string | null, year: number): boolean {
  if (!week) return false;
  const m = /^week-(\d+)$/.exec(week);
  if (!m) return true; // labeled rounds (semifinals, championship, …)
  return Number(m[1]) >= (UFA_PLAYOFF_START_WEEK[year] ?? UFA_PLAYOFF_START_DEFAULT);
}

// ─── Notice model ────────────────────────────────────────────────────────────

type GameCategory = 'game_start' | 'game_final';
type EventCategory = 'event_start' | 'event_bracket' | 'event_final';
type Category = GameCategory | EventCategory | 'player_stats';

interface Notice {
  league: 'ufa' | 'usau' | 'wfdf';
  /** Dedup key stored in game_notifications.game_id — a game id for game_*
   *  categories, an event id for event_* categories, "<id>:<playerId>" for
   *  player_stats. */
  dedupId: string;
  category: Category;
  title: string;
  body: string;
  data: Record<string, string>;
  /** Team ids whose followers are in the audience (game_* notices, and the
   *  team-entered leg of event_* notices). */
  teamIds: string[];
  /** True when league followers (user_favorite_leagues) are also in the
   *  audience. Always true for game_* (narrowed to LEAGUE-ONLY users — those
   *  with no team favorite in the league — in resolveAudiences) and for
   *  event_* (subject to the flighted restriction applied separately for
   *  USAU). */
  leagueWide: boolean;
  /** event_* only: the event id, for the league-favorite + starred-event +
   *  team-entered audience resolution. */
  eventId?: string;
  /** USAU series member's series_group_key: event_* audiences union across
   *  every member of the group, and the game_final digest merges per group
   *  (eventName is then the group name). */
  seriesGroupKey?: string;
  /** USAU only (event_* and game_*): whether THIS event is flighted
   *  (template_key IS NOT NULL). Gates the league-favorite leg of the audience
   *  only — team-entered/team-follower and starred followers still get
   *  notified for an unflighted event. Always true for WFDF (no flighted
   *  concept there). */
  isFlighted?: boolean;
  /** player_stats only: the single favorited-player audience member — no
   *  broader union applies to this category. */
  playerAudience?: { playerId: string };
  /** event_start/event_bracket/event_final/game_* for a non-team-favorited
   *  audience: whether this notice is subject to quiet-hours holding. Games
   *  for a favorited team are exempt (Hunter's decision #3) — modeled by
   *  giving those Notices quietHours: false. */
  quietHours: boolean;
  /** game_start/game_final only, USAU/WFDF: the event's display name, for the
   *  per-user game_final digest ("3 results at {event}"). UFA games don't
   *  carry one (UFA game_final never digests — see the digest-cap comment). */
  eventName?: string;
  /** Venue-local IANA tz for quiet-hours evaluation, or null → UTC fallback. */
  venueTz: string | null;
}

// ─── Candidate collection — games ───────────────────────────────────────────

async function ufaCandidates(sb: SupabaseClient, now: number): Promise<Notice[]> {
  const startLo = new Date(now - START_GRACE_MS).toISOString();
  const startHi = new Date(now + START_LEAD_MS).toISOString();
  const finalLo = new Date(now - FINAL_WINDOW_MS).toISOString();

  const [starts, finals] = await Promise.all([
    sb
      .from('ufa_games')
      .select('id, year, week, home_team_id, away_team_id, start_timestamp')
      .eq('status', 'Upcoming')
      .gte('start_timestamp', startLo)
      .lte('start_timestamp', startHi),
    sb
      .from('ufa_games')
      .select('id, year, week, home_team_id, away_team_id, home_score, away_score, start_timestamp')
      .eq('status', 'Final')
      .gte('start_timestamp', finalLo)
      .lte('start_timestamp', new Date(now).toISOString()),
  ]);
  if (starts.error) throw starts.error;
  if (finals.error) throw finals.error;

  const teamIds = new Set<string>();
  for (const g of [...(starts.data ?? []), ...(finals.data ?? [])]) {
    if (g.home_team_id) teamIds.add(g.home_team_id);
    if (g.away_team_id) teamIds.add(g.away_team_id);
  }
  const names = new Map<string, string>();
  if (teamIds.size > 0) {
    const { data, error } = await sb
      .from('ufa_teams')
      .select('id, name, full_name')
      .in('id', [...teamIds]);
    if (error) throw error;
    for (const t of data ?? []) names.set(t.id, t.full_name ?? t.name ?? t.id);
  }
  const nameOf = (id: string | null) => (id ? names.get(id) ?? id : 'TBD');

  const notices: Notice[] = [];
  for (const g of starts.data ?? []) {
    const playoff = ufaIsPlayoff(g.week, g.year);
    notices.push({
      league: 'ufa',
      dedupId: g.id,
      category: 'game_start',
      title: `${nameOf(g.away_team_id)} at ${nameOf(g.home_team_id)}`,
      body: playoff ? 'UFA Playoffs — starting soon' : 'UFA — starting soon',
      data: { league: 'ufa', gameId: g.id, category: 'game_start' },
      teamIds: [g.home_team_id, g.away_team_id].filter(Boolean) as string[],
      leagueWide: true,
      quietHours: false,
      venueTz: null,
    });
  }
  for (const g of finals.data ?? []) {
    notices.push({
      league: 'ufa',
      dedupId: g.id,
      category: 'game_final',
      title: `${nameOf(g.away_team_id)} at ${nameOf(g.home_team_id)}`,
      body: `Final: ${nameOf(g.away_team_id)} ${g.away_score ?? '–'}, ${nameOf(g.home_team_id)} ${g.home_score ?? '–'}`,
      data: { league: 'ufa', gameId: g.id, category: 'game_final' },
      teamIds: [g.home_team_id, g.away_team_id].filter(Boolean) as string[],
      leagueWide: true,
      quietHours: false,
      venueTz: null,
    });
  }
  return notices;
}

async function usauGameCandidates(sb: SupabaseClient, now: number): Promise<Notice[]> {
  const startLo = new Date(now - START_GRACE_MS).toISOString();
  const startHi = new Date(now + START_LEAD_MS).toISOString();
  const finalLo = new Date(now - FINAL_WINDOW_MS).toISOString();

  const [starts, finals] = await Promise.all([
    sb
      .from('usau_games')
      .select('id, event_id, team_a_id, team_b_id, scheduled_at')
      .eq('status', 'scheduled')
      .gte('scheduled_at', startLo)
      .lte('scheduled_at', startHi),
    sb
      .from('usau_games')
      .select('id, event_id, team_a_id, team_b_id, score_a, score_b, scheduled_at')
      .eq('status', 'final')
      .gte('scheduled_at', finalLo)
      .lte('scheduled_at', new Date(now).toISOString()),
  ]);
  if (starts.error) throw starts.error;
  if (finals.error) throw finals.error;

  const startRows = (starts.data ?? []).filter((g) => hasRealTime(g.scheduled_at));
  const finalRows = (finals.data ?? []).filter((g) => hasRealTime(g.scheduled_at));

  const all = [...startRows, ...finalRows];
  if (all.length === 0) return [];

  const eventIds = [...new Set(all.map((g) => g.event_id).filter(Boolean))];
  const teamIds = [
    ...new Set(all.flatMap((g) => [g.team_a_id, g.team_b_id]).filter(Boolean)),
  ] as string[];

  const events = await sb
    .from('usau_events')
    .select('id, name, template_key, series_group_key, series_group_name')
    .in('id', eventIds);
  if (events.error) throw events.error;
  const teams = teamIds.length > 0
    ? await sb.from('usau_teams').select('id, name').in('id', teamIds)
    : { data: [], error: null };
  if (teams.error) throw teams.error;

  const eventById = new Map<
    string,
    { id: string; name: string; template_key: string | null; series_group_key: string | null; series_group_name: string | null }
  >(
    (events.data ?? []).map((e) => [String(e.id), e]),
  );
  const teamName = new Map<string, string>((teams.data ?? []).map((t) => [String(t.id), t.name]));
  const nameOf = (id: string | null) => (id ? teamName.get(String(id)) ?? 'TBD' : 'TBD');

  const notices: Notice[] = [];
  for (const g of startRows) {
    const ev = eventById.get(String(g.event_id));
    notices.push({
      league: 'usau',
      dedupId: String(g.id),
      category: 'game_start',
      title: `${nameOf(g.team_a_id)} vs ${nameOf(g.team_b_id)}`,
      body: `${ev?.name ?? 'USAU'} — starting soon`,
      data: { league: 'usau', gameId: String(g.id), eventId: String(g.event_id), category: 'game_start' },
      teamIds: [g.team_a_id, g.team_b_id].filter(Boolean) as string[],
      leagueWide: true,
      isFlighted: ev?.template_key != null,
      quietHours: false,
      venueTz: null,
    });
  }
  for (const g of finalRows) {
    // Never announce a "final" without a score — placeholder rows sync in
    // scoreless sometimes and would push a blank result.
    if (g.score_a == null || g.score_b == null) continue;
    const ev = eventById.get(String(g.event_id));
    notices.push({
      league: 'usau',
      dedupId: String(g.id),
      category: 'game_final',
      title: `${nameOf(g.team_a_id)} vs ${nameOf(g.team_b_id)}`,
      body: `Final: ${nameOf(g.team_a_id)} ${g.score_a}, ${nameOf(g.team_b_id)} ${g.score_b}`,
      data: { league: 'usau', gameId: String(g.id), eventId: String(g.event_id), category: 'game_final' },
      teamIds: [g.team_a_id, g.team_b_id].filter(Boolean) as string[],
      leagueWide: true,
      isFlighted: ev?.template_key != null,
      quietHours: false,
      venueTz: null,
      eventName: ev?.series_group_name ?? ev?.name,
      seriesGroupKey: ev?.series_group_key ?? undefined,
    });
  }
  return notices;
}

async function wfdfGameCandidates(sb: SupabaseClient, now: number): Promise<Notice[]> {
  const startLo = new Date(now - START_GRACE_MS).toISOString();
  const startHi = new Date(now + START_LEAD_MS).toISOString();
  const finalLo = new Date(now - FINAL_WINDOW_MS).toISOString();

  const [starts, finals] = await Promise.all([
    sb
      .from('wfdf_games')
      .select('id, event_id, home_team_id, away_team_id, scheduled_at')
      .eq('status', 'scheduled')
      .gte('scheduled_at', startLo)
      .lte('scheduled_at', startHi),
    sb
      .from('wfdf_games')
      .select('id, event_id, home_team_id, away_team_id, home_score, away_score, scheduled_at')
      .eq('status', 'completed')
      .gte('scheduled_at', finalLo)
      .lte('scheduled_at', new Date(now).toISOString()),
  ]);
  if (starts.error) throw starts.error;
  if (finals.error) throw finals.error;

  const all = [...(starts.data ?? []), ...(finals.data ?? [])];
  if (all.length === 0) return [];

  const teamIds = [
    ...new Set(all.flatMap((g) => [g.home_team_id, g.away_team_id]).filter(Boolean)),
  ] as string[];
  const eventIds = [...new Set(all.map((g) => g.event_id).filter(Boolean))] as string[];

  const [teams, events] = await Promise.all([
    teamIds.length > 0
      ? sb.from('wfdf_teams').select('id, name, club_name').in('id', teamIds)
      : Promise.resolve({ data: [], error: null }),
    eventIds.length > 0
      ? sb.from('wfdf_events').select('id, name').in('id', eventIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (teams.error) throw teams.error;
  if (events.error) throw events.error;

  const teamName = new Map<string, string>(
    (teams.data ?? []).map((t) => [String(t.id), t.name ?? t.club_name ?? 'TBD']),
  );
  const eventName = new Map<string, string>((events.data ?? []).map((e) => [String(e.id), e.name]));
  const nameOf = (id: string | null) => (id ? teamName.get(String(id)) ?? 'TBD' : 'TBD');

  const notices: Notice[] = [];
  for (const g of starts.data ?? []) {
    notices.push({
      league: 'wfdf',
      dedupId: String(g.id),
      category: 'game_start',
      title: `${nameOf(g.away_team_id)} at ${nameOf(g.home_team_id)}`,
      body: `${eventName.get(String(g.event_id)) ?? 'WFDF'} — starting soon`,
      data: { league: 'wfdf', gameId: String(g.id), eventId: String(g.event_id ?? ''), category: 'game_start' },
      teamIds: [g.home_team_id, g.away_team_id].filter(Boolean) as string[],
      leagueWide: true,
      quietHours: false, // game pushes are exempt from quiet hours
      venueTz: null,
    });
  }
  for (const g of finals.data ?? []) {
    if (g.home_score == null || g.away_score == null) continue;
    notices.push({
      league: 'wfdf',
      dedupId: String(g.id),
      category: 'game_final',
      title: `${nameOf(g.away_team_id)} at ${nameOf(g.home_team_id)}`,
      body: `Final: ${nameOf(g.away_team_id)} ${g.away_score}, ${nameOf(g.home_team_id)} ${g.home_score}`,
      data: { league: 'wfdf', gameId: String(g.id), eventId: String(g.event_id ?? ''), category: 'game_final' },
      teamIds: [g.home_team_id, g.away_team_id].filter(Boolean) as string[],
      leagueWide: true,
      quietHours: false,
      venueTz: null,
      eventName: eventName.get(String(g.event_id)),
    });
  }
  return notices;
}

// ─── Candidate collection — USAU event milestones ───────────────────────────

async function usauEventStartCandidates(sb: SupabaseClient, now: number): Promise<Notice[]> {
  // start_date is a venue-local DATE, so an event "starts today" when it
  // matches today on the VENUE's wall clock — the UTC date flips at 5–8pm in
  // US venues, which sent 2026 sectionals' "starts today" the evening before.
  // Fetch the UTC dates either side, keep each event only on its own local
  // today (still bounded, so an edited start_date can't fire once history
  // rolls past it); quiet hours then hold the notice until 08:00 local.
  const nowIso = new Date(now).toISOString();
  const { data: rows, error } = await sb
    .from('usau_events')
    .select('id, name, start_date, template_key, state, venue_tz, series_group_key, series_group_name, series_division')
    .in('start_date', datesAround(now));
  if (error) throw error;
  const groupZones = await seriesGroupZones(
    sb,
    [...new Set((rows ?? []).map((ev) => ev.series_group_key).filter((k): k is string => !!k))],
  );
  const data = (rows ?? []).filter((ev) => ev.start_date === localDate(nowIso, usauZone(ev, groupZones)));
  if (data.length === 0) return [];

  const notices: Notice[] = [];
  const groups = new Map<string, NonNullable<typeof data>>();
  for (const ev of data) {
    if (ev.series_group_key) {
      groups.set(ev.series_group_key, [...(groups.get(ev.series_group_key) ?? []), ev]);
      continue;
    }
    notices.push({
      league: 'usau',
      dedupId: String(ev.id),
      category: 'event_start',
      title: ev.name,
      body: `${ev.name} starts today — follow along`,
      data: { league: 'usau', eventId: String(ev.id), category: 'event_start' },
      teamIds: [],
      leagueWide: true,
      eventId: String(ev.id),
      isFlighted: ev.template_key != null,
      quietHours: true,
      venueTz: usauZone(ev, groupZones),
    });
  }
  // Series members (one row per division) collapse to ONE notice per group
  // per day.
  for (const [key, members] of groups) {
    const rep = seriesRep(members);
    notices.push({
      league: 'usau',
      dedupId: `grp:${key}:${rep.start_date}`,
      category: 'event_start',
      title: rep.series_group_name,
      body: `${rep.series_group_name} starts today — follow along`,
      data: { league: 'usau', eventId: String(rep.id), category: 'event_start' },
      teamIds: [],
      leagueWide: true,
      eventId: String(rep.id),
      seriesGroupKey: key,
      isFlighted: members.some((m) => m.template_key != null),
      quietHours: true,
      venueTz: usauZone(rep, groupZones),
    });
  }
  return notices;
}

async function usauEventBracketCandidates(sb: SupabaseClient, now: number): Promise<Notice[]> {
  const lo = new Date(now - EVENT_BRACKET_LOOKBACK_MS).toISOString();
  const hi = new Date(now + START_LEAD_MS).toISOString();
  // Candidate rows: anything with a bracket-ish round/name entering the
  // "starting soon" window. Fetch broadly (round in tree rounds, or 'other'
  // with a bracket_name) then filter with isBracketishRound/isPlacementName
  // client-side — mirrors mirrors the classifier's tail-based logic which
  // isn't expressible cleanly in a single ilike.
  const { data, error } = await sb
    .from('usau_games')
    .select('id, event_id, round, bracket_name, scheduled_at, status')
    .in('round', ['prequarter', 'quarter', 'semi', 'final', 'other'])
    .gte('scheduled_at', lo)
    .lte('scheduled_at', hi);
  if (error) throw error;
  const rows = (data ?? []).filter(
    (g) => hasRealTime(g.scheduled_at) && isBracketishRound(g.round, g.bracket_name) && !isPlacementName(g.bracket_name),
  );
  if (rows.length === 0) return [];

  // One notice per event — the event's FIRST bracket game entering the
  // window this run. Group and keep the earliest scheduled_at per event.
  const firstByEvent = new Map<string, { id: string; event_id: string; scheduled_at: string }>();
  for (const g of rows) {
    const key = String(g.event_id);
    const prev = firstByEvent.get(key);
    if (!prev || g.scheduled_at < prev.scheduled_at) firstByEvent.set(key, g);
  }

  const eventIds = [...firstByEvent.keys()];
  const { data: events, error: evErr } = await sb
    .from('usau_events')
    .select('id, name, template_key, state, venue_tz, series_group_key, series_group_name')
    .in('id', eventIds);
  if (evErr) throw evErr;
  const eventById = new Map((events ?? []).map((e) => [String(e.id), e]));
  const groupZones = await seriesGroupZones(
    sb,
    [...new Set((events ?? []).map((e) => e.series_group_key).filter((k): k is string => !!k))],
  );

  // Series members claim per-DAY group keys, which would re-fire on every day
  // with bracket games (the event-id key made it once per event) — so a
  // member whose bracket already began before this window is dropped. Paged:
  // a sectionals Sunday can pass PostgREST's 1000-row cap.
  const seriesIds = (events ?? []).filter((e) => e.series_group_key).map((e) => String(e.id));
  const begunEarlier = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; seriesIds.length > 0; from += PAGE) {
    const { data: prior, error: priorErr } = await sb
      .from('usau_games')
      .select('id, event_id, round, bracket_name, scheduled_at')
      .in('event_id', seriesIds)
      .in('round', ['prequarter', 'quarter', 'semi', 'final', 'other'])
      .lt('scheduled_at', lo)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (priorErr) throw priorErr;
    for (const g of prior ?? []) {
      if (hasRealTime(g.scheduled_at) && isBracketishRound(g.round, g.bracket_name) && !isPlacementName(g.bracket_name)) {
        begunEarlier.add(String(g.event_id));
      }
    }
    if ((prior ?? []).length < PAGE) break;
  }

  const notices: Notice[] = [];
  // "grp:<key>:<venue-local date>" -> the member whose bracket starts first
  const seriesFirst = new Map<string, { ev: NonNullable<typeof events>[number]; at: string }>();
  for (const [eventId, first] of firstByEvent) {
    const ev = eventById.get(eventId);
    if (!ev) continue;
    if (ev.series_group_key) {
      if (begunEarlier.has(eventId)) continue;
      const dedupId = `grp:${ev.series_group_key}:${localDate(first.scheduled_at, usauZone(ev, groupZones))}`;
      const prev = seriesFirst.get(dedupId);
      if (!prev || first.scheduled_at < prev.at) seriesFirst.set(dedupId, { ev, at: first.scheduled_at });
      continue;
    }
    notices.push({
      league: 'usau',
      dedupId: eventId,
      category: 'event_bracket',
      title: ev.name,
      body: `Bracket play begins at ${ev.name}`,
      data: { league: 'usau', eventId, category: 'event_bracket' },
      teamIds: [],
      leagueWide: true,
      eventId,
      isFlighted: ev.template_key != null,
      quietHours: true,
      venueTz: usauZone(ev, groupZones),
    });
  }
  for (const [dedupId, { ev }] of seriesFirst) {
    const eventId = String(ev.id);
    notices.push({
      league: 'usau',
      dedupId,
      category: 'event_bracket',
      title: ev.series_group_name,
      body: `Bracket play begins at ${ev.series_group_name}`,
      data: { league: 'usau', eventId, category: 'event_bracket' },
      teamIds: [],
      leagueWide: true,
      eventId,
      seriesGroupKey: ev.series_group_key,
      isFlighted: ev.template_key != null,
      quietHours: true,
      venueTz: usauZone(ev, groupZones),
    });
  }
  return notices;
}

async function usauEventFinalCandidates(sb: SupabaseClient, now: number): Promise<Notice[]> {
  const lo = new Date(now - EVENT_FINAL_LOOKBACK_MS).toISOString();
  const hi = new Date(now).toISOString();

  // Leg 1: championship-bracket final going status=final with scores.
  const { data: finals, error: finalErr } = await sb
    .from('usau_games')
    .select('id, event_id, round, bracket_name, team_a_id, team_b_id, score_a, score_b, scheduled_at')
    .eq('status', 'final')
    .eq('round', 'final')
    .gte('scheduled_at', lo)
    .lte('scheduled_at', hi);
  if (finalErr) throw finalErr;
  const champRows = (finals ?? []).filter(
    (g) =>
      hasRealTime(g.scheduled_at) &&
      g.score_a != null && g.score_b != null &&
      isChampionshipBracketName(g.bracket_name, g.round),
  );

  const notices: Notice[] = [];
  const handledEvents = new Set<string>();

  if (champRows.length > 0) {
    const teamIds = [...new Set(champRows.flatMap((g) => [g.team_a_id, g.team_b_id]).filter(Boolean))] as string[];
    const eventIds = [...new Set(champRows.map((g) => String(g.event_id)))];
    const [teams, events] = await Promise.all([
      teamIds.length > 0 ? sb.from('usau_teams').select('id, name, gender_division').in('id', teamIds) : Promise.resolve({ data: [], error: null }),
      sb.from('usau_events').select('id, name, template_key, state, venue_tz, series_group_key, series_group_name, series_division').in('id', eventIds),
    ]);
    if (teams.error) throw teams.error;
    if (events.error) throw events.error;
    const teamName = new Map((teams.data ?? []).map((t) => [String(t.id), t.name]));
    const teamDivision = new Map((teams.data ?? []).map((t) => [String(t.id), t.gender_division]));
    const eventById = new Map((events.data ?? []).map((e) => [String(e.id), e]));
    const groupZones = await seriesGroupZones(
      sb,
      [...new Set((events.data ?? []).map((e) => e.series_group_key).filter((k): k is string => !!k))],
    );

    const handledKeys = new Set<string>();
    for (const g of champRows) {
      const eventId = String(g.event_id);
      const ev = eventById.get(eventId);
      if (!ev) continue;
      const winnerId = g.score_a > g.score_b ? g.team_a_id : g.score_b > g.score_a ? g.team_b_id : null;
      if (!winnerId) continue; // tie in a "final" is bad data — no push
      // One champion per DIVISION. A series member with a division is a
      // single-division row and keeps the bare event-id key; a row hosting
      // several divisions (Club Nationals, 2014 combined sectionals) also keys
      // on the winner's division — the bare key alone let only the first
      // division's final through.
      const division: string | null = ev.series_division ? null : teamDivision.get(String(winnerId)) ?? null;
      const dedupId = division ? `${eventId}:${division}` : eventId;
      if (handledKeys.has(dedupId)) continue; // one champion notice per division per run
      const winnerName = teamName.get(String(winnerId)) ?? 'The champion';
      handledEvents.add(eventId);
      handledKeys.add(dedupId);
      notices.push({
        league: 'usau',
        dedupId,
        category: 'event_final',
        title: ev.series_group_name ?? ev.name,
        body: `Champion crowned: ${winnerName} win ${ev.name}${division ? ` (${division})` : ''}`,
        data: { league: 'usau', eventId, category: 'event_final' },
        teamIds: [],
        leagueWide: true,
        eventId,
        seriesGroupKey: ev.series_group_key ?? undefined,
        isFlighted: ev.template_key != null,
        quietHours: true,
        venueTz: usauZone(ev, groupZones),
      });
    }
  }

  // Leg 2: pool-only events (zero bracket games) — the LAST scheduled game
  // going final AND a clear (untied) pool-record winner. Only worth checking
  // for events with a game finishing in this run's window.
  const { data: recentFinals, error: rfErr } = await sb
    .from('usau_games')
    .select('id, event_id, team_a_id, team_b_id, score_a, score_b, scheduled_at, round, bracket_name')
    .eq('status', 'final')
    .gte('scheduled_at', lo)
    .lte('scheduled_at', hi);
  if (rfErr) throw rfErr;
  const candidateEventIds = [
    ...new Set(
      (recentFinals ?? [])
        .filter((g) => hasRealTime(g.scheduled_at) && !handledEvents.has(String(g.event_id)))
        .map((g) => String(g.event_id)),
    ),
  ];
  if (candidateEventIds.length === 0) {
    return notices;
  }

  const { data: allEventGames, error: aegErr } = await sb
    .from('usau_games')
    .select('id, event_id, team_a_id, team_b_id, score_a, score_b, scheduled_at, status, round, bracket_name')
    .in('event_id', candidateEventIds);
  if (aegErr) throw aegErr;

  const byEvent = new Map<string, typeof allEventGames>();
  for (const g of allEventGames ?? []) {
    const key = String(g.event_id);
    if (!byEvent.has(key)) byEvent.set(key, []);
    byEvent.get(key)!.push(g);
  }

  const eventIds = candidateEventIds;
  const { data: events, error: evErr } = await sb
    .from('usau_events')
    .select('id, name, template_key, state, venue_tz, series_group_key, series_group_name')
    .in('id', eventIds);
  if (evErr) throw evErr;
  const eventById = new Map((events ?? []).map((e) => [String(e.id), e]));
  const groupZones = await seriesGroupZones(
    sb,
    [...new Set((events ?? []).map((e) => e.series_group_key).filter((k): k is string => !!k))],
  );

  const poolOnlyTeamIds = new Set<string>();
  const poolOnlyResults = new Map<string, { eventId: string; games: NonNullable<typeof allEventGames> }>();

  for (const eventId of eventIds) {
    const games = (byEvent.get(eventId) ?? []).filter((g) => hasRealTime(g.scheduled_at));
    if (games.length === 0) continue;
    const hasBracketGame = games.some((g) => isBracketishRound(g.round, g.bracket_name) && !isPlacementName(g.bracket_name));
    if (hasBracketGame) continue; // not pool-only — handled (or not) by leg 1

    // "Last scheduled game" = max scheduled_at across the event's games.
    const lastAt = games.reduce((max, g) => (g.scheduled_at > max ? g.scheduled_at : max), games[0].scheduled_at);
    const lastGameJustFinaled = games.some((g) => g.status === 'final' && g.scheduled_at === lastAt);
    if (!lastGameJustFinaled) continue;
    // The last game must itself be one of the rows that finaled within this
    // run's window (not a stale final sitting there from a prior run).
    const isFreshThisRun = (recentFinals ?? []).some(
      (g) => String(g.event_id) === eventId && g.scheduled_at === lastAt,
    );
    if (!isFreshThisRun) continue;

    if (games.some((g) => g.status !== 'final')) continue; // event not fully final yet

    for (const g of games) {
      if (g.team_a_id) poolOnlyTeamIds.add(g.team_a_id);
      if (g.team_b_id) poolOnlyTeamIds.add(g.team_b_id);
    }
    poolOnlyResults.set(eventId, { eventId, games });
  }

  if (poolOnlyResults.size === 0) return notices;

  const { data: poolTeams, error: ptErr } = poolOnlyTeamIds.size > 0
    ? await sb.from('usau_teams').select('id, name').in('id', [...poolOnlyTeamIds])
    : { data: [], error: null };
  if (ptErr) throw ptErr;
  const teamName = new Map((poolTeams ?? []).map((t) => [String(t.id), t.name]));

  for (const [eventId, { games }] of poolOnlyResults) {
    const ev = eventById.get(eventId);
    if (!ev) continue;
    // Strictly-best record across the event's games; any tie → no push.
    const record = new Map<string, { wins: number; losses: number }>();
    for (const g of games) {
      if (g.score_a == null || g.score_b == null || g.score_a === g.score_b) continue;
      const winner = g.score_a > g.score_b ? g.team_a_id : g.team_b_id;
      const loser = g.score_a > g.score_b ? g.team_b_id : g.team_a_id;
      if (winner) record.set(winner, { wins: (record.get(winner)?.wins ?? 0) + 1, losses: record.get(winner)?.losses ?? 0 });
      if (loser) record.set(loser, { wins: record.get(loser)?.wins ?? 0, losses: (record.get(loser)?.losses ?? 0) + 1 });
    }
    const standings = [...record.entries()].sort((a, b) => b[1].wins - a[1].wins || a[1].losses - b[1].losses);
    if (standings.length === 0) continue;
    const [topId, topRec] = standings[0];
    const tied = standings.filter(([, r]) => r.wins === topRec.wins && r.losses === topRec.losses).length;
    if (tied > 1) continue; // tie → no push

    const winnerName = teamName.get(topId) ?? 'The champion';
    notices.push({
      league: 'usau',
      dedupId: eventId,
      category: 'event_final',
      title: ev.series_group_name ?? ev.name,
      body: `Champion crowned: ${winnerName} win ${ev.name}`,
      data: { league: 'usau', eventId, category: 'event_final' },
      teamIds: [],
      leagueWide: true,
      eventId,
      seriesGroupKey: ev.series_group_key ?? undefined,
      isFlighted: ev.template_key != null,
      quietHours: true,
      venueTz: usauZone(ev, groupZones),
    });
  }

  return notices;
}

// ─── Candidate collection — WFDF event milestones ───────────────────────────

async function wfdfEventStartCandidates(sb: SupabaseClient, now: number): Promise<Notice[]> {
  // Venue-local "today", same rule as usauEventStartCandidates.
  const nowIso = new Date(now).toISOString();
  const { data: rows, error } = await sb
    .from('wfdf_events')
    .select('id, name, start_date, location')
    .in('start_date', datesAround(now));
  if (error) throw error;
  const data = (rows ?? []).filter(
    (ev) => ev.start_date === localDate(nowIso, wfdfVenueTzFromLocation(ev.location)),
  );
  if (data.length === 0) return [];
  return data.map((ev) => ({
    league: 'wfdf' as const,
    dedupId: String(ev.id),
    category: 'event_start' as const,
    title: ev.name,
    body: `${ev.name} starts today — follow along`,
    data: { league: 'wfdf', eventId: String(ev.id), category: 'event_start' },
    teamIds: [],
    leagueWide: true, // WFDF has no flighted concept — every league-favorite is in scope
    eventId: String(ev.id),
    isFlighted: true, // WFDF has no flighted concept
    quietHours: true,
    venueTz: wfdfVenueTzFromLocation(ev.location),
  }));
}

async function wfdfEventBracketCandidates(sb: SupabaseClient, now: number): Promise<Notice[]> {
  const lo = new Date(now - EVENT_BRACKET_LOOKBACK_MS).toISOString();
  const hi = new Date(now + START_LEAD_MS).toISOString();
  const { data, error } = await sb
    .from('wfdf_games')
    .select('id, event_id, scheduled_at')
    .eq('is_bracket', true)
    .gte('scheduled_at', lo)
    .lte('scheduled_at', hi);
  if (error) throw error;
  if (!data || data.length === 0) return [];

  const firstByEvent = new Map<string, string>(); // event_id -> earliest scheduled_at
  for (const g of data) {
    const key = String(g.event_id);
    const prev = firstByEvent.get(key);
    if (!prev || g.scheduled_at < prev) firstByEvent.set(key, g.scheduled_at);
  }

  const eventIds = [...firstByEvent.keys()];
  const { data: events, error: evErr } = await sb.from('wfdf_events').select('id, name, location').in('id', eventIds);
  if (evErr) throw evErr;

  return (events ?? []).map((ev) => ({
    league: 'wfdf' as const,
    dedupId: String(ev.id),
    category: 'event_bracket' as const,
    title: ev.name,
    body: `Bracket play begins at ${ev.name}`,
    data: { league: 'wfdf', eventId: String(ev.id), category: 'event_bracket' },
    teamIds: [],
    leagueWide: true,
    eventId: String(ev.id),
    isFlighted: true, // WFDF has no flighted concept
    quietHours: true,
    venueTz: wfdfVenueTzFromLocation(ev.location),
  }));
}

async function wfdfEventFinalCandidates(sb: SupabaseClient, now: number): Promise<Notice[]> {
  const lo = new Date(now - EVENT_FINAL_LOOKBACK_MS).toISOString();
  const hi = new Date(now).toISOString();

  // Detection rule (documented per the task's request to choose + justify
  // one, verified against live WUCC 2026 data): WFDF names each division's
  // top bracket by seed range, e.g. "Playoff (1-32)" — the range always
  // starts at 1 for the true championship bracket ("Playoff (33-48)" etc are
  // placement brackets). BUT "(1-N) Finals" is a ROUND NAME, not a single
  // game — a round-of-16 bracket plays its "Finals" round as 16 SIMULTANEOUS
  // games (round of 16, i.e. 32 teams narrowed to 2 across the whole event,
  // one physical "Finals" game per group). The actual gold-medal game is the
  // SINGLE LAST-SCHEDULED game within that round for a given division.
  // Verified against WUCC 2026: `distinct on (division_id) ... order by
  // scheduled_at desc` over pool_name='Playoff (1-32) Finals' returns exactly
  // the two games whose winners are the divisions' final_standing=1 teams.
  const { data: rows, error } = await sb
    .from('wfdf_games')
    .select('id, event_id, division_id, pool_name, home_team_id, away_team_id, home_score, away_score, updated_at, scheduled_at')
    .eq('is_bracket', true)
    .eq('status', 'completed')
    .gte('updated_at', lo)
    .lte('updated_at', hi);
  if (error) throw error;
  const recentChampRoundRows = (rows ?? []).filter((g) => {
    const name = (g.pool_name ?? '').toLowerCase().trim();
    return /^playoff \(1-\d+\)\s*finals$/.test(name);
  });
  if (recentChampRoundRows.length === 0) return [];

  // For each (event, division, pool_name) touched by a game that finaled in
  // this window, re-fetch the WHOLE round to find its single last-scheduled
  // game — that's the actual championship match, which may not be the row
  // that triggered this candidate pass (an earlier "Finals"-round game in
  // the same group could finalize first).
  const groups = new Map<string, { eventId: string; divisionId: string; poolName: string }>();
  for (const g of recentChampRoundRows) {
    const key = `${g.event_id}|${g.division_id}|${g.pool_name}`;
    if (!groups.has(key)) groups.set(key, { eventId: String(g.event_id), divisionId: String(g.division_id), poolName: g.pool_name });
  }

  const championshipGames: NonNullable<typeof rows> = [];
  for (const { eventId, divisionId, poolName } of groups.values()) {
    const { data: roundRows, error: roundErr } = await sb
      .from('wfdf_games')
      .select('id, event_id, division_id, pool_name, home_team_id, away_team_id, home_score, away_score, updated_at, scheduled_at, status')
      .eq('event_id', eventId)
      .eq('division_id', divisionId)
      .eq('pool_name', poolName);
    if (roundErr) throw roundErr;
    const finished = (roundRows ?? []).filter((g) => g.status === 'completed' && g.scheduled_at);
    if (finished.length === 0) continue;
    const last = finished.reduce((max, g) => (g.scheduled_at > max.scheduled_at ? g : max), finished[0]);
    // Only fire once the round's LAST scheduled game (by time, whether or
    // not it's the specific one that triggered this pass) has itself gone
    // final — otherwise an earlier "Finals"-round upset would crown the
    // wrong team.
    const allRoundGamesScheduled = (roundRows ?? []).every((g) => g.scheduled_at != null);
    if (!allRoundGamesScheduled) continue;
    const maxScheduledAt = (roundRows ?? []).reduce((max, g) => (g.scheduled_at && g.scheduled_at > max ? g.scheduled_at : max), '');
    if (last.scheduled_at !== maxScheduledAt) continue; // the true last game hasn't finaled yet
    championshipGames.push(last);
  }
  if (championshipGames.length === 0) return [];

  // One notice per event (across divisions, if a multi-division event's
  // finals land in the same window, first one wins per run — the rest claim
  // on the next tick with an already-notified dedup key... actually dedup is
  // per event id, so a second division's championship in the SAME event in a
  // LATER run would be silently dropped. Accepted for now: multi-division
  // WFDF events (Worlds) rarely finish all divisions' finals more than 3h
  // apart within one push's scope, and the plan asks for one event_final per
  // event, not per division.
  const byEvent = new Map<string, typeof championshipGames[number]>();
  for (const g of championshipGames) {
    const key = String(g.event_id);
    if (!byEvent.has(key)) byEvent.set(key, g);
  }

  const teamIds = [...new Set([...byEvent.values()].flatMap((g) => [g.home_team_id, g.away_team_id]).filter(Boolean))] as string[];
  const eventIds = [...byEvent.keys()];
  const [teams, events] = await Promise.all([
    teamIds.length > 0 ? sb.from('wfdf_teams').select('id, name, club_name').in('id', teamIds) : Promise.resolve({ data: [], error: null }),
    sb.from('wfdf_events').select('id, name, location').in('id', eventIds),
  ]);
  if (teams.error) throw teams.error;
  if (events.error) throw events.error;
  const teamName = new Map((teams.data ?? []).map((t) => [String(t.id), t.name ?? t.club_name ?? 'TBD']));
  const eventById = new Map((events.data ?? []).map((e) => [String(e.id), e]));

  const notices: Notice[] = [];
  for (const [eventId, g] of byEvent) {
    const ev = eventById.get(eventId);
    if (!ev) continue;
    if (g.home_score == null || g.away_score == null || g.home_score === g.away_score) continue;
    const winnerId = g.home_score > g.away_score ? g.home_team_id : g.away_team_id;
    const winnerName = teamName.get(String(winnerId)) ?? 'The champion';
    notices.push({
      league: 'wfdf',
      dedupId: eventId,
      category: 'event_final',
      title: ev.name,
      body: `Champion crowned: ${winnerName} win ${ev.name}`,
      data: { league: 'wfdf', eventId, category: 'event_final' },
      teamIds: [],
      leagueWide: true,
      eventId,
      isFlighted: true, // WFDF has no flighted concept
      quietHours: true,
      venueTz: wfdfVenueTzFromLocation(ev.location),
    });
  }
  return notices;
}

// ─── Candidate collection — player_stats ────────────────────────────────────

async function wfdfPlayerStatsCandidates(sb: SupabaseClient, now: number): Promise<Notice[]> {
  const lo = new Date(now - PLAYER_STATS_LOOKBACK_MS).toISOString();
  const { data: favorites, error: favErr } = await sb
    .from('user_favorite_players')
    .select('user_id, player_id')
    .eq('league', 'wfdf');
  if (favErr) throw favErr;
  if (!favorites || favorites.length === 0) return [];

  // WFDF identity = FULL NAME, not wfdf_player_id: favorites store names
  // ("Stan De Clercq"), and wfdf_player_id is a PER-EVENT roster id — 4,364
  // of 18,499 distinct roster names carry multiple ids across events
  // (verified live 2026-08-28), so an id-keyed favorite would go silent at
  // the next Worlds. full_name IS this app's canonical WFDF key everywhere
  // (by-name resolver routes, unified profiles), so the exact-match rule is
  // applied to it: resolve each favorited name → the EVENT's wfdf_player_id
  // set via wfdf_rosters with exact string equality, scoped to the event
  // being scored. Zero fuzziness — the USAU identity-sprawl concern behind
  // the exact-id rule doesn't apply to a league whose id system is names.
  const favoritedNames = [...new Set(favorites.map((f) => f.player_id))];

  const { data: stats, error: statsErr } = await sb
    .from('wfdf_game_player_stats')
    .select('id, game_id, event_id, wfdf_player_id, goals, assists, callahans, created_at')
    .gte('created_at', lo);
  if (statsErr) throw statsErr;
  if (!stats || stats.length === 0) return [];

  // Favorited-name → per-event roster ids, restricted to the events these
  // fresh stat rows belong to (bounded: lookback already caps the stats set).
  const statEventIds = [...new Set(stats.map((s) => String(s.event_id)))];
  const { data: rosterRows, error: rosterErr } = await sb
    .from('wfdf_rosters')
    .select('event_id, full_name, wfdf_player_id')
    .in('event_id', statEventIds)
    .in('full_name', favoritedNames);
  if (rosterErr) throw rosterErr;
  // "eventId|rosterId" -> favorited full_name (exact equality by construction)
  const nameByEventPlayer = new Map<string, string>();
  for (const r of rosterRows ?? []) {
    if (r.wfdf_player_id != null) nameByEventPlayer.set(`${r.event_id}|${r.wfdf_player_id}`, r.full_name);
  }
  if (nameByEventPlayer.size === 0) return [];

  const matched = stats
    .map((s) => ({ s, name: nameByEventPlayer.get(`${s.event_id}|${s.wfdf_player_id}`) }))
    .filter((x): x is { s: (typeof stats)[number]; name: string } => !!x.name);
  if (matched.length === 0) return [];

  const eventIds = [...new Set(matched.map(({ s }) => String(s.event_id)))];
  const { data: events, error: evErr } = await sb.from('wfdf_events').select('id, name').in('id', eventIds);
  if (evErr) throw evErr;
  const eventName = new Map((events ?? []).map((e) => [String(e.id), e.name]));

  const notices: Notice[] = [];
  for (const { s, name } of matched) {
    const parts = [`${s.goals ?? 0}G`, `${s.assists ?? 0}A`];
    if ((s.callahans ?? 0) > 0) parts.push(`${s.callahans}C`);
    notices.push({
      league: 'wfdf',
      // Dedup on the roster id (stable per event), not the name — two
      // same-named humans in one event stay two rows.
      dedupId: `${s.game_id}:${s.wfdf_player_id}`,
      category: 'player_stats',
      title: eventName.get(String(s.event_id)) ?? 'WFDF',
      body: `${name}'s stats from ${eventName.get(String(s.event_id)) ?? 'the event'}: ${parts.join(' ')}`,
      data: { league: 'wfdf', gameId: String(s.game_id), eventId: String(s.event_id), category: 'player_stats' },
      teamIds: [],
      leagueWide: false,
      quietHours: false,
      venueTz: null,
      // Audience keys on the favorites row's own value (the name), so the
      // resolver's player_id lookup works unchanged.
      playerAudience: { playerId: name },
    });
  }
  return notices;
}

async function usauPlayerStatsCandidates(sb: SupabaseClient, now: number): Promise<Notice[]> {
  const lo = new Date(now - PLAYER_STATS_LOOKBACK_MS).toISOString();
  const { data: favorites, error: favErr } = await sb
    .from('user_favorite_players')
    .select('user_id, player_id')
    .eq('league', 'usau');
  if (favErr) throw favErr;
  if (!favorites || favorites.length === 0) return [];

  // Exact id match only — usau_player_event_stats.player_id is a uuid and so
  // is user_favorite_players.player_id for USAU (unlike WFDF's name-keyed
  // rows). Never name-fuzzy match here per the plan's identity-sprawl note.
  const favoritedIds = new Set(favorites.map((f) => f.player_id));

  // Filtered to favorites server-side: unfiltered, a backfill burst passes the
  // 1000-row response cap and silently drops the live rows.
  const { data: stats, error: statsErr } = await sb
    .from('usau_player_event_stats')
    .select('event_id, player_id, goals, assists, scraped_at')
    .gte('scraped_at', lo)
    .in('player_id', [...favoritedIds]);
  if (statsErr) throw statsErr;

  const matched = (stats ?? []).filter((s) => favoritedIds.has(String(s.player_id)));
  if (matched.length === 0) return [];

  const eventIds = [...new Set(matched.map((s) => String(s.event_id)))];
  const { data: events, error: evErr } = await sb
    .from('usau_events')
    .select('id, name')
    .in('id', eventIds)
    .gte('end_date', new Date(now - PLAYER_STATS_EVENT_RECENCY_DAYS * 86_400_000).toISOString().slice(0, 10))
    .lte('start_date', new Date(now + 86_400_000).toISOString().slice(0, 10));
  if (evErr) throw evErr;
  const eventName = new Map((events ?? []).map((e) => [String(e.id), e.name]));

  const byUser = new Map<string, string>();
  for (const f of favorites) byUser.set(f.player_id, f.user_id);

  const notices: Notice[] = [];
  for (const s of matched) {
    const playerIdText = String(s.player_id);
    const userId = byUser.get(playerIdText);
    if (!userId) continue;
    const eventId = String(s.event_id);
    const eName = eventName.get(eventId);
    if (!eName) continue; // not a recent event (or undated) — never push
    notices.push({
      league: 'usau',
      dedupId: `${eventId}:${playerIdText}`,
      category: 'player_stats',
      title: eName,
      body: `Your player's stats from ${eName}: ${s.goals ?? 0}G ${s.assists ?? 0}A`,
      data: { league: 'usau', eventId, category: 'player_stats' },
      teamIds: [],
      leagueWide: false,
      quietHours: false,
      venueTz: null,
      playerAudience: { playerId: playerIdText },
    });
  }
  return notices;
}

// ─── Audience resolution ─────────────────────────────────────────────────────

interface Prefs {
  push_enabled: boolean;
  game_start: boolean;
  game_final: boolean;
  event_updates: boolean;
  player_stats: boolean;
}
const DEFAULT_PREFS: Prefs = {
  push_enabled: true,
  game_start: true,
  game_final: true,
  event_updates: true,
  player_stats: true,
};

function prefKeyFor(category: Category): keyof Omit<Prefs, 'push_enabled'> {
  if (category === 'game_start' || category === 'game_final') return category;
  if (category === 'player_stats') return 'player_stats';
  return 'event_updates'; // event_start / event_bracket / event_final
}

async function usauEnteredTeamAudience(
  sb: SupabaseClient,
  eventIds: string[],
): Promise<Map<string, Set<string>>> {
  // event_id -> set of user_ids following a team entered in that event.
  if (eventIds.length === 0) return new Map();
  const { data: entries, error } = await sb
    .from('usau_event_teams')
    .select('event_id, team_id')
    .in('event_id', eventIds);
  if (error) throw error;
  const teamIds = [...new Set((entries ?? []).map((e) => String(e.team_id)))];
  if (teamIds.length === 0) return new Map();
  const { data: follows, error: fErr } = await sb
    .from('user_favorite_teams')
    .select('user_id, team_id')
    .eq('league', 'usau')
    .in('team_id', teamIds);
  if (fErr) throw fErr;
  const followersByTeam = new Map<string, string[]>();
  for (const f of follows ?? []) {
    const list = followersByTeam.get(String(f.team_id)) ?? [];
    list.push(f.user_id);
    followersByTeam.set(String(f.team_id), list);
  }
  const out = new Map<string, Set<string>>();
  for (const e of entries ?? []) {
    const key = String(e.event_id);
    if (!out.has(key)) out.set(key, new Set());
    for (const u of followersByTeam.get(String(e.team_id)) ?? []) out.get(key)!.add(u);
  }
  return out;
}

async function wfdfEnteredTeamAudience(
  sb: SupabaseClient,
  eventIds: string[],
): Promise<Map<string, Set<string>>> {
  // WFDF has no roster/entry table — a team is "entered" in an event if it
  // appears in any of that event's games.
  if (eventIds.length === 0) return new Map();
  const { data: games, error } = await sb
    .from('wfdf_games')
    .select('event_id, home_team_id, away_team_id')
    .in('event_id', eventIds);
  if (error) throw error;
  const teamIds = [
    ...new Set((games ?? []).flatMap((g) => [g.home_team_id, g.away_team_id]).filter(Boolean)),
  ] as string[];
  if (teamIds.length === 0) return new Map();
  const { data: follows, error: fErr } = await sb
    .from('user_favorite_teams')
    .select('user_id, team_id')
    .eq('league', 'wfdf')
    .in('team_id', teamIds);
  if (fErr) throw fErr;
  const followersByTeam = new Map<string, string[]>();
  for (const f of follows ?? []) {
    const list = followersByTeam.get(String(f.team_id)) ?? [];
    list.push(f.user_id);
    followersByTeam.set(String(f.team_id), list);
  }
  const out = new Map<string, Set<string>>();
  for (const g of games ?? []) {
    const key = String(g.event_id);
    if (!out.has(key)) out.set(key, new Set());
    for (const t of [g.home_team_id, g.away_team_id]) {
      if (!t) continue;
      for (const u of followersByTeam.get(String(t)) ?? []) out.get(key)!.add(u);
    }
  }
  return out;
}

async function resolveAudiences(
  sb: SupabaseClient,
  notices: Notice[],
): Promise<Map<Notice, string[]>> {
  const gameNotices = notices.filter((n) => n.category === 'game_start' || n.category === 'game_final');
  const eventNotices = notices.filter(
    (n) => n.category === 'event_start' || n.category === 'event_bracket' || n.category === 'event_final',
  );
  const playerNotices = notices.filter((n) => n.category === 'player_stats');

  // ── game_* audience: league-ONLY favorites ∪ team followers ∪ starred game ──
  // (Hunter, 2026-09-07 — see TARGETING header.) A team favorite narrows a
  // league favorite, so the league leg is league favorites MINUS anyone with
  // a team favorite in that league; those users come in through the team leg
  // for their own team's games only.
  const leagues = [...new Set(gameNotices.map((n) => n.league))];
  const teamFollowers = new Map<string, Map<string, string[]>>();
  const leagueOnlyFollowers = new Map<string, string[]>();
  const starredGameAudience = new Map<string, Set<string>>(); // "league:gameId" -> user_ids

  for (const league of leagues) {
    const teamIds = [...new Set(gameNotices.filter((n) => n.league === league).flatMap((n) => n.teamIds))];
    if (teamIds.length > 0) {
      const { data, error } = await sb
        .from('user_favorite_teams')
        .select('user_id, team_id')
        .eq('league', league)
        .in('team_id', teamIds);
      if (error) throw error;
      const byTeam = new Map<string, string[]>();
      for (const r of data ?? []) {
        const list = byTeam.get(String(r.team_id)) ?? [];
        list.push(r.user_id);
        byTeam.set(String(r.team_id), list);
      }
      teamFollowers.set(league, byTeam);
    }

    // Every user with ANY team favorite in this league — unbounded by design,
    // so page past PostgREST's 1000-row cap: a truncated set would silently
    // promote league+team users to league-only and push them every game.
    const usersWithTeamFav = new Set<string>();
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb
        .from('user_favorite_teams')
        .select('user_id')
        .eq('league', league)
        .order('user_id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      for (const r of data ?? []) usersWithTeamFav.add(r.user_id);
      if ((data ?? []).length < PAGE) break;
    }
    const { data: leagueFavs, error: leagueErr } = await sb
      .from('user_favorite_leagues')
      .select('user_id')
      .eq('league', league);
    if (leagueErr) throw leagueErr;
    leagueOnlyFollowers.set(
      league,
      (leagueFavs ?? []).map((r) => r.user_id).filter((u) => !usersWithTeamFav.has(u)),
    );

    // Starred-game leg — league-generic (the table's CHECK admits ufa/pul/wul;
    // usau/wfdf simply match nothing). A starred game notifies its own users
    // regardless of league/team favorites; same prefs gate applies below.
    const gameIds = [...new Set(gameNotices.filter((n) => n.league === league).map((n) => n.dedupId))];
    if (gameIds.length > 0) {
      const { data, error } = await sb
        .from('user_favorite_games')
        .select('user_id, game_id')
        .eq('league', league)
        .in('game_id', gameIds);
      if (error) throw error;
      for (const r of data ?? []) {
        const key = `${league}:${String(r.game_id)}`;
        if (!starredGameAudience.has(key)) starredGameAudience.set(key, new Set());
        starredGameAudience.get(key)!.add(r.user_id);
      }
    }
  }

  // ── event_* audience: league-fav(flighted for USAU) ∪ entered-team-fav ∪ starred ──
  // Series groups: a member's notice reaches the whole group's audience.
  const seriesKeys = [...new Set(eventNotices.map((n) => n.seriesGroupKey).filter((x): x is string => !!x))];
  const seriesMembers = new Map<string, string[]>();
  const seriesFlighted = new Set<string>();
  if (seriesKeys.length > 0) {
    const { data, error } = await sb
      .from('usau_events')
      .select('id, series_group_key, template_key')
      .in('series_group_key', seriesKeys);
    if (error) throw error;
    for (const r of data ?? []) {
      seriesMembers.set(r.series_group_key, [...(seriesMembers.get(r.series_group_key) ?? []), String(r.id)]);
      if (r.template_key != null) seriesFlighted.add(r.series_group_key);
    }
  }

  const eventIds = [...new Set(eventNotices.map((n) => n.eventId).filter((x): x is string => !!x))];
  const usauEventIds = [
    ...new Set([
      ...eventNotices.filter((n) => n.league === 'usau').map((n) => n.eventId).filter((x): x is string => !!x),
      ...[...seriesMembers.values()].flat(),
    ]),
  ];
  const wfdfEventIds = [...new Set(eventNotices.filter((n) => n.league === 'wfdf').map((n) => n.eventId).filter((x): x is string => !!x))];

  const [usauEnteredAudience, wfdfEnteredAudience] = await Promise.all([
    usauEnteredTeamAudience(sb, usauEventIds),
    wfdfEnteredTeamAudience(sb, wfdfEventIds),
  ]);

  const usauLeagueFavorites =
    usauEventIds.length > 0
      ? await sb.from('user_favorite_leagues').select('user_id').eq('league', 'usau')
      : { data: [], error: null };
  if (usauLeagueFavorites.error) throw usauLeagueFavorites.error;
  const wfdfLeagueFavorites =
    wfdfEventIds.length > 0
      ? await sb.from('user_favorite_leagues').select('user_id').eq('league', 'wfdf')
      : { data: [], error: null };
  if (wfdfLeagueFavorites.error) throw wfdfLeagueFavorites.error;

  const starredAudience = new Map<string, Set<string>>(); // "league:eventId" -> user_ids
  if (eventIds.length > 0) {
    // Per-league .in() rather than a string-built .or() filter: PostgREST's
    // .or() mini-language treats , ( ) as syntax, so interpolating ids into it
    // is an injection primitive the moment an id source gets less trustworthy
    // (security review 2026-08-28). .in() is parameterized end to end.
    const [usauStarred, wfdfStarred] = await Promise.all([
      usauEventIds.length > 0
        ? sb.from('user_favorite_events').select('user_id, league, event_id').eq('league', 'usau').in('event_id', usauEventIds)
        : Promise.resolve({ data: [], error: null }),
      wfdfEventIds.length > 0
        ? sb.from('user_favorite_events').select('user_id, league, event_id').eq('league', 'wfdf').in('event_id', wfdfEventIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (usauStarred.error) throw usauStarred.error;
    if (wfdfStarred.error) throw wfdfStarred.error;
    for (const r of [...(usauStarred.data ?? []), ...(wfdfStarred.data ?? [])]) {
      const key = `${r.league}:${r.event_id}`;
      if (!starredAudience.has(key)) starredAudience.set(key, new Set());
      starredAudience.get(key)!.add(r.user_id);
    }
  }

  // ── player_stats audience: the single favoriting user, resolved at candidate time ──

  const allUsers = new Set<string>();
  const userSets = new Map<Notice, Set<string>>();

  for (const n of gameNotices) {
    const users = new Set<string>();
    const byTeam = teamFollowers.get(n.league);
    for (const t of n.teamIds) for (const u of byTeam?.get(String(t)) ?? []) users.add(u);
    // League-only leg: USAU is bounded to FLIGHTED events (Hunter, 2026-09-07
    // second ask) — a league-only USAU user would otherwise get a push per
    // scheduled game across every scraped sectionals; UFA/WFDF stay every game.
    // Team followers + starred games still cover unflighted tournaments.
    if (n.leagueWide && (n.league !== 'usau' || n.isFlighted !== false)) {
      for (const u of leagueOnlyFollowers.get(n.league) ?? []) users.add(u);
    }
    for (const u of starredGameAudience.get(`${n.league}:${n.dedupId}`) ?? []) users.add(u);
    userSets.set(n, users);
    for (const u of users) allUsers.add(u);
  }

  for (const n of eventNotices) {
    const users = new Set<string>();
    if (n.eventId) {
      const ids = n.seriesGroupKey ? [n.eventId, ...(seriesMembers.get(n.seriesGroupKey) ?? [])] : [n.eventId];
      for (const id of ids) {
        const entered = n.league === 'usau' ? usauEnteredAudience.get(id) : wfdfEnteredAudience.get(id);
        for (const u of entered ?? []) users.add(u);
        for (const u of starredAudience.get(`${n.league}:${id}`) ?? []) users.add(u);
      }
    }
    // League-favorite leg: gated by isFlighted for USAU (WFDF has none, so
    // isFlighted is always true there); a series group qualifies when ANY
    // member is flighted. Team-entered and starred legs above are NOT gated —
    // a starred/entered event notifies its own users regardless of
    // flightedness (Hunter's spec).
    const flighted = n.seriesGroupKey ? seriesFlighted.has(n.seriesGroupKey) : n.isFlighted !== false;
    if (n.leagueWide && flighted) {
      const favs = n.league === 'usau' ? usauLeagueFavorites.data : wfdfLeagueFavorites.data;
      for (const r of favs ?? []) users.add(r.user_id);
    }
    userSets.set(n, users);
    for (const u of users) allUsers.add(u);
  }

  // player_stats: fetch favorites once per league present, map playerId -> user_id
  // (candidates only carry the playerId, not the user_id, to avoid a
  // fan-out at candidate-collection time — resolved here instead).
  const playerLeagues = [...new Set(playerNotices.map((n) => n.league))];
  // player_id -> ALL favoriting user_ids — a plain Map.set here was last-wins,
  // which silently dropped every user but one when several favorite the same
  // player (found during the 2026-08-28 WFDF name-resolution rework).
  const playerFavByLeague = new Map<string, Map<string, string[]>>();
  for (const league of playerLeagues) {
    const { data, error } = await sb.from('user_favorite_players').select('user_id, player_id').eq('league', league);
    if (error) throw error;
    const m = new Map<string, string[]>();
    for (const r of data ?? []) {
      const list = m.get(r.player_id) ?? [];
      list.push(r.user_id);
      m.set(r.player_id, list);
    }
    playerFavByLeague.set(league, m);
  }
  for (const n of playerNotices) {
    const users = new Set<string>();
    if (n.playerAudience) {
      for (const u of playerFavByLeague.get(n.league)?.get(n.playerAudience.playerId) ?? []) users.add(u);
    }
    userSets.set(n, users);
    for (const u of users) allUsers.add(u);
  }

  if (allUsers.size === 0) return new Map(notices.map((n) => [n, []]));

  const prefs = new Map<string, Prefs>();
  for (const ids of chunk([...allUsers], IN_CHUNK)) {
    const { data: prefRows, error: prefErr } = await sb
      .from('notification_prefs')
      .select('user_id, push_enabled, game_start, game_final, event_updates, player_stats')
      .in('user_id', ids);
    if (prefErr) throw prefErr;
    for (const r of prefRows ?? []) prefs.set(r.user_id, r);
  }

  const audiences = new Map<Notice, string[]>();
  for (const n of notices) {
    const key = prefKeyFor(n.category);
    audiences.set(
      n,
      [...(userSets.get(n) ?? [])].filter((u) => {
        const p = prefs.get(u) ?? DEFAULT_PREFS;
        return p.push_enabled && p[key];
      }),
    );
  }
  return audiences;
}

// ─── Expo delivery ───────────────────────────────────────────────────────────

async function sendExpoPushes(
  sb: SupabaseClient,
  messages: Array<{ to: string; title: string; body: string; data: Record<string, string> }>,
): Promise<number> {
  let delivered = 0;
  for (const batch of chunk(messages, EXPO_BATCH)) {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch.map((m) => ({ ...m, sound: 'default' }))),
    });
    if (!res.ok) {
      console.error('[send-game-notifications] expo push HTTP', res.status, await res.text());
      continue;
    }
    const json = (await res.json()) as { data?: Array<{ status: string; details?: { error?: string } }> };
    const tickets = json.data ?? [];
    for (let i = 0; i < tickets.length; i++) {
      const t = tickets[i];
      if (t.status === 'ok') {
        delivered += 1;
      } else if (t.details?.error === 'DeviceNotRegistered') {
        // Token is dead (app uninstalled / permissions revoked) — drop it so
        // we stop paying for it every send.
        await sb.from('push_tokens').delete().eq('token', batch[i].to);
      } else {
        console.warn('[send-game-notifications] ticket error', batch[i].to.slice(0, 24), t.details?.error);
      }
    }
  }
  return delivered;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

// Constant-time-equivalent auth check: compare SHA-256 digests of the header
// and the expected value, so the string compare can't leak key bytes through
// timing. Fails closed on missing env.
async function authorized(req: Request, serviceKey: string): Promise<boolean> {
  if (!serviceKey) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(req.headers.get('Authorization') ?? '')),
    crypto.subtle.digest('SHA-256', enc.encode(`Bearer ${serviceKey}`)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!(await authorized(req, serviceKey))) {
    return new Response('unauthorized', { status: 401 });
  }
  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', serviceKey);
  const dryRun = new URL(req.url).searchParams.get('dryRun') === '1';
  const now = Date.now();
  const nowDate = new Date(now);

  const candidates = [
    ...(await ufaCandidates(sb, now)),
    ...(await usauGameCandidates(sb, now)),
    ...(await wfdfGameCandidates(sb, now)),
    ...(await usauEventStartCandidates(sb, now)),
    ...(await usauEventBracketCandidates(sb, now)),
    ...(await usauEventFinalCandidates(sb, now)),
    ...(await wfdfEventStartCandidates(sb, now)),
    ...(await wfdfEventBracketCandidates(sb, now)),
    ...(await wfdfEventFinalCandidates(sb, now)),
    ...(await wfdfPlayerStatsCandidates(sb, now)),
    ...(await usauPlayerStatsCandidates(sb, now)),
  ];
  if (candidates.length === 0) {
    return Response.json({ ok: true, candidates: 0, sent: 0 });
  }

  // Quiet hours: a notice that needs holding is NOT claimed this run, so a
  // later cron tick inside the window claims and sends it — never claimed
  // then dropped, which would silently eat the notification forever.
  const heldForQuietHours: Notice[] = [];
  const eligible = candidates.filter((n) => {
    if (!n.quietHours) return true;
    const inWindow = withinQuietHours(nowDate, n.venueTz);
    if (!inWindow) heldForQuietHours.push(n);
    return inWindow;
  });

  let claimed = eligible;
  if (!dryRun) {
    // Claim before sending: only rows that actually inserted are ours to send.
    const { data: claimedRows, error } = await sb
      .from('game_notifications')
      .upsert(
        eligible.map((n) => ({ league: n.league, game_id: n.dedupId, category: n.category })),
        { onConflict: 'league,game_id,category', ignoreDuplicates: true },
      )
      .select('league, game_id, category');
    if (error) throw error;
    const won = new Set((claimedRows ?? []).map((r) => `${r.league}|${r.game_id}|${r.category}`));
    claimed = eligible.filter((n) => won.has(`${n.league}|${n.dedupId}|${n.category}`));
  }
  if (claimed.length === 0) {
    return Response.json({
      ok: true,
      dryRun,
      candidates: candidates.length,
      heldForQuietHours: heldForQuietHours.length,
      claimed: 0,
      sent: 0,
    });
  }

  const audiences = await resolveAudiences(sb, claimed);

  const userIds = [...new Set([...audiences.values()].flat())];
  const tokensByUser = new Map<string, string[]>();
  for (const ids of chunk(userIds, IN_CHUNK)) {
    const { data, error } = await sb.from('push_tokens').select('user_id, token').in('user_id', ids);
    if (error) throw error;
    for (const r of data ?? []) {
      const list = tokensByUser.get(r.user_id) ?? [];
      list.push(r.token);
      tokensByUser.set(r.user_id, list);
    }
  }

  // ── Per-user digest cap for game_final: claims stay per-game (each final is
  // claimed and counted in the summary individually below), but when a
  // single user is due MORE THAN ONE game_final for the same (league,
  // event), the ACTUAL EXPO SEND is merged into one combined push. Only
  // applies to game_final (the category the plan's burst-finals mitigation
  // targets) and only when the notice carries an eventId in its data payload
  // (UFA game_final has no eventId — UFA doesn't burst the way batch-scraped
  // USAU does, so it's left per-game).
  const finalNotices = claimed.filter((n) => n.category === 'game_final' && n.data.eventId);
  const otherNotices = claimed.filter((n) => !(n.category === 'game_final' && n.data.eventId));

  // user -> (league:eventId) -> notices due
  const finalsByUserEvent = new Map<string, Map<string, Notice[]>>();
  for (const n of finalNotices) {
    const users = audiences.get(n) ?? [];
    const key = `${n.league}:${n.seriesGroupKey ?? n.data.eventId}`;
    for (const u of users) {
      if (!finalsByUserEvent.has(u)) finalsByUserEvent.set(u, new Map());
      const byEvent = finalsByUserEvent.get(u)!;
      if (!byEvent.has(key)) byEvent.set(key, []);
      byEvent.get(key)!.push(n);
    }
  }

  let sent = 0;
  const summary: Array<Record<string, unknown>> = [];
  // recipients attribution: each individual notice's `recipients` count in
  // game_notifications reflects users who got EITHER a standalone push for
  // that game OR were folded into a combined digest that included it — i.e.
  // "how many people were notified about this game", not "how many separate
  // Expo pushes referenced only this game".
  const perNoticeRecipients = new Map<Notice, number>();

  if (!dryRun) {
    for (const [userId, byEvent] of finalsByUserEvent) {
      const tokens = tokensByUser.get(userId) ?? [];
      if (tokens.length === 0) continue; // no device — perNoticeRecipients stays unset (0) for these
      for (const notices of byEvent.values()) {
        if (notices.length === 1) {
          const n = notices[0];
          const delivered = await sendExpoPushes(sb, tokens.map((to) => ({ to, title: n.title, body: n.body, data: n.data })));
          sent += delivered;
          perNoticeRecipients.set(n, (perNoticeRecipients.get(n) ?? 0) + (delivered > 0 ? 1 : 0));
        } else {
          const eventTitle = notices[0].eventName ?? notices[0].data.eventId;
          const lines = notices.slice(0, 3).map((n) => n.body.replace(/^Final:\s*/, ''));
          const body = `${notices.length} results at ${eventTitle}${lines.length ? ': ' + lines.join('; ') : ''}`;
          const combinedData = { league: notices[0].league, eventId: String(notices[0].data.eventId ?? ''), category: 'game_final' };
          const delivered = await sendExpoPushes(
            sb,
            tokens.map((to) => ({ to, title: `${notices.length} results`, body, data: combinedData })),
          );
          sent += delivered;
          for (const n of notices) perNoticeRecipients.set(n, (perNoticeRecipients.get(n) ?? 0) + (delivered > 0 ? 1 : 0));
        }
      }
    }
  }

  for (const n of otherNotices) {
    const users = audiences.get(n) ?? [];
    const tokens = users.flatMap((u) => tokensByUser.get(u) ?? []);
    if (dryRun || tokens.length === 0) {
      perNoticeRecipients.set(n, 0);
      continue;
    }
    const delivered = await sendExpoPushes(sb, tokens.map((to) => ({ to, title: n.title, body: n.body, data: n.data })));
    sent += delivered;
    perNoticeRecipients.set(n, delivered);
  }

  for (const n of claimed) {
    const users = audiences.get(n) ?? [];
    const recipients = perNoticeRecipients.get(n) ?? 0;
    summary.push({
      league: n.league,
      dedupId: n.dedupId,
      category: n.category,
      users: users.length,
      recipients,
      leagueWide: n.leagueWide,
    });
    if (!dryRun) {
      await sb
        .from('game_notifications')
        .update({ recipients })
        .eq('league', n.league)
        .eq('game_id', n.dedupId)
        .eq('category', n.category);
    }
  }

  return Response.json({
    ok: true,
    dryRun,
    candidates: candidates.length,
    heldForQuietHours: heldForQuietHours.length,
    claimed: claimed.length,
    sent,
    summary,
  });
});
