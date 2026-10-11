// Favorites data layer — a signed-in user's favorite leagues + teams.
//
// All reads AND writes are owner-scoped private data (unlike fantasy/profiles,
// whose reads are public). Every call uses the session-aware client so
// auth.getUser() + owner-only RLS (user_favorite_*_own policies) apply. owner
// id is always derived from the session, never trusted from the client.
//
// A favorite team is the (league, teamId) pair the app already routes on
// (resultHref in usau/search-nav.ts), with name/logo denormalized so the
// favorites list renders without joining six league tables.

import { createClient as createSessionClient } from '@/lib/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { usauTeamLogo } from '@/lib/usau/team-logo';

// user_favorite_* tables aren't in database.types.ts — untyped client + casts,
// same convention as fantasy/pul/wul data layers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

function sessionClient(): AnyClient {
  return createSessionClient() as unknown as AnyClient;
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** The leagues a team/league favorite can belong to. MUST stay in sync with the
 *  DB CHECKs on user_favorite_{teams,leagues,players} (see migration
 *  20260803210000) and with resultHref's routing switch — widening this union
 *  alone means every favorite of the new league is silently rejected on insert. */
export type FavoriteLeague = 'ufa' | 'usau' | 'pul' | 'wul' | 'wfdf' | 'euf';

export const FAVORITE_LEAGUES: readonly FavoriteLeague[] = [
  'ufa', 'usau', 'pul', 'wul', 'wfdf', 'euf',
] as const;

export interface FavoriteTeam {
  league: FavoriteLeague;
  teamId: string;
  name: string;
  logoUrl: string | null;
}

/** A favorite PLAYER — stored as the (league, playerId) pair resultHref routes
 *  on (playerId = UUID for anchor leagues, the player's NAME for WFDF), with
 *  team + headshot denormalized for the feed. */
export interface FavoritePlayer {
  league: FavoriteLeague;
  playerId: string;
  name: string;
  /** Their team (SearchResult.hint), for the feed's secondary line. */
  teamName: string | null;
  /** UFA-only (the only league with headshots); null → monogram fallback. */
  headshotUrl: string | null;
}

/** A starred tournament — the (league, eventId) pair, with the event's own
 *  fields denormalized (mirrors FavoriteTeam) so the feed/star can render
 *  without a join. The leagues with event pages. MUST stay in sync with the
 *  user_favorite_events league CHECK (migration 20260907150452) — widening
 *  this alone means the new league's stars are rejected on insert. EUF stars
 *  are bookmarks only until send-game-notifications grows an EUF branch. */
export interface FavoriteEvent {
  league: Extract<FavoriteLeague, 'usau' | 'wfdf' | 'euf'>;
  eventId: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
}

/** A starred GAME — the pro-league twin of a starred tournament. gameId is the
 *  league's own id and IS the route param (UFA "2026-05-16-COL-NY"; PUL/WUL
 *  slash ids). MUST stay in sync with the user_favorite_games league CHECK
 *  (migration 20260907150822). Only UFA has a sender leg today; PUL/WUL stars
 *  are bookmarks until send-game-notifications grows one. */
export interface FavoriteGame {
  league: Extract<FavoriteLeague, 'ufa' | 'pul' | 'wul'>;
  gameId: string;
  /** The matchup label the game header shows ("Colorado vs New York"). */
  name: string;
  /** ISO yyyy-mm-dd, for upcoming-first ordering. */
  gameDate: string | null;
}

export interface MyFavorites {
  leagues: FavoriteLeague[];
  teams: FavoriteTeam[];
  players: FavoritePlayer[];
  games: FavoriteGame[];
  events: FavoriteEvent[];
}

/** Hard cap so a script can't balloon a user's favorites row set. Enforced
 *  client-side here AND worth a DB trigger later if it ever matters. */
export const MAX_FAVORITE_TEAMS = 50;
/** Same cap for favorite players. */
export const MAX_FAVORITE_PLAYERS = 50;
/** Same cap for starred games. */
export const MAX_FAVORITE_GAMES = 50;

// ─── Reads ──────────────────────────────────────────────────────────────────

/** The signed-in user's favorites, or empty lists when not signed in. */
export async function getMyFavorites(): Promise<MyFavorites> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { leagues: [], teams: [], players: [], games: [], events: [] };

  const [teamsRes, leaguesRes, playersRes, gamesRes, eventsRes] = await Promise.all([
    supabase
      .from('user_favorite_teams')
      .select('league, team_id, name, logo_url')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('user_favorite_leagues')
      .select('league')
      .eq('user_id', user.id),
    // Players ascending (oldest first) so the FIRST player a user added anchors
    // the For You "player spotlight" — adding a second player doesn't bump the
    // original out of the spotlight. (Teams stay newest-first above.)
    supabase
      .from('user_favorite_players')
      .select('league, player_id, name, team_name, headshot_url')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true }),
    supabase
      .from('user_favorite_games')
      .select('league, game_id, name, game_date')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('user_favorite_events')
      .select('league, event_id, name, start_date, end_date')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
  ]);

  if (teamsRes.error) throw teamsRes.error;
  if (leaguesRes.error) throw leaguesRes.error;
  if (playersRes.error) throw playersRes.error;
  if (gamesRes.error) throw gamesRes.error;
  if (eventsRes.error) throw eventsRes.error;

  const teams: FavoriteTeam[] = ((teamsRes.data ?? []) as {
    league: FavoriteLeague; team_id: string; name: string; logo_url: string | null;
  }[]).map((r) => ({
    league: r.league,
    teamId: r.team_id,
    name: r.name,
    logoUrl: r.logo_url ?? null,
  }));

  // USAU crests are keyed by name + gender + level, which the favorite row
  // doesn't store, so ~1/3 were saved without one. Resolve those at read time.
  // usau team ids are uuids; anything else would make the .in() below throw.
  const crestless = teams.filter(
    (t) => t.league === 'usau' && !t.logoUrl && /^[0-9a-f-]{36}$/i.test(t.teamId),
  );
  if (crestless.length > 0) {
    const { data: divs, error: divErr } = await supabase
      .from('usau_teams')
      .select('id, gender_division, competition_level')
      .in('id', crestless.map((t) => t.teamId));
    if (divErr) throw divErr;
    const byId = new Map(
      ((divs ?? []) as { id: string; gender_division: string | null; competition_level: string | null }[]).map((d) => [
        d.id,
        d,
      ]),
    );
    for (const t of crestless) {
      const d = byId.get(t.teamId);
      if (d) t.logoUrl = usauTeamLogo(t.name, d.gender_division, d.competition_level);
    }
  }

  const leagues = ((leaguesRes.data ?? []) as { league: FavoriteLeague }[])
    .map((r) => r.league);

  const players: FavoritePlayer[] = ((playersRes.data ?? []) as {
    league: FavoriteLeague; player_id: string; name: string; team_name: string | null; headshot_url: string | null;
  }[]).map((r) => ({
    league: r.league,
    playerId: r.player_id,
    name: r.name,
    teamName: r.team_name ?? null,
    headshotUrl: r.headshot_url ?? null,
  }));

  const games: FavoriteGame[] = ((gamesRes.data ?? []) as {
    league: FavoriteGame['league']; game_id: string; name: string; game_date: string | null;
  }[]).map((r) => ({
    league: r.league,
    gameId: r.game_id,
    name: r.name,
    gameDate: r.game_date ?? null,
  }));

  const events: FavoriteEvent[] = ((eventsRes.data ?? []) as {
    league: FavoriteEvent['league']; event_id: string; name: string; start_date: string | null; end_date: string | null;
  }[]).map((r) => ({
    league: r.league,
    eventId: r.event_id,
    name: r.name,
    startDate: r.start_date ?? null,
    endDate: r.end_date ?? null,
  }));

  return { leagues, teams, players, games, events };
}

