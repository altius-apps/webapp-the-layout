// sync-event-rosters: scrape per-team rosters + per-event player stats
// (goals/assists/Ds/turns) for one event.
//
// Request body: { slug: string }
//
// For each team already in usau_event_teams for that event, hit
// /teams/events/Eventteam/?EventTeamId={id} and parse the roster table
// (#CT_Main_0_ucTeamDetails_gvList) → usau_players + usau_rosters, and its
// Points (= goals) / Assists / Ds / Turns columns → usau_player_event_stats.
// (Stats used to come from #CT_Right_1_gvListGoals/Assists leaderboards; USAU
// removed those in Oct 2026 and the scrape silently stored nothing.)
//
// Player identity: USAU doesn't expose a persistent player ID on team
// pages, just display names. We use (team_id, lower(name)) as the natural
// key — meaning "Nick Tolfa on Revolver" and "Nick Tolfa on PoNY" are two
// separate rows. That's accurate to what the source actually publishes.
//
// Rosters are PER EVENT. USAU publishes a different roster for each event a
// team attends (Chain Lightning 2026: 19 at Pro-Elite Challenge East, 20 at
// Elite Select Challenge, 12 in common), so usau_rosters rows carry event_id
// and are keyed (team_id, season, event_id, player_id). Before that key
// existed, the second event scraped silently overwrote the first.
//
// If an event's URL ids haven't been resolved yet this function resolves them
// on demand (invoking resolve-event-team-urls for that slug) rather than
// failing — that stage used to be a separate manual prerequisite and silently
// left 11% of 2026 participations unscrapeable.

import { fetchHtml } from '../_shared/http.ts';
import { parseHtml, teamUrlByEventTeamId } from '../_shared/parse.ts';
import { supabase, withRunLogging } from '../_shared/supabase.ts';

/** Null = USAU left that column blank for the whole team (not tracked for
 *  the event — e.g. no Ds/Turns before ~2016), as opposed to a 0. */
interface PlayerStats {
  goals: number | null;
  assists: number | null;
  ds: number | null;
  turns: number | null;
}

interface RosterPlayer {
  jersey: string | null;
  name: string;
  pronouns: string | null;
  height: string | null;
  /** Null when all four stat cells are blank (didn't play, or stats not
   *  entered) — no stats row is written for them. */
  stats: PlayerStats | null;
}

interface TeamPageParse {
  roster: RosterPlayer[];
  /** False unless all four stat headers are present exactly once — USAU
   *  changed the page again; no stats are written and it's logged, so it can't
   *  go silent like the leaderboard removal. */
  statColumnsFound: boolean;
}

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

