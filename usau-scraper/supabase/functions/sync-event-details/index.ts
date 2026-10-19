// sync-event-details: scrape one event's schedule page and upsert teams,
// per-event participation, and games.
//
// Request body: { slug: string, divisions?: ('Men' | 'Mixed' | 'Women')[] }
// Defaults to all three divisions — sync-event-details quietly skips
// divisions that aren't part of the event (404 on the schedule page).
//
// Per division:
//   1. Fetch /events/{slug}/schedule/{Gender}/Club-{Gender}/. 404 → skip.
//   2. Parse pool standings + bracket games via verified selectors.
//   3. Resolve each EventTeamId to a usau_teams row (creating one if new).
//   4. Upsert usau_event_teams (per-event participation with seed/pool).
//   5. Upsert usau_games keyed on usau_game_id when present.
//
// If the parent event doesn't exist in usau_events yet, we create a stub
// row so test events (e.g. 2025-USAU-Pro-Championships) can be scraped
// directly without first running sync-events.

import { fetchHtml } from '../_shared/http.ts';
import {
  BASE_URL,
  parseHtml,
  SELECTORS,
  eventScheduleUrlVariants,
  extractEventGameId,
  extractEventTeamId,
  extractTeamNameAndSeed,
  type ScheduleUrlLevel,
} from '../_shared/parse.ts';
import { supabase, withRunLogging } from '../_shared/supabase.ts';
import { tzForState, localWallTimeToUtcIso, dateOnlyIso } from '../_shared/tz.ts';
import { refreshEventPlacements } from '../_shared/event-placements.ts';

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.message === 'string') parts.push(obj.message);
    if (typeof obj.code === 'string') parts.push(`(${obj.code})`);
    if (typeof obj.details === 'string') parts.push(`— ${obj.details}`);
    return parts.length > 0 ? parts.join(' ') : JSON.stringify(err);
  }
  return String(err);
}

// Render any error shape to a useful string. Supabase PostgrestError objects
// don't inherit Error — they're plain objects with .message/.code/.details.
function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.message === 'string') parts.push(obj.message);
    if (typeof obj.code === 'string') parts.push(`(${obj.code})`);
    if (typeof obj.details === 'string') parts.push(`— ${obj.details}`);
    if (typeof obj.hint === 'string') parts.push(`hint: ${obj.hint}`);
    if (parts.length > 0) return parts.join(' ');
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

type Division = 'Men' | 'Mixed' | 'Women';
type GameRound = 'pool' | 'prequarter' | 'quarter' | 'semi' | 'final' | 'placement' | 'consolation' | 'other';
type GameStatus = 'scheduled' | 'in_progress' | 'final' | 'forfeit' | 'cancelled';

interface ParsedTeam {
  eventTeamId: string;
  displayName: string;
  seed: number | null;
}

interface ParsedPoolRow {
  poolName: string;
  eventTeamId: string;
  wins: number | null;
  losses: number | null;
}

interface ParsedGame {
  usau_game_id: string | null;
  usau_event_game_id: string | null;
  round: GameRound;
  bracket_name: string | null;
  /** null = TBD slot (bracket game whose feeder hasn't finished — "W of
   *  Semifinals G2"). Only bracket games may carry null sides; pool rows
   *  always have both teams. */
  home_event_team_id: string | null;
  away_event_team_id: string | null;
  home_seed: number | null;
  away_seed: number | null;
  score_home: number | null;
  score_away: number | null;
  location: string | null;
  scheduled_at: string | null;
  status: GameStatus;
  /** Forfeit result: USAU prints a forfeit as letters ("F - W") instead of a
   *  score, so both scores stay null and this names the side that won. Null
   *  for scored games, unplayed games and a double forfeit ("F - F"). */
  forfeit_winner: 'home' | 'away' | null;
  /** USAU's own placeholder text for a TBD side ("P1 of Saturday Pool Play
   *  Pool A", "W of Quarterfinals G1") — the bracket cell's plain text when it
   *  has no team link. Null whenever the side has a real team, so a later
   *  scrape clears it as slots fill. */
  home_placeholder: string | null;
  away_placeholder: string | null;
  /** Bracket structure straight from USAU's markup (null on pool rows and on
   *  bracket games whose column couldn't be read). See the 20260913170000
   *  migration for the column semantics. */
  bracket_stage: string | null;
  bracket_stage_index: number | null;
  bracket_slot: number | null;
  next_usau_game_id: string | null;
  next_slot_side: 'top' | 'btm' | null;
}

// ────────────────────────────────────────────────────────────
// Round + status mapping
// ────────────────────────────────────────────────────────────

function classifyRound(h4Label: string | null, h3Label: string | null): GameRound {
  // USAU's actual bracket labels (verified 2026 — Colorado Summer Solstice):
  //   h3 (bracket section): "Championship Bracket", "3rd Place", "5th Place",
  //                         "7th Place", "9th Place", "Consolation"
  //   h4 (round):           "1st Place", "1st Semis", "1st Quarters",
  //                         "Pre-Quarters", "3rd", "5th", "5th semis", "9th semis"
  // The gold-medal game is labeled "1st Place" (NOT "Final"), and placement
  // finals are bare ordinals ("3rd", "5th"). The old classifier looked for the
  // word "final"/"third place" and mis-tagged all of these as 'other'.
  const h3 = (h3Label ?? '').toLowerCase().trim();
  const h4 = (h4Label ?? '').toLowerCase().trim();
  const t = `${h3} ${h4}`;

  // Order matters. Check the most specific round words first.
  // Pre-quarters BEFORE quarters ("pre-quarters" contains "quarter").
  if (t.includes('prequarter') || t.includes('pre-quarter') || t.includes('pre quarter')) {
    return 'prequarter';
  }
  if (t.includes('semi')) return 'semi';
  if (t.includes('quarter')) return 'quarter';
  if (t.includes('consolation')) return 'consolation';

  // The championship gold-medal game. USAU labels it many ways across masters
  // regionals/qualifiers vs Nationals:
  //   h4 round: "1st Place", "First Place", "First Place Game", "Final", "1st"
  //   h3 section: "Championship (Bracket)", "1st/First Place", "Bracket Play"
  //     (a single-bracket event), or empty (whole event is one bracket).
  // We match "first place" (spelled out) as well as "1st place" in BOTH the
  // section and round checks — a game like 2026 Northeast Masters Mixed
  // Regionals is h3="Bracket Play" / h4="First Place Game", which the old
  // (1st-place-only) check missed → stored 'other' → no champion surfaced.
  const isChampSection =
    h3.includes('championship') ||
    h3.includes('1st place') ||
    h3.includes('first place') ||
    h3.includes('bracket play') ||
    h3 === '1st' ||        // bare-ordinal sections (Cooler Classic 37: "1st",
    h3 === 'first' ||      // "5th", "9th" — "1st" IS the championship bracket)
    /^finals?$/.test(h3) || // a "Finals" section (2026 NW Men, SC Mixed) — its decider was filed 'placement'
    h3 === '';
  const isChampRound =
    h4.includes('1st place') ||
    h4.includes('first place') ||
    h4.includes('final') ||
    h4.startsWith('champ') ||      // "Championship" (HoDown 2026), "Champs" (Vacationland 2026 Men)
    h4.includes('championship') || // "The Championship" (2026 NE Mixed Regionals) — was 'other'
    h4 === '1st' ||
    (h4 !== '' && h4 === h3);      // deciding game repeats its section label verbatim
  if (isChampSection && isChampRound) {
    return 'final';
  }

  // Placement finals: any "Nth Place" section, or a bare ordinal h4 round
  // ("3rd", "5th", "7th", "9th", "11th", …). These are the placement bracket's
  // deciding game. USAU also spells ordinals out ("Third Place", "Seventh
  // Place" — seen at PEC West 2026), so match word ordinals too.
  if (
    /\b\d+(st|nd|rd|th)\s+place\b/.test(t) ||  // "3rd place", "13th place"
    /\b(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fifteenth|seventeenth)\s+place\b/.test(t) ||
    /placement/.test(t) ||
    /^\d+(st|nd|rd|th)$/.test(h4)              // bare "3rd", "5th", "9th"
  ) {
    return 'placement';
  }

  // The deciding game of a NON-championship bracket section also repeats the
  // section label as its round (h4 === h3) even when the name carries no
  // ordinal ("Fiv-als" / "Ninals" — Portland Kleinman 2026). That's the
  // bracket's placement final; without this it filed as 'other' and vanished
  // from the placement view.
  if (h4 !== '' && h4 === h3) return 'placement';

  // Any other "final"-ish label not caught above.
  if (t.includes('final')) return 'final';

  return 'other';
}