// ─── Team writes ──────────────────────────────────────────────────────────────

/**
 * Add a favorite team. Idempotent (upsert on the (user, league, team) PK).
 * Throws if the user is at MAX_FAVORITE_TEAMS. owner id comes from the session.
 */
export async function addFavoriteTeam(team: FavoriteTeam): Promise<void> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  // Count guard — count existing (excludes this team if it's already there).
  const { count, error: countErr } = await supabase
    .from('user_favorite_teams')
    .select('team_id', { count: 'exact', head: true })
    .eq('user_id', user.id);
  if (countErr) throw countErr;
  if ((count ?? 0) >= MAX_FAVORITE_TEAMS) {
    // Allow a re-favorite of an existing team (upsert), block genuinely-new ones.
    const { data: existing } = await supabase
      .from('user_favorite_teams')
      .select('team_id')
      .eq('user_id', user.id)
      .eq('league', team.league)
      .eq('team_id', team.teamId)
      .maybeSingle();
    if (!existing) {
      throw new Error(`You can favorite up to ${MAX_FAVORITE_TEAMS} teams.`);
    }
  }

  const { error } = await supabase.from('user_favorite_teams').upsert(
    {
      user_id: user.id,
      league: team.league,
      team_id: team.teamId,
      name: team.name,
      logo_url: team.logoUrl,
    },
    { onConflict: 'user_id,league,team_id' },
  );
  if (error) throw error;
}