function parseTeamPage(html: string): TeamPageParse {
  const $ = parseHtml(html);

  // Roster: #CT_Main_0_ucTeamDetails_gvList tr
  // Columns: No., Player, Pronouns, Position, Height, Points, Assists, Ds, Turns.
  // Stat columns are located by header text (own text nodes only — the
  // Pronouns <th> nests a tooltip whose text would pollute .text()).
  const $table = $('#CT_Main_0_ucTeamDetails_gvList');
  const HEADER_STAT: Record<string, keyof PlayerStats> = { points: 'goals', assists: 'assists', ds: 'ds', turns: 'turns' };
  const statCol: Partial<Record<keyof PlayerStats, number>> = {};
  const $headers = $table.find('tr').first().children('th');
  let duplicateHeader = false;
  $headers.each((i, th) => {
    const label = $(th).contents().filter((_, n) => n.type === 'text').text().trim().toLowerCase();
    const key = HEADER_STAT[label];
    if (!key) return;
    if (statCol[key] != null) duplicateHeader = true;
    statCol[key] = i;
  });
  // All four, each once, and no spanning headers — otherwise a renamed or
  // shifted column would write a fabricated 0 over a real stat. No stats then.
  const statColumnsFound =
    Object.keys(statCol).length === 4 && !duplicateHeader && $headers.filter('[colspan]').length === 0;
  const headerCount = $headers.length;

  const STAT_KEYS = ['goals', 'assists', 'ds', 'turns'] as const;
  const roster: RosterPlayer[] = [];
  const rawByPlayer: Array<Record<keyof PlayerStats, number | null> | null> = [];
  $table.find('tr').each((_, tr) => {
    const $tr = $(tr);
    const $cells = $tr.children('td');
    if ($cells.length === 0) return;

    const jersey = $cells.eq(0).text().trim() || null;
    const name = $cells.eq(1).text().trim();
    if (!name) return;
    const pronouns = $cells.eq(2).text().trim() || null;
    const height = $cells.eq(4).text().trim() || null;

    // A row misaligned with the header, or holding an implausible value, or
    // with all four cells blank, gets no stats.
    const cell = (k: keyof PlayerStats): number | null | 'bad' => {
      const text = $cells.eq(statCol[k]!).text().trim();
      if (text === '') return null;
      const m = text.match(/^(\d{1,3})$/);
      return m ? parseInt(m[1], 10) : 'bad';
    };
    let raw: Record<keyof PlayerStats, number | null> | null = null;
    if (statColumnsFound && $cells.length === headerCount) {
      const vals = STAT_KEYS.map(cell);
      if (!vals.includes('bad') && vals.some((v) => v != null)) {
        raw = Object.fromEntries(STAT_KEYS.map((k, i) => [k, vals[i] as number | null])) as Record<keyof PlayerStats, number | null>;
      }
    }
    rawByPlayer.push(raw);
    roster.push({ jersey, name, pronouns, height, stats: null });
  });

  // USAU renders a zero as a blank cell, so a blank is 0 — unless the column
  // is blank for the whole team, which means it wasn't tracked: null.
  const tracked = new Set(STAT_KEYS.filter((k) => rawByPlayer.some((r) => r?.[k] != null)));
  roster.forEach((p, i) => {
    const r = rawByPlayer[i];
    if (r) {
      p.stats = Object.fromEntries(
        STAT_KEYS.map((k) => [k, tracked.has(k) ? r[k] ?? 0 : null]),
      ) as unknown as PlayerStats;
    }
  });

  return { roster, statColumnsFound };
}

// ────────────────────────────────────────────────────────────
// Per-team sync
// ────────────────────────────────────────────────────────────

interface SyncResult {
  team: string;
  rosterSize: number;
  withStats: number;
  statColumnsFound?: boolean;
  skipped?: boolean;
  error?: string;
}

// Records that we actually fetched this event-team's page. Callers use it to
// tell "no roster published upstream" apart from "not scraped yet" — without
// it, a page that yields no rows looks like pending work forever.
async function markRosterChecked(
  db: ReturnType<typeof supabase>,
  eventID: string,
  teamUUID: string,
): Promise<void> {
  const { error } = await db
    .from('usau_event_teams')
    .update({ roster_checked_at: new Date().toISOString() })
    .eq('event_id', eventID)
    .eq('team_id', teamUUID);
  if (error) console.error(`roster_checked_at update: ${stringifyErr(error)}`);
}