function classifyStatus(raw: string | null): GameStatus {
  if (!raw) return 'scheduled';
  const t = raw.toLowerCase().trim();
  if (t.includes('final')) return 'final';
  if (t.includes('forfeit')) return 'forfeit';
  if (t.includes('cancel')) return 'cancelled';
  if (t.includes('progress') || t.includes('live')) return 'in_progress';
  return 'scheduled';
}

function parseScore(s: string | null): number | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

/** USAU's forfeit letters for one game ("W" and "F", one per side). Returns
 *  the winning side, or null when the pair isn't exactly one W and one F. */
function forfeitWinner(home: string | null, away: string | null): 'home' | 'away' | null {
  const h = (home ?? '').trim().toUpperCase();
  const a = (away ?? '').trim().toUpperCase();
  if (h === 'W' && a === 'F') return 'home';
  if (h === 'F' && a === 'W') return 'away';
  return null;
}

/** Postgres smallint range guard: anything outside it becomes null rather
 *  than a write error that would abort the whole page's sync. */
function smallintOrNull(n: number | null): number | null {
  return n != null && Number.isInteger(n) && n >= -32768 && n <= 32767 ? n : null;
}

/**
 * USAU renders an UNPLAYED game as "0 - 0" with a blank status. Stored
 * literally, every app surface read it as a decided 0-0 final (the 2026
 * Sectionals showed "FINAL 0-0" two days before they started). Store null
 * instead; a status that says the game is over keeps a literal 0-0 (double
 * forfeit), and an in-progress 0-0 is a real score.
 */
function unplayedScoresToNull(
  home: number | null,
  away: number | null,
  status: GameStatus,
): [number | null, number | null] {
  if (home === 0 && away === 0 && status === 'scheduled') return [null, null];
  return [home, away];
}

// ── Timezone handling ────────────────────────────────────────────────────────
// USAU prints all schedule times in the VENUE'S LOCAL zone, with no offset on
// the page. The runtime is UTC, so naively parsing "9:00 AM" yields 09:00Z =
// 3 AM local — wrong by the offset. We derive the venue zone from the event's
// US state and convert the local wall-clock time to the correct UTC instant
// (DST-aware via Intl — see _shared/tz.ts, shared with ingest-from-ultirzr).
// When the state/zone is unknown we DROP the time and keep date-only
// (midnight UTC) rather than store a wrong instant.

/**
 * Parse a bracket `.date` cell ("6/14/2026 9:00 AM" — local venue time) into a
 * correct UTC ISO using the event timezone. Falls back to date-only when the
 * time or zone is missing/unknown so we never store a wrong instant.
 *
 * USAU sometimes prints the WRONG year in these full dates (three 2023 college
 * women's events show 2020 — pages cloned from a cancelled season), so a year
 * that lands >60 days from the event start (`refDate`) is replaced the same way
 * year-less pool dates are (yearNearest).
 */
function parseSchedDate(s: string | null, tz: string | null, refDate: string | null): string | null {
  if (!s) return null;
  const t = s.trim();
  // "M/D/YYYY h:mm AM" (time optional)
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?$/i);
  if (!m) {
    // Unknown format — let JS try, but only keep the date (drop time-of-day).
    const d = new Date(t);
    if (isNaN(d.getTime())) return null;
    const mo = d.getUTCMonth() + 1;
    const dd = d.getUTCDate();
    return dateOnlyIso(sanitizeYear(d.getUTCFullYear(), mo, dd, refDate), mo, dd);
  }
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  const year = sanitizeYear(parseInt(m[3], 10), month, day, refDate);
  if (!m[4] || !tz) return dateOnlyIso(year, month, day);
  let h = parseInt(m[4], 10);
  const min = parseInt(m[5], 10);
  const ampm = m[6].toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return localWallTimeToUtcIso(year, month, day, h, min, tz) ?? dateOnlyIso(year, month, day);
}

/**
 * Pool game schedule cells: date like "Fri 5/22" (no year) + time "8:30 AM"
 * in the venue's local zone. Converts to a correct UTC instant via `tz`; falls
 * back to date-only when time/zone is missing.
 *
 * The year comes from the EVENT's start date (`refDate`): whichever of its
 * year ±1 lands the day closest to it, so a Dec→Jan event still resolves. It
 * used to be the current year, so every re-scrape of a past season stamped its
 * pool games a year (or more) late — ~9,000 games by 2026-09-28 (a Nov 2025
 * event's pool play read 2026-11-08). No refDate → current year.
 */
function combineDateTimeMaybe(
  dateText: string,
  timeText: string,
  tz: string | null,
  refDate: string | null,
): string | null {
  if (!dateText) return null;
  const md = dateText.match(/(\d{1,2})\/(\d{1,2})/);
  if (!md) return null;
  const month = parseInt(md[1], 10);
  const day = parseInt(md[2], 10);
  const year = yearNearest(month, day, refDate);
  const mt = timeText ? timeText.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i) : null;
  if (!mt || !tz) return dateOnlyIso(year, month, day);
  let h = parseInt(mt[1], 10);
  const min = parseInt(mt[2], 10);
  const ampm = mt[3].toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return localWallTimeToUtcIso(year, month, day, h, min, tz) ?? dateOnlyIso(year, month, day);
}

/** An explicit year, unless it puts M/D more than 60 days from `refDate` — then
 *  yearNearest's. No refDate → the year as printed. */
function sanitizeYear(year: number, month: number, day: number, refDate: string | null): number {
  const ref = refDate ? Date.parse(`${refDate}T00:00:00Z`) : NaN;
  if (!Number.isFinite(ref)) return year;
  if (Math.abs(Date.UTC(year, month - 1, day) - ref) <= 60 * 86_400_000) return year;
  const fixed = yearNearest(month, day, refDate);
  console.warn(`[sync-event-details] bracket date ${month}/${day}/${year} is far from event start ${refDate}; using ${fixed}`);
  return fixed;
}

/** The year for a year-less "M/D" that lands it closest to `refDate`
 *  (the event's start, "YYYY-MM-DD"). No refDate → the current year. */
function yearNearest(month: number, day: number, refDate: string | null): number {
  const ref = refDate ? Date.parse(`${refDate}T00:00:00Z`) : NaN;
  if (!Number.isFinite(ref)) return new Date().getUTCFullYear();
  const refYear = new Date(ref).getUTCFullYear();
  let best = refYear;
  let bestDist = Infinity;
  for (const y of [refYear - 1, refYear, refYear + 1]) {
    const d = Math.abs(Date.UTC(y, month - 1, day) - ref);
    if (d < bestDist) {
      best = y;
      bestDist = d;
    }
  }
  return best;
}

// ────────────────────────────────────────────────────────────
// Schedule page parser
// ────────────────────────────────────────────────────────────

interface ScheduleParse {
  teams: ParsedTeam[];
  poolPlacements: ParsedPoolRow[];
  games: ParsedGame[];
}

/** Does a tab/section label mark a PLACEMENT view? ("Ninth Place Pool",
 *  "Placement Brackets", "13th Place", …). USAU reuses generic pool markup
 *  ("Pool E") inside these tabs for Sunday placement round-robins — the tab
 *  label is the only thing that says what the pool actually decides. */
function isPlacementLabel(label: string | null): boolean {
  if (!label) return false;
  const t = label.toLowerCase();
  return (
    /placement/.test(t) ||
    /\b\d+(st|nd|rd|th)\s+place\b/.test(t) ||
    /\b(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fifteenth|seventeenth)\s+place\b/.test(t) ||
    // A tab that LEADS with a bare ordinal is a placement group even without
    // the word "Place" — Cooler Classic 37 Men's "21st (3 games each) - times
    // TBD" tab holds a "Pool B" round-robin deciding 21st. Leading-only so a
    // hypothetical "1st Round" pool tab can't misfile; USAU spells rounds
    // "Round 1"/"Sat Round 1".
    /^\s*\d+(st|nd|rd|th)\b/.test(t)
  );
}