/** Remove a favorite team by its (league, teamId). No-op if not favorited. */
export async function removeFavoriteTeam(
  league: FavoriteLeague,
  teamId: string,
): Promise<void> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');
  const { error } = await supabase
    .from('user_favorite_teams')
    .delete()
    .eq('user_id', user.id)
    .eq('league', league)
    .eq('team_id', teamId);
  if (error) throw error;
}

// ─── Player writes ──────────────────────────────────────────────────────────────

/**
 * Add a favorite player. Idempotent (upsert on the (user, league, player) PK).
 * Throws if the user is at MAX_FAVORITE_PLAYERS. owner id comes from the session.
 */
export async function addFavoritePlayer(player: FavoritePlayer): Promise<void> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  // Count guard — mirrors addFavoriteTeam: block genuinely-new past the cap,
  // still allow re-favoriting an existing one (upsert).
  const { count, error: countErr } = await supabase
    .from('user_favorite_players')
    .select('player_id', { count: 'exact', head: true })
    .eq('user_id', user.id);
  if (countErr) throw countErr;
  if ((count ?? 0) >= MAX_FAVORITE_PLAYERS) {
    const { data: existing } = await supabase
      .from('user_favorite_players')
      .select('player_id')
      .eq('user_id', user.id)
      .eq('league', player.league)
      .eq('player_id', player.playerId)
      .maybeSingle();
    if (!existing) {
      throw new Error(`You can favorite up to ${MAX_FAVORITE_PLAYERS} players.`);
    }
  }

  const { error } = await supabase.from('user_favorite_players').upsert(
    {
      user_id: user.id,
      league: player.league,
      player_id: player.playerId,
      name: player.name,
      team_name: player.teamName,
      headshot_url: player.headshotUrl,
    },
    { onConflict: 'user_id,league,player_id' },
  );
  if (error) throw error;
}

/** Remove a favorite player by its (league, playerId). No-op if not favorited. */
export async function removeFavoritePlayer(
  league: FavoriteLeague,
  playerId: string,
): Promise<void> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');
  const { error } = await supabase
    .from('user_favorite_players')
    .delete()
    .eq('user_id', user.id)
    .eq('league', league)
    .eq('player_id', playerId);
  if (error) throw error;
}

// ─── League writes ────────────────────────────────────────────────────────────

/**
 * Replace the user's favorite-league set with exactly `leagues`. Diffs against
 * the current set so we only insert added / delete removed rows (keeps
 * created_at stable for untouched leagues). owner id from the session.
 */