async function syncTeam(
  db: ReturnType<typeof supabase>,
  eventID: string,
  eventTeamId: string,
  teamUUID: string,
  teamName: string,
  season: number,
): Promise<SyncResult> {
  const url = teamUrlByEventTeamId(eventTeamId);
  let html: string;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    return {
      team: teamName,
      rosterSize: 0,
      withStats: 0,
      skipped: true,
      error: stringifyErr(err),
    };
  }

  const { roster, statColumnsFound } = parseTeamPage(html);
  if (roster.length === 0) {
    // Page fetched fine, USAU just publishes no roster for it. Stamp it so the
    // backfill stops re-scraping a page that will never yield rows. Only on
    // this path — a fetch failure above must stay unstamped so it retries.
    await markRosterChecked(db, eventID, teamUUID);
    return { team: teamName, rosterSize: 0, withStats: 0, skipped: true };
  }
  if (!statColumnsFound) {
    console.error(`[sync-event-rosters] ${teamName}: roster table lacks exactly one each of Points/Assists/Ds/Turns headers — USAU page changed? No stats written.`);
  }

  let withStats = 0;

  // Existing roster on this team this season — used to dedupe by name. One name
  // can carry several player_ids here (legacy season rows, merged team rows, a
  // fresh id per earlier event scrape) and the last one read used to win, so a
  // re-scrape could file this event's stats under a second id beside the first
  // (2,307 duplicate stat rows found 2026-09-22). Prefer, in order: the id on
  // THIS event's roster, the id already holding this event's stats, an id from
  // another event's roster, a legacy season row; ties → lowest id.
  const [rosterRes, statsRes] = await Promise.all([
    db
      .from('usau_rosters')
      .select('player_id, event_id, usau_players(display_name)')
      .eq('team_id', teamUUID)
      .eq('season', season),
    db
      .from('usau_player_event_stats')
      .select('player_id')
      .eq('event_id', eventID)
      .eq('team_id', teamUUID),
  ]);
  if (rosterRes.error) throw new Error(`load team roster: ${stringifyErr(rosterRes.error)}`);
  if (statsRes.error) throw new Error(`load event stats: ${stringifyErr(statsRes.error)}`);

  const holdsEventStats = new Set((statsRes.data ?? []).map((s) => s.player_id));
  const rank = (r: { player_id: string; event_id: string | null }) =>
    r.event_id === eventID ? 0 : holdsEventStats.has(r.player_id) ? 1 : r.event_id ? 2 : 3;
  const ranked = [...(rosterRes.data ?? [])].sort(
    (a, b) => rank(a) - rank(b) || (a.player_id < b.player_id ? -1 : a.player_id > b.player_id ? 1 : 0),
  );

  const playerByName = new Map<string, string>();
  for (const r of ranked) {
    const dn = (r.usau_players as { display_name: string } | null)?.display_name;
    if (dn && !playerByName.has(dn.toLowerCase())) playerByName.set(dn.toLowerCase(), r.player_id);
  }

  for (const p of roster) {
    const lowerName = p.name.toLowerCase();
    let playerUUID = playerByName.get(lowerName);

    if (!playerUUID) {
      const { data: created, error: createErr } = await db
        .from('usau_players')
        .insert({ display_name: p.name })
        .select('id')
        .single();
      if (createErr) throw new Error(`insert usau_players(${p.name}): ${stringifyErr(createErr)}`);
      playerUUID = created.id;
      playerByName.set(lowerName, playerUUID);
    }

    // event_id is part of the key: USAU rosters are PER EVENT, and without it
    // the second event scraped for a team-season overwrote the first (PEC East
    // lost Selfridge/Poe to the ESC scrape). See the 20260821140000 migration.
    const { error: rosterErr } = await db.from('usau_rosters').upsert(
      {
        team_id: teamUUID,
        season,
        event_id: eventID,
        player_id: playerUUID,
        jersey_number: p.jersey,
      },
      { onConflict: 'team_id,season,event_id,player_id', ignoreDuplicates: false },
    );
    if (rosterErr) throw new Error(`usau_rosters upsert: ${stringifyErr(rosterErr)}`);

    if (p.stats) {
      withStats++;
      const { error: statErr } = await db.from('usau_player_event_stats').upsert(
        {
          player_id: playerUUID,
          event_id: eventID,
          team_id: teamUUID,
          goals: p.stats.goals,
          assists: p.stats.assists,
          ds: p.stats.ds,
          turns: p.stats.turns,
          scraped_at: new Date().toISOString(),
        },
        { onConflict: 'player_id,event_id', ignoreDuplicates: false },
      );
      if (statErr) throw new Error(`usau_player_event_stats upsert: ${stringifyErr(statErr)}`);
    }
  }

  await db
    .from('usau_teams')
    .update({ last_scraped_at: new Date().toISOString() })
    .eq('id', teamUUID);
  await markRosterChecked(db, eventID, teamUUID);

  return { team: teamName, rosterSize: roster.length, withStats, statColumnsFound };
}

// ────────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────────

interface RequestBody {
  slug?: string;
  /** When set, scrape ONLY this team's roster (single-team mode). Keeps each
   *  invocation small so it fits the edge walltime budget — the dispatcher
   *  (sync-event-rosters-dispatch) fans one of these out per team. When absent,
   *  the function scrapes every team in the event (legacy; fine for small
   *  events / manual one-offs but can exceed walltime on 13+-team events). */
  teamId?: string;
}