function parseSchedule(html: string, tz: string | null, refDate: string | null): ScheduleParse {
  const $ = parseHtml(html);
  const teamsByEventTeamId = new Map<string, ParsedTeam>();
  const poolPlacements: ParsedPoolRow[] = [];
  const games: ParsedGame[] = [];

  // ── Tab → section labels ────────────────────────────────────────────────
  // The page is organized into view tabs ("Saturday Pool Play", "Seeding
  // Crossover", "… Championship", "Placement Brackets", "Ninth Place Pool").
  // Each tab <a rel="section_30654_1_20087"> points at a content container
  // <div id="section_30654_1_20087">. The label matters: a placement tab can
  // contain a generic "Pool E" round-robin whose real meaning ("Ninth Place
  // Pool") exists ONLY in the tab text — verified 2026-07-12, PEC West.
  const sectionLabels = new Map<string, string>();
  $('ul.tabs li a[rel]').each((_, a) => {
    const rel = $(a).attr('rel') ?? '';
    const m = rel.match(/^(section_\d+)/);
    if (m) sectionLabels.set(m[1], $(a).text().trim());
  });

  // Track the latest h3 (bracket section) and h4 (round) seen as we walk
  // the document in order. Bracket games inherit whichever heading was
  // most recently emitted before them. currentSection is the enclosing
  // tab's label (see above), reset at each section container.
  let currentH3: string | null = null;
  let currentH4: string | null = null;
  let currentSection: string | null = null;
  // Column position within the current bracket section. USAU emits a
  // section's `div.bracket_col`s in FINAL-FIRST document order (verified on
  // 18 sections across Rocky Mountain Sectionals + Ski Town Classic 2026),
  // so the first column (index 0) is the section's deciding game and each
  // later column feeds the one before it. -1 = no column seen yet.
  let currentStageIndex = -1;

  // The schedule page mixes pool tables and brackets. Walk the document
  // in document order so we associate each piece with its heading.
  $('h1, h3, h4, table.global_table, div.bracket_col, div.bracket_game, div[id^="section_"]').each((_, el) => {
    const $el = $(el);
    const tag = el.type === 'tag' ? (el as { name: string }).name : '';
    const elId = $el.attr('id') ?? '';

    // Section container — a new tab's content begins; headings don't carry
    // across tabs.
    if (tag === 'div' && elId.startsWith('section_')) {
      const m = elId.match(/^(section_\d+)/);
      currentSection = (m && sectionLabels.get(m[1])) || null;
      currentH3 = null;
      currentH4 = null;
      currentStageIndex = -1;
      return;
    }

    if (tag === 'h3') {
      currentH3 = $el.text().trim();
      currentH4 = null;
      currentStageIndex = -1;
      return;
    }

    // A bracket column opens: advance the stage index. Its h4 follows in
    // document order and sets currentH4 as before.
    if (tag === 'div' && $el.hasClass('bracket_col')) {
      currentStageIndex += 1;
      return;
    }
    if (tag === 'h4') {
      currentH4 = $el.text().trim();
      return;
    }

    if (tag === 'table') {
      // The schedule page has two table shapes:
      //
      //   1. Pool standings — class="global_table", under an <h3>Pool X</h3>.
      //      3 cols: team link, W-L, tiebreak.
      //   2. Pool games — class="global_table scores_table", with the pool
      //      name in a <thead><tr><th colspan="8">Pool A Schedule & Scores</th>
      //      (no separate <h3>). 8 cols: Date, Time, Field, Team 1, Team 2,
      //      Score, Status, Options.
      //
      // Discriminate by class. Standings tables come after a Pool X <h3>,
      // schedule tables carry their pool name in the table thead.
      const classAttr = ($el.attr('class') ?? '').toLowerCase();
      const isScheduleTable = classAttr.includes('scores_table');

      if (!isScheduleTable) {
        if (!currentH3 || !/^pool\b/i.test(currentH3)) return;
        const poolName = currentH3.trim();
        // A standings table inside a PLACEMENT tab ("Pool E" under "Ninth
        // Place Pool") is a Sunday placement round-robin, not the team's
        // Saturday pool — don't (re)assign pools from it.
        const placementSection = isPlacementLabel(currentSection);
        // === Standings table (existing logic) ===
        $el.find('tr').each((__, tr) => {
          const $tr = $(tr);
          const $cells = $tr.children('td');
          if ($cells.length === 0) return; // header row
          const $teamLink = $cells.eq(0).find('a').first();
          const href = $teamLink.attr('href') ?? '';
          const eventTeamId = extractEventTeamId(href);
          if (!eventTeamId) return;

          const { name, seed } = extractTeamNameAndSeed($teamLink.text());
          if (!teamsByEventTeamId.has(eventTeamId)) {
            teamsByEventTeamId.set(eventTeamId, { eventTeamId, displayName: name, seed });
          }
          if (placementSection) return; // teams collected, pool NOT assigned

          // W-L cell formatted "3 - 0"
          const wlText = $cells.eq(1).text().trim();
          const wlMatch = wlText.match(/^(\d+)\s*[-–]\s*(\d+)$/);
          poolPlacements.push({
            poolName,
            eventTeamId,
            wins: wlMatch ? parseInt(wlMatch[1], 10) : null,
            losses: wlMatch ? parseInt(wlMatch[2], 10) : null,
          });
        });
      } else {
        // === Pool games table ===
        // Structure (verified 2026-05-25 against D-I Championships):
        //   <table class="global_table scores_table">
        //     <thead><tr><th colspan="8">Pool A Schedule & Scores</th></tr></thead>
        //     <tbody>
        //       <tr> ...column headers (Date/Time/Field/Team 1/Team 2/Score/Status/Options)...
        //       <tr data-game="404957"> ...8 td cells per game row...
        //     </tbody>
        //   </table>
        //
        // Pool name comes from the thead colspan caption, NOT from a
        // preceding <h3> (all schedule tables sit after the last pool
        // standings heading on this page).
        //
        // Classification (verified 2026-07-12, PEC West):
        //   • "Pool A Schedule & Scores" in a normal tab → a real pool.
        //   • "Pool E Schedule & Scores" inside a PLACEMENT tab ("Ninth
        //     Place Pool") → a Sunday placement round-robin. USAU reuses
        //     generic pool markup; the tab label is the truth. Stored as
        //     round='placement' under the tab's name so the app shows it
        //     with the placement brackets, not as a phantom Saturday pool.
        //   • "Seeding Crossover Schedule & Scores" → crossover rows
        //     (round='other'); previously these were dropped entirely.
        const captionText = $el.find('thead th[colspan]').first().text().trim();
        const captionBase = captionText.replace(/\s*Schedule\s*&\s*Scores\s*$/i, '').trim();
        if (!captionBase) return; // unrecognized table shape
        const isPoolCaption = /^pool\s+\S+/i.test(captionBase);
        const isCrossoverCaption = /crossover/i.test(captionBase) || /crossover/i.test(currentSection ?? '');
        const placementTable = isPlacementLabel(currentSection) || isPlacementLabel(captionBase);

        let tableRound: GameRound;
        let poolName: string;
        if (isCrossoverCaption) {
          tableRound = 'other';
          poolName = captionBase;
        } else if (placementTable) {
          tableRound = 'placement';
          // Prefer the tab label ("Ninth Place Pool") over a generic caption
          // ("Pool E"); fall back to the caption when the tab is unnamed.
          poolName = isPlacementLabel(currentSection) ? (currentSection as string) : captionBase;
        } else if (isPoolCaption) {
          tableRound = 'pool';
          poolName = captionBase;
        } else {
          // Matchup-round tables with neither a pool nor a placement label —
          // Cooler Classic 37 Men runs tabs "Sat Round 1/2/3" whose tables are
          // captioned "Sat 10am Match" etc. These are real games; returning
          // here (the old behavior) dropped them AND the teams they carry,
          // which zeroed the whole division (persistSchedulePage skips a page
          // with no teams). Store as round='other' named by the TAB (the
          // organizing unit the USAU page shows), caption as fallback. Rows
          // without both team links still skip below, so a genuinely unknown
          // table shape contributes nothing.
          tableRound = 'other';
          poolName = currentSection?.trim() || captionBase;
        }

        $el.find('tbody tr').each((__, tr) => {
          const $tr = $(tr);
          const $cells = $tr.children('td');
          if ($cells.length < 7) return; // column header row (uses <th>) or malformed

          const dateText = $cells.eq(0).text().trim();
          const timeText = $cells.eq(1).text().trim();
          const fieldText = $cells.eq(2).text().trim();

          const $homeLink = $cells.eq(3).find('a').first();
          const $awayLink = $cells.eq(4).find('a').first();
          const homeEventTeamId = extractEventTeamId($homeLink.attr('href') ?? '');
          const awayEventTeamId = extractEventTeamId($awayLink.attr('href') ?? '');
          if (!homeEventTeamId || !awayEventTeamId) return; // TBD slot

          const home = extractTeamNameAndSeed($homeLink.text());
          const away = extractTeamNameAndSeed($awayLink.text());

          // Collect teams (don't overwrite existing entries since the
          // standings table is parsed first with the same data).
          if (!teamsByEventTeamId.has(homeEventTeamId)) {
            teamsByEventTeamId.set(homeEventTeamId, {
              eventTeamId: homeEventTeamId,
              displayName: home.name,
              seed: home.seed,
            });
          }
          if (!teamsByEventTeamId.has(awayEventTeamId)) {
            teamsByEventTeamId.set(awayEventTeamId, {
              eventTeamId: awayEventTeamId,
              displayName: away.name,
              seed: away.seed,
            });
          }

          // Score: "15 - 11" → 15, 11. Empty/blank when not yet played.
          const scoreText = $cells.eq(5).text().trim();
          const scoreMatch = scoreText.match(/^(\d+)\s*[-–]\s*(\d+)$/);
          const letterMatch = scoreText.match(/^([A-Za-z])\s*[-–]\s*([A-Za-z])$/);
          const forfeit_winner = letterMatch ? forfeitWinner(letterMatch[1], letterMatch[2]) : null;
          const rawStatus = $cells.eq(6).text().trim() || null;
          // A forfeit is decided even if USAU left the status cell blank.
          const status = forfeit_winner && classifyStatus(rawStatus) === 'scheduled'
            ? 'final'
            : classifyStatus(rawStatus);
          const [scoreHome, scoreAway] = unplayedScoresToNull(
            scoreMatch ? parseInt(scoreMatch[1], 10) : null,
            scoreMatch ? parseInt(scoreMatch[2], 10) : null,
            status,
          );

          // Prefer the data-game attribute on the row (numeric internal
          // game id). Fall back to parsing the match-report link's
          // EventGameId param in the Options cell.
          const dataGame = $tr.attr('data-game')?.trim() ?? '';
          const $matchLink = $cells.find('a[href*="match_report"]').first();
          const usau_event_game_id =
            dataGame ||
            extractEventGameId($matchLink.attr('href') ?? '');

          const scheduled_at = combineDateTimeMaybe(dateText, timeText, tz, refDate);

          games.push({
            usau_game_id: null,
            usau_event_game_id,
            round: tableRound,
            bracket_name: poolName,
            home_event_team_id: homeEventTeamId,
            away_event_team_id: awayEventTeamId,
            home_seed: home.seed,
            away_seed: away.seed,
            score_home: scoreHome,
            score_away: scoreAway,
            location: fieldText || null,
            scheduled_at,
            status,
            forfeit_winner,
            // Pool rows always have both teams — no placeholder text exists.
            home_placeholder: null,
            away_placeholder: null,
            bracket_stage: null,
            bracket_stage_index: null,
            bracket_slot: null,
            next_usau_game_id: null,
            next_slot_side: null,
          });
        });
      }
      return;
    }

    if (tag === 'div') {
      // bracket_game
      const $game = $el;
      const id = $game.attr('id') ?? '';
      const usau_game_id = id.startsWith('game') ? id.slice(4) : id || null;

      const $matchLink = $game.find(SELECTORS.schedule.bracketGameId).first();
      const usau_event_game_id = extractEventGameId($matchLink.attr('href') ?? '');

      const $homeA = $game.find(SELECTORS.schedule.bracketHomeTeam).first();
      const $awayA = $game.find(SELECTORS.schedule.bracketAwayTeam).first();
      const homeEventTeamId = extractEventTeamId($homeA.attr('href') ?? '');
      const awayEventTeamId = extractEventTeamId($awayA.attr('href') ?? '');
      // TBD slots ("W of Semifinals G2") have no team link. Keep the game
      // anyway when it has a stable id — dropping it made finals/placement
      // finals invisible until both feeders finished, and an event that
      // stopped being re-scraped (outside the live window) lost its final
      // forever. A TBD side is stored as a null team id; the next scrape
      // after the feeder finishes fills it in via the same usau_game_id
      // upsert. Games with NO id and any TBD side are still skipped — we
      // have no safe dedupe key for those.
      if ((!homeEventTeamId || !awayEventTeamId) && !usau_game_id) return;

      const home = extractTeamNameAndSeed($homeA.text());
      const away = extractTeamNameAndSeed($awayA.text());
      if (homeEventTeamId && !teamsByEventTeamId.has(homeEventTeamId)) {
        teamsByEventTeamId.set(homeEventTeamId, {
          eventTeamId: homeEventTeamId,
          displayName: home.name,
          seed: home.seed,
        });
      }
      if (awayEventTeamId && !teamsByEventTeamId.has(awayEventTeamId)) {
        teamsByEventTeamId.set(awayEventTeamId, {
          eventTeamId: awayEventTeamId,
          displayName: away.name,
          seed: away.seed,
        });
      }

      const location = $game.find(SELECTORS.schedule.bracketLocation).first().text().trim() || null;
      const rawStatus = $game.find(SELECTORS.schedule.bracketStatus).first().text().trim() || null;
      const homeScoreText = $game.find(SELECTORS.schedule.bracketHomeScore).first().text();
      const awayScoreText = $game.find(SELECTORS.schedule.bracketAwayScore).first().text();
      const forfeit_winner = forfeitWinner(homeScoreText, awayScoreText);
      // A forfeit is decided even if USAU left the status cell blank.
      const status = forfeit_winner && classifyStatus(rawStatus) === 'scheduled'
        ? 'final'
        : classifyStatus(rawStatus);
      const [scoreHome, scoreAway] = unplayedScoresToNull(
        parseScore(homeScoreText),
        parseScore(awayScoreText),
        status,
      );
      const rawDate = $game.find(SELECTORS.schedule.bracketDate).first().text().trim() || null;

      // A TBD side has no team link — the span's plain text is USAU's own
      // placeholder ("P1 of Saturday Pool Play Pool A", "W of Quarterfinals
      // G1"). Captured only when the side is unlinked; a seeded side stores
      // null, so the next scrape clears stale text as slots fill.
      const homePlaceholder = homeEventTeamId
        ? null
        : $game.find('[data-type="game-team-home"]').first().text().trim() || null;
      const awayPlaceholder = awayEventTeamId
        ? null
        : $game.find('[data-type="game-team-away"]').first().text().trim() || null;

      // Structure. `data-index` is USAU's sheet slot (the "G<n>" label text
      // is the same number); byes leave gaps, so a quarters column can hold
      // G2 and G3 only. `data-relation="game<id>"` names the game this one's
      // winner feeds and the top_game / btm_game class says which side.
      // Both land in smallint columns; an out-of-range value would throw on
      // write and abort the whole page's sync, so degrade to "no slot".
      const slotAttr = parseInt($game.attr('data-index') ?? '', 10);
      const labelMatch = $matchLink.text().trim().match(/^G\s*(\d+)$/i);
      const bracketSlot = smallintOrNull(
        Number.isFinite(slotAttr) ? slotAttr : labelMatch ? parseInt(labelMatch[1], 10) : null,
      );
      const relation = ($game.attr('data-relation') ?? '').trim();
      const nextUsauGameId = relation.startsWith('game') ? relation.slice(4) : relation || null;
      const nextSlotSide: 'top' | 'btm' | null = $game.hasClass('top_game')
        ? 'top'
        : $game.hasClass('btm_game')
          ? 'btm'
          : null;

      games.push({
        usau_game_id,
        usau_event_game_id,
        round: classifyRound(currentH4, currentH3),
        bracket_name: currentH3,
        bracket_stage: currentH4,
        bracket_stage_index: smallintOrNull(currentStageIndex >= 0 ? currentStageIndex : null),
        bracket_slot: bracketSlot,
        next_usau_game_id: nextUsauGameId,
        next_slot_side: nextSlotSide,
        home_event_team_id: homeEventTeamId,
        away_event_team_id: awayEventTeamId,
        home_seed: home.seed,
        away_seed: away.seed,
        score_home: scoreHome,
        score_away: scoreAway,
        location,
        scheduled_at: parseSchedDate(rawDate, tz, refDate),
        status,
        forfeit_winner,
        home_placeholder: homePlaceholder,
        away_placeholder: awayPlaceholder,
      });
    }
  });

  return {
    teams: Array.from(teamsByEventTeamId.values()),
    poolPlacements,
    games,
  };
}