export async function setFavoriteLeagues(leagues: FavoriteLeague[]): Promise<void> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  // De-dupe + validate against the allowed set.
  const want = [...new Set(leagues)].filter((l) => FAVORITE_LEAGUES.includes(l));

  const { data: currentRows, error: readErr } = await supabase
    .from('user_favorite_leagues')
    .select('league')
    .eq('user_id', user.id);
  if (readErr) throw readErr;
  const have = new Set(((currentRows ?? []) as { league: FavoriteLeague }[]).map((r) => r.league));

  const toAdd = want.filter((l) => !have.has(l));
  const toRemove = [...have].filter((l) => !want.includes(l));

  if (toAdd.length) {
    const { error } = await supabase
      .from('user_favorite_leagues')
      .insert(toAdd.map((league) => ({ user_id: user.id, league })));
    if (error) throw error;
  }
  if (toRemove.length) {
    const { error } = await supabase
      .from('user_favorite_leagues')
      .delete()
      .eq('user_id', user.id)
      .in('league', toRemove);
    if (error) throw error;
  }
}

// ─── Event (starred tournament) writes ───────────────────────────────────────

/** Whether the signed-in user has starred ANY of these events. A merged USAU
 *  series event spans one row per division and an older star may sit on any
 *  of them; single events pass one id. False when signed out. */
export async function isAnyEventFavorited(
  league: FavoriteEvent['league'],
  eventIds: string[],
): Promise<boolean> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
  const { data, error } = await supabase
    .from('user_favorite_events')
    .select('event_id')
    .eq('user_id', user.id)
    .eq('league', league)
    .in('event_id', eventIds)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Star a tournament. Idempotent (upsert on the (user, league, event) PK).
 *  owner id comes from the session. No cap — a user stars far fewer events
 *  than teams/players in practice. */
export async function addFavoriteEvent(event: FavoriteEvent): Promise<void> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const { error } = await supabase.from('user_favorite_events').upsert(
    {
      user_id: user.id,
      league: event.league,
      event_id: event.eventId,
      name: event.name,
      start_date: event.startDate,
      end_date: event.endDate,
    },
    { onConflict: 'user_id,league,event_id' },
  );
  if (error) throw error;
}

/** Unstar a tournament — every one of these event ids (all divisions of a
 *  merged USAU series event). No-op for ids that aren't favorited. */
export async function removeFavoriteEvents(
  league: FavoriteEvent['league'],
  eventIds: string[],
): Promise<void> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');
  const { error } = await supabase
    .from('user_favorite_events')
    .delete()
    .eq('user_id', user.id)
    .eq('league', league)
    .in('event_id', eventIds);
  if (error) throw error;
}

// ─── Game (starred game) writes ──────────────────────────────────────────────

/** Whether the signed-in user has starred this game. False when signed out. */
export async function isGameFavorited(
  league: FavoriteGame['league'],
  gameId: string,
): Promise<boolean> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
  const { data, error } = await supabase
    .from('user_favorite_games')
    .select('game_id')
    .eq('user_id', user.id)
    .eq('league', league)
    .eq('game_id', gameId)
    .maybeSingle();
  if (error) throw error;
  return data != null;
}

/** Star a game. Idempotent (upsert on the (user, league, game) PK). Throws at
 *  MAX_FAVORITE_GAMES for a genuinely-new game; a re-star of an existing one
 *  always passes. owner id comes from the session. */
export async function addFavoriteGame(game: FavoriteGame): Promise<void> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const { count, error: countErr } = await supabase
    .from('user_favorite_games')
    .select('game_id', { count: 'exact', head: true })
    .eq('user_id', user.id);
  if (countErr) throw countErr;
  if ((count ?? 0) >= MAX_FAVORITE_GAMES) {
    const existing = await isGameFavorited(game.league, game.gameId);
    if (!existing) throw new Error(`You can star up to ${MAX_FAVORITE_GAMES} games.`);
  }

  const { error } = await supabase.from('user_favorite_games').upsert(
    {
      user_id: user.id,
      league: game.league,
      game_id: game.gameId,
      name: game.name,
      game_date: game.gameDate,
    },
    { onConflict: 'user_id,league,game_id' },
  );
  if (error) throw error;
}

/** Unstar a game by its (league, gameId). No-op if not favorited. */
export async function removeFavoriteGame(
  league: FavoriteGame['league'],
  gameId: string,
): Promise<void> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');
  const { error } = await supabase
    .from('user_favorite_games')
    .delete()
    .eq('user_id', user.id)
    .eq('league', league)
    .eq('game_id', gameId);
  if (error) throw error;
}