async function run(body: RequestBody) {
  const slug = body.slug?.trim();
  if (!slug) throw new Error('Request body must include { slug }');
  const onlyTeamId = body.teamId?.trim() || null;

  const db = supabase();

  const { data: event, error: eventErr } = await db
    .from('usau_events')
    .select('id, season')
    .eq('usau_slug', slug)
    .maybeSingle();
  if (eventErr) throw new Error(`load event: ${stringifyErr(eventErr)}`);
  if (!event) throw new Error(`event '${slug}' not found — run sync-event-details first`);

  // Use usau_event_team_url_id (the base64 per-event id used by USAU team
  // page URLs), not the persistent usau_event_team_id (which is the
  // numeric team id since the ultirzr ingest).
  const loadParticipations = async () => {
    let q = db
      .from('usau_event_teams')
      .select('team_id, usau_event_team_url_id, usau_teams(name)')
      .eq('event_id', event.id)
      .not('usau_event_team_url_id', 'is', null);
    if (onlyTeamId) q = q.eq('team_id', onlyTeamId);
    const { data, error } = await q;
    if (error) throw new Error(`load event_teams: ${stringifyErr(error)}`);
    return data ?? [];
  };

  let participations = await loadParticipations();

  // Self-heal instead of erroring out. The URL token is scraped from the same
  // schedule page this pipeline already walks, but it used to live in a
  // separate stage (resolve-event-team-urls) that had to be run FIRST and by
  // hand — 11% of 2026 participations were left unresolved, so their rosters
  // were never fetchable and the miss was silent. Resolve on demand, then retry.
  let resolved = 0;
  if (participations.length === 0) {
    const { data: pending } = await db
      .from('usau_event_teams')
      .select('team_id')
      .eq('event_id', event.id)
      .is('usau_event_team_url_id', null);
    if ((pending ?? []).length > 0) {
      console.log(
        `[sync-event-rosters] '${slug}': ${pending!.length} unresolved url ids — resolving now`,
      );
      const { error: invokeErr } = await db.functions.invoke('resolve-event-team-urls', {
        body: { slug, limit: 1 },
      });
      if (invokeErr) {
        throw new Error(`resolve-event-team-urls('${slug}'): ${stringifyErr(invokeErr)}`);
      }
      participations = await loadParticipations();
      resolved = participations.length;
    }
  }

  if (participations.length === 0) {
    throw new Error(
      `no participations with usau_event_team_url_id for '${slug}' — ` +
        `resolve-event-team-urls found no schedule page to resolve them from`,
    );
  }

  const results: SyncResult[] = [];
  for (const p of participations) {
    const teamName = (p.usau_teams as { name: string } | null)?.name ?? '?';
    results.push(
      await syncTeam(
        db,
        event.id,
        p.usau_event_team_url_id!,
        p.team_id,
        teamName,
        event.season,
      ),
    );
  }

  const totalRoster = results.reduce((s, r) => s + r.rosterSize, 0);
  const totalStats = results.reduce((s, r) => s + r.withStats, 0);

  return {
    rowsProcessed: totalRoster + totalStats,
    result: {
      slug,
      teams: results.length,
      players: totalRoster,
      /** Non-zero when this run had to resolve URL ids before it could scrape. */
      resolvedUrlIds: resolved,
      withStats: totalStats,
      perTeam: results,
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
      const qSlug = url.searchParams.get('slug');
      if (qSlug) body.slug = qSlug;
      const qTeam = url.searchParams.get('teamId');
      if (qTeam) body.teamId = qTeam;
    }
  } catch {
    // ok
  }

  try {
    const res = await withRunLogging(
      'sync-event-rosters',
      { slug: body.slug ?? null, teamId: body.teamId ?? null },
      () => run(body),
    );
    return Response.json({ ok: true, ...res });
  } catch (err) {
    const message = stringifyErr(err);
    console.error('[sync-event-rosters] failed:', message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});