// ────────────────────────────────────────────────────────────
// Upserts
// ────────────────────────────────────────────────────────────

/**
 * Look up or create a usau_teams row for an EventTeamId. The team's
 * usau_event_team_ids array accumulates every per-event ID we've ever
 * seen so the same physical squad at multiple events maps to one row.
 *
 * IDENTITY GRAIN IS THE TEAM-SEASON — (name, gender, level, season).
 *
 * This used to be scoped to a single EVENT: "Revolver at 2024 Pro Champs and
 * Revolver at 2025 Pro Champs will be two rows for now." That was accepted as a
 * v1 simplification, but it also meant Revolver at THREE 2025 events became
 * three rows in the SAME season — splitting one squad's games, roster and
 * profile. By 2026-08-05 that had produced 1,505 duplicate groups / 2,428
 * redundant rows, cleaned up by
 * supabase/migrations/20260805000000_merge_duplicate_usau_teams.sql.
 *
 * So the same-name match now spans the event's whole SEASON, not just the
 * event. Season is the right grain and NOT wider:
 *   - Wider (all-time) is WRONG: rosters turn over, and one row per team-season
 *     is deliberate — 96.7% of same-name rows are single-season by design.
 *   - Narrower (per-event) is what caused the duplicates.
 *
 * Safe because USAU name+division is unique within a season's event set, with
 * one measured exception: A/B squads entering the SAME event (4 pairs in the
 * whole DB, all 2014 sectionals — KOD, PleasureTown, BirdFruit). Those are
 * preserved by preferring a same-event match first and only then falling back
 * to the season, so a genuine A/B pair keeps its two rows.
 *
 * Teams ingested via ultirzr carry a persistent usau_team_id (UNIQUE), so they
 * can never duplicate; only this HTML path, which has no persistent id, can.
 */
async function resolveTeam(
  db: ReturnType<typeof supabase>,
  eventUUID: string,
  team: ParsedTeam,
  competitionLevel: CompetitionLevel,
  genderDivision: Division,
): Promise<string> {
  // Has any team row already claimed this EventTeamId?
  const { data: existing, error: lookupErr } = await db
    .from('usau_teams')
    .select('id')
    .contains('usau_event_team_ids', [team.eventTeamId])
    .maybeSingle();
  if (lookupErr && lookupErr.code !== 'PGRST116') throw lookupErr;
  if (existing) return existing.id;

  // Known USAU spellings of an existing team ("Rhino" for "Rhino Slam!") map to
  // its canonical name (usau_team_name_aliases). The usau_teams trigger applies
  // the same mapping on insert, so the lookup below must use it too, or a
  // variant would miss the season's row and insert a duplicate.
  const { data: canonicalName, error: canonErr } = await db.rpc('usau_canonical_team_name', {
    p_name: team.displayName,
    p_division: genderDivision,
    p_level: competitionLevel,
  });
  if (canonErr) throw canonErr;
  const teamName = (canonicalName as string | null) ?? team.displayName;

  // Not seen by id — is this squad already in the DB for this SEASON under a
  // different EventTeamId? Two ways that happens: USAU churns the id mid-event
  // (late re-registration / re-seed), or the same club simply entered another
  // event in the same season.
  //
  // Try THIS EVENT first, then the rest of the season. Ordering matters: it
  // keeps a real A/B pair — two squads sharing a name at ONE event — matching
  // their own row rather than collapsing into whichever the season query
  // happened to return first.
  const TEAM_SELECT =
    'team_id, usau_teams!inner(id, name, gender_division, competition_level, usau_event_team_ids)';
  const nameFilters = (q: ReturnType<typeof db.from>) =>
    q
      .eq('usau_teams.name', teamName)
      .eq('usau_teams.gender_division', genderDivision)
      .eq('usau_teams.competition_level', competitionLevel);

  const runMatch = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    build: (q: any) => any,
  ) => {
    const { data, error } = await build(
      nameFilters(db.from('usau_event_teams').select(TEAM_SELECT)),
    )
      .limit(1)
      .maybeSingle();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sameEvent = await runMatch((q: any) => q.eq('event_id', eventUUID));

  if (!sameEvent) {
    // Widen to the season. Filter through the JOINED event row rather than
    // passing a list of event ids — 2026 alone has 511 events, so an .in()
    // list would both blow up the PostgREST URL and (if capped) silently miss
    // peers, re-creating the very duplicates this is meant to prevent.
    const { data: ev } = await db
      .from('usau_events')
      .select('season')
      .eq('id', eventUUID)
      .maybeSingle();
    const season = (ev as { season?: number } | null)?.season;
    if (season != null) {
      sameEvent = await runMatch(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (q: any) =>
          q
            .select(`${TEAM_SELECT}, usau_events!inner(season)`)
            .eq('usau_events.season', season)
            .neq('event_id', eventUUID),
      );
    }
  }

  if (sameEvent) {
    const matched = sameEvent.usau_teams as unknown as {
      id: string;
      usau_event_team_ids: string[] | null;
    };
    const ids = matched.usau_event_team_ids ?? [];
    if (!ids.includes(team.eventTeamId)) {
      const { error: appendErr } = await db
        .from('usau_teams')
        .update({
          usau_event_team_ids: [...ids, team.eventTeamId],
          last_scraped_at: new Date().toISOString(),
        })
        .eq('id', matched.id);
      if (appendErr) throw appendErr;
    }
    return matched.id;
  }

  const { data: created, error: insertErr } = await db
    .from('usau_teams')
    .insert({
      name: teamName,
      usau_event_team_ids: [team.eventTeamId],
      competition_level: competitionLevel,
      gender_division: genderDivision,
      last_scraped_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (insertErr) throw insertErr;
  return created.id;
}

async function ensureEvent(
  db: ReturnType<typeof supabase>,
  slug: string,
): Promise<string> {
  const { data: existing } = await db
    .from('usau_events')
    .select('id')
    .eq('usau_slug', slug)
    .maybeSingle();
  if (existing) return existing.id;

  // Stub the event row from the slug. We don't know dates/city/etc. yet —
  // sync-events will fill those in later if the event ever appears on the
  // tournament calendar. Season defaults to the year embedded in the slug.
  const yearMatch = slug.match(/^(\d{4})-/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getUTCFullYear();

  // Make sure the season row exists (FK target).
  await db.from('usau_seasons').upsert({ year }, { onConflict: 'year', ignoreDuplicates: true });

  const { data: created, error } = await db
    .from('usau_events')
    .insert({
      usau_slug: slug,
      name: slug.replace(/-/g, ' '),
      season: year,
      url: `${BASE_URL}/events/${slug}/`,
      last_scraped_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw error;
  return created.id;
}

// ────────────────────────────────────────────────────────────
// Per-division sync
// ────────────────────────────────────────────────────────────

/** Competition levels this scraper handles. Masters-family levels use the
 *  hyphenated masters URL segments; club/college use their own. */
type CompetitionLevel =
  | 'CLUB'
  | 'COLLEGE_D1'
  | 'COLLEGE_D3'
  | 'MASTERS'
  | 'GRAND_MASTERS'
  | 'GREAT_GRAND_MASTERS';

/** One schedule-page family member to try: the URL segment to fetch and the
 *  competition level to TAG the teams found there with. A single event slug can
 *  host several (the combined Masters Championships runs Masters + Grand Masters
 *  + Great Grand Masters under one slug), so each resolving segment tags its own
 *  teams — this is why a GM team at the combined event gets GRAND_MASTERS, not
 *  the event's coarse level. Mirrors resolve-event-team-urls' family iteration. */
interface LevelSegment {
  segment: ScheduleUrlLevel;
  teamLevel: CompetitionLevel;
}

function scheduleLevelSegments(
  slug: string,
  competitionLevel: CompetitionLevel,
): LevelSegment[] {
  const isMasters =
    competitionLevel === 'MASTERS' ||
    competitionLevel === 'GRAND_MASTERS' ||
    competitionLevel === 'GREAT_GRAND_MASTERS';
  if (!isMasters) {
    const segment: ScheduleUrlLevel = competitionLevel.startsWith('COLLEGE')
      ? 'College'
      : 'Club';
    return [{ segment, teamLevel: competitionLevel }];
  }
  // Masters family: a combined championships hosts all three, so try the whole
  // family and tag per-segment. Order by what the slug hints at so a
  // single-division regional usually hits on the first fetch.
  const all: LevelSegment[] = [
    { segment: 'Masters', teamLevel: 'MASTERS' },
    { segment: 'Grand-Masters', teamLevel: 'GRAND_MASTERS' },
    { segment: 'Great-Grand-Masters', teamLevel: 'GREAT_GRAND_MASTERS' },
  ];
  const s = slug.toLowerCase();
  const priority = s.includes('great-grand')
    ? 'GREAT_GRAND_MASTERS'
    : s.includes('grand')
      ? 'GRAND_MASTERS'
      : 'MASTERS';
  return all.sort((a, b) =>
    a.teamLevel === priority ? -1 : b.teamLevel === priority ? 1 : 0,
  );
}

async function syncDivision(
  db: ReturnType<typeof supabase>,
  eventUUID: string,
  slug: string,
  division: Division,
  competitionLevel: CompetitionLevel,
  tz: string | null,
  refDate: string | null,
): Promise<{
  teams: number;
  games: number;
  skipped: boolean;
}> {
  // USAU's URL carries the competition level in the path — "Club", "College",
  // or one of the masters segments ("Masters"/"Grand-Masters"/…). A masters
  // event can host MULTIPLE segments under one slug (the combined
  // championships), so we try the whole level family for this gender and
  // persist each page that resolves, tagging its teams with THAT segment's
  // level. Club/college resolve to a single segment.
  const segments = scheduleLevelSegments(slug, competitionLevel);
  let totalTeams = 0;
  let totalGames = 0;
  let anyResolved = false;

  for (const { segment, teamLevel } of segments) {
    let html: string | null = null;
    let url = '';
    // College championship pages use a compact "CollegeMen" form (no hyphen)
    // alongside the older "College-Men"; eventScheduleUrlVariants emits both.
    for (const candidate of eventScheduleUrlVariants(slug, division, segment)) {
      try {
        html = await fetchHtml(candidate);
        url = candidate;
        break;
      } catch (err) {
        const message = formatErr(err);
        if (/HTTP 404/.test(message) || /404 /.test(message)) {
          continue;
        }
        throw err;
      }
    }
    if (!html) {
      // This segment isn't part of the event for this gender — try the next
      // family member (or, for club/college, we're simply done).
      continue;
    }

    const res = await persistSchedulePage(
      db,
      eventUUID,
      division,
      teamLevel,
      html,
      url,
      tz,
      refDate,
    );
    if (res.skipped) continue;
    anyResolved = true;
    totalTeams += res.teams;
    totalGames += res.games;
  }

  if (!anyResolved) {
    // No family segment yielded a populated page for this gender.
    return { teams: 0, games: 0, skipped: true };
  }
  return { teams: totalTeams, games: totalGames, skipped: false };
}

/** Persist ONE resolved schedule page: parse teams/pools/games, resolve every
 *  team to a usau_teams uuid (tagging new teams with `teamLevel`), then upsert
 *  participations + games. Split out of syncDivision so a masters event can run
 *  it once per resolving level segment. */
async function persistSchedulePage(
  db: ReturnType<typeof supabase>,
  eventUUID: string,
  division: Division,
  competitionLevel: CompetitionLevel,
  html: string,
  url: string,
  tz: string | null,
  refDate: string | null,
): Promise<{ teams: number; games: number; skipped: boolean }> {
  const { teams, poolPlacements, games } = parseSchedule(html, tz, refDate);
  if (teams.length === 0) {
    // Page exists but has no parseable teams — could mean draft schedule,
    // selector drift, or genuinely empty. Don't write anything; let the
    // caller see the zero count.
    return { teams: 0, games: 0, skipped: true };
  }

  // Resolve every EventTeamId to a usau_teams uuid.
  const teamUUIDByEventTeamId = new Map<string, string>();
  for (const t of teams) {
    try {
      const id = await resolveTeam(db, eventUUID, t, competitionLevel, division);
      teamUUIDByEventTeamId.set(t.eventTeamId, id);
    } catch (err) {
      throw new Error(`resolveTeam failed for ${t.displayName}: ${stringifyErr(err)}`);
    }
  }

  // Per-event participation. Aggregate seed from teams[] + pool from
  // poolPlacements so each team gets one row even if the seed and pool
  // info come from different sources.
  const seedByTeam = new Map<string, number | null>();
  for (const t of teams) seedByTeam.set(t.eventTeamId, t.seed);
  const poolByTeam = new Map<string, string>();
  for (const p of poolPlacements) {
    if (!poolByTeam.has(p.eventTeamId)) poolByTeam.set(p.eventTeamId, p.poolName);
  }

  const eventTeamRows = teams.map((t) => ({
    event_id: eventUUID,
    team_id: teamUUIDByEventTeamId.get(t.eventTeamId)!,
    usau_event_team_id: t.eventTeamId,
    seed: seedByTeam.get(t.eventTeamId) ?? null,
    pool: poolByTeam.get(t.eventTeamId) ?? null,
  }));

  // usau_event_teams has a composite PK (event_id, team_id). Use that
  // for ON CONFLICT — the `usau_event_team_id` column has a regular
  // (non-unique) index so it can't be used as a conflict target.
  const { error: etErr } = await db
    .from('usau_event_teams')
    .upsert(eventTeamRows, { onConflict: 'event_id,team_id', ignoreDuplicates: false });
  if (etErr) throw new Error(`usau_event_teams upsert: ${stringifyErr(etErr)}`);

  // Games. Every game is written through ONE natural-key-aware path so the
  // same physical game can never be doubled — even across the two ingest
  // pipelines (this HTML scraper vs ingest-from-ultirzr), which assign the SAME
  // game DIFFERENT usau_game_id / usau_event_game_id / round labels.
  //
  // Match an existing row by, in priority:
  //   1. usau_game_id (this pipeline's stable USAU id — exact idempotent re-run)
  //   2. usau_event_game_id (per-match-report id, unique per pipeline)
  //   3. the NATURAL KEY (event, both teams order-independent, scheduled_at,
  //      bracket_name) — the DB's `usau_games_natural_key_uidx` guard. This is
  //      what catches the OTHER pipeline's copy, which shares none of our ids.
  // Found → UPDATE in place (merging any ids we now have); else INSERT. This
  // both keeps re-runs idempotent AND respects the unique index (an id-keyed
  // upsert would try to INSERT the cross-pipeline copy and hit the index).
  for (const g of games) {
    const teamA =
      (g.home_event_team_id && teamUUIDByEventTeamId.get(g.home_event_team_id)) || null;
    const teamB =
      (g.away_event_team_id && teamUUIDByEventTeamId.get(g.away_event_team_id)) || null;

    let existing: { id: string } | null = null;

    if (g.usau_game_id) {
      const { data } = await db
        .from('usau_games')
        .select('id')
        .eq('usau_game_id', g.usau_game_id)
        .maybeSingle();
      existing = data ?? null;
    }
    if (!existing && g.usau_event_game_id) {
      const { data } = await db
        .from('usau_games')
        .select('id')
        .eq('usau_event_game_id', g.usau_event_game_id)
        .maybeSingle();
      existing = data ?? null;
    }
    // Natural-key match — only when the row has the full key (both teams + a
    // scheduled time). TBD feeder slots (a null team) and undated games can't
    // be natural-keyed; they rely on an id match above or insert fresh.
    if (!existing && teamA && teamB && g.scheduled_at) {
      // Order-independent team match: the game may be stored with a/b swapped
      // by the other pipeline. Both scores flip WITH their team on update, so
      // whichever orientation wins stays internally consistent.
      const [lo, hi] = teamA < teamB ? [teamA, teamB] : [teamB, teamA];
      const { data } = await db
        .from('usau_games')
        .select('id')
        .eq('event_id', eventUUID)
        .eq('scheduled_at', g.scheduled_at)
        .eq('bracket_name', g.bracket_name ?? '')
        .or(
          `and(team_a_id.eq.${lo},team_b_id.eq.${hi}),and(team_a_id.eq.${hi},team_b_id.eq.${lo})`,
        )
        .maybeSingle();
      existing = data ? { id: data.id } : null;
    }

    const row: Record<string, unknown> = {
      event_id: eventUUID,
      round: g.round,
      bracket_name: g.bracket_name,
      team_a_id: teamA,
      team_b_id: teamB,
      seed_a: g.home_seed,
      seed_b: g.away_seed,
      score_a: g.score_home,
      score_b: g.score_away,
      location: g.location,
      scheduled_at: g.scheduled_at,
      status: g.status,
      // The resolved team, not a side, so it survives either a/b orientation.
      // Written on every row so a re-scrape clears a stale value.
      winner_team_id:
        g.forfeit_winner === 'home' ? teamA : g.forfeit_winner === 'away' ? teamB : null,
      source_url: url,
      team_a_placeholder: g.home_placeholder,
      team_b_placeholder: g.away_placeholder,
      // Written unconditionally so a re-scrape clears stale structure when
      // USAU redraws a bracket.
      bracket_stage: g.bracket_stage,
      bracket_stage_index: g.bracket_stage_index,
      bracket_slot: g.bracket_slot,
      next_usau_game_id: g.next_usau_game_id,
      next_slot_side: g.next_slot_side,
    };
    // Only set an id column when we actually have one, so an UPDATE that
    // reconciled the OTHER pipeline's row doesn't null out its id.
    if (g.usau_game_id) row.usau_game_id = g.usau_game_id;
    if (g.usau_event_game_id) row.usau_event_game_id = g.usau_event_game_id;

    // Natural-key collision (23505 on usau_games_natural_key_uidx) during a
    // write means the same physical game already exists on ANOTHER row — USAU
    // re-created the game under a new id, or a game we matched by id moved to
    // a (teams, time, bracket) slot the other pipeline's copy already occupies.
    // One stuck game must not abort the whole event sync (Kentucky Fried
    // Classic 2026 froze for 24h+ exactly this way): merge instead — keep the
    // row that owns the natural key, delete the stale duplicate, retry.
    const findNaturalKeyDup = async (excludeId: string | null) => {
      if (!teamA || !teamB || !g.scheduled_at) return null;
      const [lo, hi] = teamA < teamB ? [teamA, teamB] : [teamB, teamA];
      let q = db
        .from('usau_games')
        .select('id')
        .eq('event_id', eventUUID)
        .eq('scheduled_at', g.scheduled_at)
        .eq('bracket_name', g.bracket_name ?? '')
        .or(
          `and(team_a_id.eq.${lo},team_b_id.eq.${hi}),and(team_a_id.eq.${hi},team_b_id.eq.${lo})`,
        );
      if (excludeId) q = q.neq('id', excludeId);
      const { data } = await q.limit(1).maybeSingle();
      return data ? { id: data.id } : null;
    };
    const isNaturalKeyConflict = (error: { code?: string; message?: string } | null) =>
      !!error && error.code === '23505' && (error.message ?? '').includes('usau_games_natural_key_uidx');

    if (existing) {
      const { error } = await db.from('usau_games').update(row).eq('id', existing.id);
      if (error) {
        if (!isNaturalKeyConflict(error)) {
          throw new Error(`usau_games update: ${stringifyErr(error)}`);
        }
        // Our id-matched row carries the CURRENT usau ids; the row squatting on
        // the natural key is the stale copy. Drop it, retry the update.
        const dup = await findNaturalKeyDup(existing.id);
        if (!dup) throw new Error(`usau_games update: ${stringifyErr(error)}`);
        const { error: delErr } = await db.from('usau_games').delete().eq('id', dup.id);
        if (delErr) throw new Error(`usau_games dedupe delete: ${stringifyErr(delErr)}`);
        const { error: retryErr } = await db.from('usau_games').update(row).eq('id', existing.id);
        if (retryErr) throw new Error(`usau_games update (post-dedupe): ${stringifyErr(retryErr)}`);
      }
    } else {
      const { error } = await db.from('usau_games').insert(row);
      if (error) {
        if (!isNaturalKeyConflict(error)) {
          throw new Error(`usau_games insert: ${stringifyErr(error)}`);
        }
        // Row already exists under the natural key (raced/other pipeline) —
        // update that row in place instead.
        const dup = await findNaturalKeyDup(null);
        if (!dup) throw new Error(`usau_games insert: ${stringifyErr(error)}`);
        const { error: updErr } = await db.from('usau_games').update(row).eq('id', dup.id);
        if (updErr) throw new Error(`usau_games insert-merge: ${stringifyErr(updErr)}`);
      }
    }
  }

  // ── Prune abandoned schedule generations (2026-08-26, NW Fruit Bowl) ──
  // USAU can auto-publish a full round-robin, then the TD replaces it with
  // the real schedule under NEW EventGameIds. The upsert path above keys on
  // usau_event_game_id and never removed rows whose id vanished from the
  // page, so the abandoned 55-game generation lived on beside the real 18
  // (2x+ pool games, teams double-booked at 3 AM; ~18 events in 2026 share
  // the signature). Delete only rows that are provably that stale class:
  //   - this event + THIS page (source_url is the division scope —
  //     usau_games has no gender column),
  //   - carrying an event-game id the page no longer shows,
  //   - never touched by a result (scheduled, no score) — played/final rows are
  //     kept, protecting the "USAU hides pool tables once brackets start"
  //     case, where vanishing from the page is normal.
  // The teams.length===0 early-return above means a page that parsed nothing
  // never reaches this, so selector drift can't mass-delete.
  //
  // An id carrying `"` or `\` would break out of PostgREST's quoted in-list and
  // unprotect the ids after it, so such a page skips the prune (dropping just
  // that id would unprotect it instead).
  const quotedList = (ids: string[]): string | null =>
    ids.some((id) => /["\\]/.test(id)) ? null : `(${ids.map((id) => `"${id}"`).join(',')})`;

  // Team-prune candidates (see the team prune below) are fixed BEFORE the game
  // prunes: a team whose games THIS pass deletes — a partial render — must
  // survive until a later pass still finds it gone, or one bad page cascades
  // into deleting its participation and rosters.
  const seenTeamIds = new Set(teamUUIDByEventTeamId.values());
  const { data: scoped, error: scopedErr } = await db
    .from('usau_event_teams')
    .select('team_id, usau_teams!inner(gender_division, competition_level)')
    .eq('event_id', eventUUID)
    .eq('usau_teams.gender_division', division)
    .eq('usau_teams.competition_level', competitionLevel);
  if (scopedErr) throw new Error(`usau_event_teams scope lookup: ${stringifyErr(scopedErr)}`);
  const scopedIds = ((scoped ?? []) as Array<{ team_id: string }>).map((r) => r.team_id);
  const unseen = scopedIds.filter((id) => !seenTeamIds.has(id));
  let staleTeams: string[] = [];
  if (unseen.length > 0 && (scopedIds.length - unseen.length) * 2 < scopedIds.length) {
    // Under half the stored field is on the page: more likely a broken page
    // than a republish. Leave the participations alone.
    console.warn(`team prune skipped for ${url}: page lists ${scopedIds.length - unseen.length} of ${scopedIds.length}`);
  } else if (unseen.length > 0) {
    const idList = `(${unseen.join(',')})`;
    const { data: withGames, error: gamesErr } = await db
      .from('usau_games')
      .select('team_a_id, team_b_id')
      .eq('event_id', eventUUID)
      .or(`team_a_id.in.${idList},team_b_id.in.${idList}`);
    if (gamesErr) throw new Error(`usau_games team-presence lookup: ${stringifyErr(gamesErr)}`);
    const played = new Set<string>();
    for (const g of (withGames ?? []) as Array<{ team_a_id: string | null; team_b_id: string | null }>) {
      if (g.team_a_id) played.add(g.team_a_id);
      if (g.team_b_id) played.add(g.team_b_id);
    }
    staleTeams = unseen.filter((id) => !played.has(id));
  }

  const seenEventGameIds = games
    .map((g) => g.usau_event_game_id)
    .filter((id): id is string => !!id);
  const eventGameInList = seenEventGameIds.length > 0 ? quotedList(seenEventGameIds) : null;
  if (seenEventGameIds.length > 0 && !eventGameInList) {
    console.warn(`stale-generation prune skipped for ${url}: unquotable event-game id`);
  } else if (eventGameInList) {
    const { error: pruneErr, count: pruned } = await db
      .from('usau_games')
      .delete({ count: 'exact' })
      .eq('event_id', eventUUID)
      .eq('source_url', url)
      .eq('status', 'scheduled')
      // Untouched = null scores (written since 2026-09-11) or the literal
      // "0 - 0" placeholder older rows still carry.
      .or('and(score_a.is.null,score_b.is.null),and(score_a.eq.0,score_b.eq.0)')
      .not('usau_event_game_id', 'is', null)
      .not('usau_event_game_id', 'in', eventGameInList);
    if (pruneErr) throw new Error(`usau_games stale-generation prune: ${stringifyErr(pruneErr)}`);
    if (pruned) console.log(`pruned ${pruned} stale-generation games for ${url}`);
  }

  // ── Same prune for BRACKET games (2026-10-01, NC Men's Regionals) ──
  // Bracket rows are keyed on usau_game_id, which the prune above never looks
  // at. USAU published a 16-team / 4-pool placeholder (dated the wrong weekend),
  // then the real 10-team / 2-pool schedule under new GameIds — the
  // placeholder's 19 bracket games lived on beside the real ones. Same guards.
  // Rows WITH an event-game id are left to the prune above (a pool row merged
  // with the other pipeline's copy can carry a foreign usau_game_id).
  const seenGameIds = games
    .map((g) => g.usau_game_id)
    .filter((id): id is string => !!id);
  const gameInList = seenGameIds.length > 0 ? quotedList(seenGameIds) : null;
  if (seenGameIds.length > 0 && !gameInList) {
    console.warn(`stale bracket prune skipped for ${url}: unquotable game id`);
  } else if (gameInList) {
    const { error: pruneErr, count: pruned } = await db
      .from('usau_games')
      .delete({ count: 'exact' })
      .eq('event_id', eventUUID)
      .eq('source_url', url)
      .eq('status', 'scheduled')
      .or('and(score_a.is.null,score_b.is.null),and(score_a.eq.0,score_b.eq.0)')
      .is('usau_event_game_id', null)
      .not('usau_game_id', 'is', null)
      .not('usau_game_id', 'in', gameInList);
    if (pruneErr) throw new Error(`usau_games stale bracket prune: ${stringifyErr(pruneErr)}`);
    if (pruned) console.log(`pruned ${pruned} stale-generation bracket games for ${url}`);
  }

  // ── Prune teams the page no longer lists (same republish) ──
  // The placeholder also carried 17 entrants; the real schedule has 10. The
  // participation upsert never removes a row, so the 7 extras surfaced as
  // phantom Pools C/D and padded A/B. `staleTeams` (fixed above, before the
  // game prunes) holds teams in THIS page's scope (gender + level — a
  // multi-division event shares one event_id), absent from the page, with no
  // game in the event: a team that played is kept, which covers USAU hiding
  // pool tables once brackets start. Its event-scoped roster rows go with it so
  // players aren't credited with an event they never attended (event_id NULL
  // legacy rows untouched); the roster stale-profile trigger doesn't fire on
  // DELETE, so their cached profiles are flagged here.
  if (staleTeams.length > 0) {
    const { data: rosterRows, error: rosterReadErr } = await db
      .from('usau_rosters')
      .select('player_id')
      .eq('event_id', eventUUID)
      .in('team_id', staleTeams);
    if (rosterReadErr) throw new Error(`usau_rosters stale-team lookup: ${stringifyErr(rosterReadErr)}`);
    const playerIds = [...new Set(((rosterRows ?? []) as Array<{ player_id: string }>).map((r) => r.player_id))];
    const { error: rosterErr } = await db
      .from('usau_rosters')
      .delete()
      .eq('event_id', eventUUID)
      .in('team_id', staleTeams);
    if (rosterErr) throw new Error(`usau_rosters stale-team prune: ${stringifyErr(rosterErr)}`);
    const { error: etPruneErr } = await db
      .from('usau_event_teams')
      .delete()
      .eq('event_id', eventUUID)
      .in('team_id', staleTeams);
    if (etPruneErr) throw new Error(`usau_event_teams stale-team prune: ${stringifyErr(etPruneErr)}`);
    for (let i = 0; i < playerIds.length; i += 100) {
      const { error: staleErr } = await db
        .from('player_profiles')
        .update({ built_at: '-infinity' })
        .in('anchor_id', playerIds.slice(i, i + 100))
        .neq('built_at', '-infinity');
      if (staleErr) throw new Error(`player_profiles stale flag: ${stringifyErr(staleErr)}`);
    }
    console.log(`pruned ${staleTeams.length} teams no longer listed for ${url}: ${staleTeams.join(',')}`);
  }

  return { teams: teams.length, games: games.length, skipped: false };
}

/**
 * Majority timezone of the event's entrant teams (usau_teams.state, backfilled
 * from venue history for ~87% of teams). Null when no entrant has a mappable
 * state. Votes are counted per ZONE, not per state, so a NY/MA/VT field still
 * resolves cleanly to Eastern.
 */
async function inferTzFromEntrants(db: ReturnType<typeof supabase>, eventUUID: string): Promise<string | null> {
  const { data: entrants } = await db
    .from('usau_event_teams')
    .select('team_id')
    .eq('event_id', eventUUID);
  const ids = ((entrants ?? []) as Array<{ team_id: string }>).map((r) => r.team_id);
  if (ids.length === 0) return null;
  const { data: teams } = await db.from('usau_teams').select('state').in('id', ids);
  const votes = new Map<string, number>();
  for (const t of (teams ?? []) as Array<{ state: string | null }>) {
    const zone = tzForState(t.state);
    if (zone) votes.set(zone, (votes.get(zone) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [zone, n] of votes) {
    if (n > bestN) {
      best = zone;
      bestN = n;
    }
  }
  return best;
}

// ────────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────────

interface RequestBody {
  slug?: string;
  divisions?: Division[];
}

async function run(body: RequestBody) {
  const slug = body.slug?.trim();
  if (!slug) throw new Error('Request body must include { slug }');

  const divisions: Division[] = body.divisions?.length
    ? body.divisions
    : ['Men', 'Women', 'Mixed'];

  const db = supabase();
  const eventUUID = await ensureEvent(db, slug);

  // Look up the event's competition level so the schedule URL hits the
  // right USAU path (College vs Club). ensureEvent stubs new rows as CLUB
  // by default; College events should already exist via sync-events
  // (calendar discovery) with the right level, so this lookup picks that up.
  const { data: eventRow } = await db
    .from('usau_events')
    .select('competition_level, state, start_date')
    .eq('id', eventUUID)
    .maybeSingle();
  // Venue timezone (for converting USAU's local schedule times → UTC). Derived
  // from the event's US state; when USAU lists the venue as "TBD" (every 2026
  // Sectional, 32 events on 2026-09-11) fall back to the zone most of the
  // entrant teams live in — a Sectional is played where its teams are. Still
  // null → times are stored date-only rather than at a wrong instant. The
  // resolved zone is persisted as usau_events.venue_tz so the web/mobile
  // formatters can render the wall clock without repeating the inference.
  let tz = tzForState(eventRow?.state as string | null | undefined);
  if (!tz) tz = await inferTzFromEntrants(db, eventUUID);
  if (tz) await db.from('usau_events').update({ venue_tz: tz }).eq('id', eventUUID);
  // The event's competition level chooses the schedule URL path family:
  // College → "College", Masters family → the masters segments, everything
  // else → "Club". Previously ALL non-college levels (incl. MASTERS/
  // GRAND_MASTERS/GREAT_GRAND_MASTERS) were coerced to CLUB → built Club-Men
  // schedule URLs → 404 → 0 rows, so live masters events never captured games.
  // Now the masters levels pass through and syncDivision iterates their URL
  // segment family. Unknown/youth/beach/other levels still fall back to CLUB.
  const rawLevel = eventRow?.competition_level;
  const knownLevels: CompetitionLevel[] = [
    'CLUB',
    'COLLEGE_D1',
    'COLLEGE_D3',
    'MASTERS',
    'GRAND_MASTERS',
    'GREAT_GRAND_MASTERS',
  ];
  const competitionLevel: CompetitionLevel = knownLevels.includes(
    rawLevel as CompetitionLevel,
  )
    ? (rawLevel as CompetitionLevel)
    : 'CLUB';

  const perDivision: Record<string, { teams: number; games: number; skipped: boolean }> = {};
  let totalTeams = 0;
  let totalGames = 0;

  for (const div of divisions) {
    perDivision[div] = await syncDivision(
      db, eventUUID, slug, div, competitionLevel, tz,
      (eventRow?.start_date as string | null | undefined) ?? null,
    );
    totalTeams += perDivision[div].teams;
    totalGames += perDivision[div].games;
  }

  // Derive the event's venue from the field names we just wrote. Write-path
  // only — the read path serves the stored column.
  await db.rpc('usau_derive_event_venue', { target_event_id: eventUUID });

  // First scrape of a TBD-venue event: no entrants existed above, so times went
  // in date-only. Resolve the zone from the teams just written so the read
  // path has it now; the next live pass (15 min) rewrites the times.
  if (!tz) {
    const late = await inferTzFromEntrants(db, eventUUID);
    if (late) await db.from('usau_events').update({ venue_tz: late }).eq('id', eventUUID);
  }

  // Mark the event as freshly scraped.
  await db
    .from('usau_events')
    .update({
      last_scraped_at: new Date().toISOString(),
      last_scraped_status: 'ok',
    })
    .eq('id', eventUUID);

  // Final placements from the bracket results, once every bracket game is
  // played (skipped until then). Write-path only — the read path serves
  // usau_event_teams.final_placement.
  const placements = await refreshEventPlacements(db, eventUUID);

  return {
    rowsProcessed: totalTeams + totalGames,
    result: { slug, eventID: eventUUID, perDivision, placements },
  };
}

Deno.serve(async (req) => {
  let body: RequestBody = {};
  try {
    if (req.headers.get('content-type')?.includes('application/json')) {
      body = await req.json();
    } else {
      const url = new URL(req.url);
      const qSlug = url.searchParams.get('slug');
      if (qSlug) body.slug = qSlug;
    }
  } catch {
    // empty body OK if slug is in query
  }

  try {
    const res = await withRunLogging('sync-event-details', { slug: body.slug ?? null }, () =>
      run(body),
    );
    return Response.json({ ok: true, ...res });
  } catch (err) {
    const message = formatErr(err);
    console.error('[sync-event-details] failed:', message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});

