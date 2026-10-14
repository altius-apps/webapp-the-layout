-- Public + official fantasy leagues (Hunter, 2026-10-14).
--
-- A league can be PUBLIC (anyone can join from /fantasy → Public, no invite
-- code) and the platform runs one OFFICIAL public league per event and per
-- weekly season ("The Layout" system account owns them). Official leagues
-- never draft, so there's no player exclusivity: every team picks any players
-- (settings.draft stays unset — the existing no-draft path), unlimited teams,
-- same scoring. User leagues stay private by default; a public user league
-- still drafts (capped, exclusive) like any other.
--
-- Shared DB with mobile: new objects only, plus guarded in-place patches of
-- live functions (pg_get_functiondef + replace, md5 + exact-anchor checks) —
-- never re-created from committed text.

-- ── 1. Flags ────────────────────────────────────────────────────────────────
alter table public.fantasy_leagues
  add column if not exists is_public boolean not null default false,
  add column if not exists is_official boolean not null default false;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'fantasy_leagues_official_is_public') then
    alter table public.fantasy_leagues
      add constraint fantasy_leagues_official_is_public check (not is_official or is_public);
  end if;
end
$c$;

create index if not exists fantasy_leagues_public_idx
  on public.fantasy_leagues (is_official desc, created_at desc) where is_public;

-- Column-level grants: fantasy_leagues SELECT is granted per column (the
-- invite token stays unreadable). Writes go through the RPCs below only.
grant select (is_public, is_official) on public.fantasy_leagues to anon, authenticated;

comment on column public.fantasy_leagues.is_public is
  'Listed in /fantasy → Public and joinable by anyone (fantasy_join_public_league). Set by the commissioner via fantasy_set_league_public.';
comment on column public.fantasy_leagues.is_official is
  'Platform-run league (owner = fantasy_platform.owner_id), created by fantasy_ensure_official_leagues. Always public, never drafts.';

-- ── 2. Platform config (service-only) ──────────────────────────────────────
create table if not exists public.fantasy_platform (
  id boolean primary key default true check (id),
  owner_id uuid not null references public.profiles (id)
);
alter table public.fantasy_platform enable row level security;
revoke all on public.fantasy_platform from anon, authenticated;
comment on table public.fantasy_platform is
  'One row: the system profile ("The Layout") that owns official leagues. No policies — service role / definer functions only.';

create table if not exists public.fantasy_official_competitions (
  competition text primary key,
  enabled boolean not null default true
);
alter table public.fantasy_official_competitions enable row level security;
revoke all on public.fantasy_official_competitions from anon, authenticated;
comment on table public.fantasy_official_competitions is
  'Which games get an automatic official league (fantasy_ensure_official_leagues). Flip enabled to pause one.';
insert into public.fantasy_official_competitions (competition) values
  ('ufa'), ('pul'), ('wul'), ('usau-club-nationals'), ('usau-college-nationals'), ('wfdf-wucc'), ('eucs')
on conflict (competition) do nothing;

-- ── 3. Join a public league ─────────────────────────────────────────────────
-- Open = some contest is not complete, still has a lock ahead, hasn't drafted,
-- and has room (unlimited, or under maxTeams). Re-joining is a no-op.
create or replace function public.fantasy_join_public_league(p_league uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_public boolean;
begin
  if v_caller is null then
    raise exception 'Sign in to join this league.' using errcode = 'P0001';
  end if;

  select is_public into v_public from public.fantasy_leagues where id = p_league;
  if v_public is null or not v_public then
    raise exception 'This league isn''t public.' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.fantasy_league_members
    where league_id = p_league and user_id = v_caller
  ) then
    return p_league;
  end if;

  if not exists (
    select 1
    from public.fantasy_contests c
    where c.league_id = p_league
      and c.status <> 'complete'
      and exists (
        select 1 from public.fantasy_contest_periods p
        where p.contest_id = c.id and p.lock_at > now()
      )
      and not exists (
        select 1 from public.fantasy_drafts d
        where d.contest_id = c.id and d.status in ('live', 'complete')
      )
      and (
        coalesce((c.settings ->> 'unlimitedTeams')::boolean, false)
        or (select count(*) from public.fantasy_teams t where t.contest_id = c.id)
           < coalesce((c.settings ->> 'maxTeams')::int, 12)
      )
  ) then
    raise exception 'This league is closed to new teams.' using errcode = 'P0001';
  end if;

  insert into public.fantasy_league_members (league_id, user_id, role)
  values (p_league, v_caller, 'member')
  on conflict (league_id, user_id) do nothing;

  return p_league;
end;
$$;

revoke execute on function public.fantasy_join_public_league(uuid) from public, anon, authenticated;
grant execute on function public.fantasy_join_public_league(uuid) to authenticated;

-- ── 4. Commissioner: make a user league public/private ──────────────────────
create or replace function public.fantasy_set_league_public(p_league uuid, p_public boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Not signed in.' using errcode = 'P0001';
  end if;
  if not public.fantasy_is_commissioner(p_league) then
    raise exception 'Only the commissioner can change league settings.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.fantasy_leagues where id = p_league and is_official) then
    raise exception 'Official leagues are always public.' using errcode = 'P0001';
  end if;
  update public.fantasy_leagues set is_public = coalesce(p_public, false) where id = p_league;
end;
$$;

revoke execute on function public.fantasy_set_league_public(uuid, boolean) from public, anon, authenticated;
grant execute on function public.fantasy_set_league_public(uuid, boolean) to authenticated;

-- ── 5. Leaderboard (ESPN-style RK / total) ─────────────────────────────────
-- Public data (teams + scores are public-read), so INVOKER. Ties share a rank.
create or replace function public.fantasy_contest_leaderboard(
  p_contest uuid,
  p_limit int default 100,
  p_offset int default 0
)
returns table (
  team_id uuid,
  team_name text,
  owner_id uuid,
  owner_display_name text,
  owner_username text,
  total_points numeric,
  rank bigint,
  total_teams bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with totals as (
    select t.id, t.team_name, t.owner_id, t.owner_display_name, t.owner_username,
           coalesce(sum(s.points), 0) as total
    from public.fantasy_teams t
    left join public.fantasy_scores s on s.team_id = t.id
    where t.contest_id = p_contest
    group by t.id
  ),
  ranked as (
    select *, rank() over (order by total desc) as rk, count(*) over () as n
    from totals
  )
  select id, team_name, owner_id, owner_display_name, owner_username, round(total, 1), rk, n
  from ranked
  order by rk, team_name, id
  limit least(greatest(coalesce(p_limit, 100), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.fantasy_contest_team_rank(p_team uuid)
returns table (rank bigint, total_teams bigint, total_points numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  with c as (
    select contest_id from public.fantasy_teams where id = p_team
  ),
  totals as (
    select t.id, coalesce(sum(s.points), 0) as total
    from public.fantasy_teams t
    left join public.fantasy_scores s on s.team_id = t.id
    where t.contest_id = (select contest_id from c)
    group by t.id
  ),
  ranked as (
    select id, total, rank() over (order by total desc) as rk, count(*) over () as n
    from totals
  )
  select rk, n, round(total, 1) from ranked where id = p_team;
$$;

-- Share of teams rostering each player in one period (ESPN's pick %).
create or replace function public.fantasy_contest_roster_pct(p_contest uuid, p_period text)
returns table (player_league text, player_id text, pct numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  with slots as (
    select s.team_id, s.player_league, s.player_id
    from public.fantasy_roster_slots s
    join public.fantasy_teams t on t.id = s.team_id
    where t.contest_id = p_contest and s.week = p_period
  ),
  n as (select count(distinct team_id) as teams from slots)
  select player_league, player_id,
         round(100.0 * count(distinct team_id) / nullif((select teams from n), 0), 1) as pct
  from slots
  group by player_league, player_id
  order by pct desc
  limit 500;
$$;

-- The /fantasy → Public list in one query (official first, then by size).
-- `open` = joinable now: a lock ahead, no live/complete draft, and room left.
create or replace function public.fantasy_public_leagues(p_limit int default 50)
returns table (
  league_id uuid,
  name text,
  logo_url text,
  logo_icon text,
  is_official boolean,
  member_count bigint,
  contest_id uuid,
  competition text,
  season_year int,
  settings jsonb,
  next_lock_at timestamptz,
  open boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  -- Candidates first (official + the newest public leagues), so the per-row
  -- counts below never scan every public league anyone ever made.
  with cand as (
    select l.id, l.name, l.logo_url, l.logo_icon, l.is_official, l.created_at
    from public.fantasy_leagues l
    where l.is_public
    order by l.is_official desc, l.created_at desc
    limit 300
  ),
  lg as (
    select l.id, l.name, l.logo_url, l.logo_icon, l.is_official, l.created_at,
           (select count(*) from public.fantasy_league_members m where m.league_id = l.id) as members,
           c.id as contest_id, c.competition, c.season_year, c.settings,
           (select min(p.lock_at) from public.fantasy_contest_periods p
             where p.contest_id = c.id and p.lock_at > now()) as next_lock,
           exists (select 1 from public.fantasy_drafts d
                   where d.contest_id = c.id and d.status in ('live', 'complete')) as drafted,
           (select count(*) from public.fantasy_teams t where t.contest_id = c.id) as teams
    from cand l
    join public.fantasy_contests c on c.league_id = l.id
    where c.status <> 'complete'
  )
  select id, name, logo_url, logo_icon, is_official, members, contest_id, competition, season_year, settings,
         next_lock,
         next_lock is not null and not drafted
           and (coalesce((settings ->> 'unlimitedTeams')::boolean, false)
                or teams < coalesce((settings ->> 'maxTeams')::int, 12))
  from lg
  order by is_official desc, members desc, created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

grant execute on function public.fantasy_contest_leaderboard(uuid, int, int) to anon, authenticated;
grant execute on function public.fantasy_public_leagues(int) to anon, authenticated;
grant execute on function public.fantasy_contest_team_rank(uuid) to anon, authenticated;
grant execute on function public.fantasy_contest_roster_pct(uuid, text) to anon, authenticated;

-- ── 6. Auto-create official leagues ─────────────────────────────────────────
-- Hourly (pg_cron). Idempotent: one official contest per (competition, event)
-- for events and per (competition, season) for weekly seasons.
--   Events: the competition's next startable event — MIRRORS
--   resolveEventForCompetition (src/lib/fantasy/leagues.ts) — once its rosters
--   are complete (every event team has roster rows).
--   Weekly: the season of the next scheduled game.
-- The contest INSERT trigger (fantasy_contests_require_open_lock) rebuilds
-- periods and refuses a game with no lock ahead; that, or any other error,
-- rolls back just that competition (savepoint) and the loop moves on.
create or replace function public.fantasy_ensure_official_leagues()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner     uuid;
  v_today     date := (now() at time zone 'America/New_York')::date;
  r           record;
  v_event_id  uuid;
  v_ev_name   text;
  v_season    int;
  v_ready     boolean;
  v_label     text;
  v_league    uuid;
  v_settings  jsonb;
  v_created   int := 0;
begin
  select owner_id into v_owner from public.fantasy_platform where id;
  if v_owner is null then
    return 0;
  end if;

  for r in select competition from public.fantasy_official_competitions where enabled order by competition loop
    begin
      v_event_id := null; v_ev_name := null; v_season := null; v_ready := false;
      v_label := case r.competition
        when 'ufa' then 'UFA Season'
        when 'pul' then 'PUL Season'
        when 'wul' then 'WUL Season'
        when 'usau-club-nationals' then 'USAU Club Nationals'
        when 'usau-college-nationals' then 'USAU College Nationals'
        when 'wfdf-wucc' then 'WFDF'
        when 'eucs' then 'EUCS (European Ultimate Club Series)'
      end;
      if v_label is null then
        continue;
      end if;

      if r.competition in ('usau-club-nationals', 'usau-college-nationals') then
        -- The season's latest-starting Nationals (tune-ups/showcases excluded).
        with hits as (
          select e.id, e.name, e.season, e.start_date
          from public.usau_events e
          where e.competition_level::text = case r.competition when 'usau-club-nationals' then 'CLUB' else 'COLLEGE_D1' end
            and e.start_date > v_today
            and (e.name ilike '%nationals%' or e.name ilike '%national championships%' or e.name ilike '%college championships%')
            and e.name not ilike '%tune up%' and e.name not ilike '%tune-up%'
            and e.name not ilike '%showcase%' and e.name not ilike '%training%'
        ),
        first_season as (
          select season from hits order by start_date asc limit 1
        )
        select h.id, h.name, h.season into v_event_id, v_ev_name, v_season
        from hits h
        where h.season = (select season from first_season)
        order by h.start_date desc
        limit 1;

        if v_event_id is not null then
          select count(*) > 0 and bool_and(exists (
                   select 1 from public.usau_rosters ro
                   where ro.event_id = et.event_id and ro.team_id = et.team_id
                 ))
            into v_ready
          from public.usau_event_teams et
          where et.event_id = v_event_id;
        end if;

      elsif r.competition = 'wfdf-wucc' then
        select e.id, e.name, e.year into v_event_id, v_ev_name, v_season
        from public.wfdf_events e
        where e.start_date > v_today
        order by e.start_date asc
        limit 1;

        if v_event_id is not null then
          select count(*) > 0 and bool_and(exists (
                   select 1 from public.wfdf_rosters ro where ro.team_id = t.id
                 ))
            into v_ready
          from public.wfdf_teams t
          where t.event_id = v_event_id;
        end if;

      elsif r.competition = 'eucs' then
        select e.id, e.name, e.year into v_event_id, v_ev_name, v_season
        from public.euf_events e
        where e.start_date > v_today and e.kind = 'eucf'
        order by e.start_date asc
        limit 1;
        if v_event_id is null then
          select e.id, e.name, e.year into v_event_id, v_ev_name, v_season
          from public.euf_events e
          where e.start_date > v_today and e.name ilike '%EUCF%'
          order by e.start_date asc
          limit 1;
        end if;

        if v_event_id is not null then
          select count(*) > 0 and bool_and(exists (
                   select 1 from public.euf_rosters ro where ro.team_id = t.id
                 ))
            into v_ready
          from public.euf_teams t
          where t.event_id = v_event_id;
        end if;

      elsif r.competition = 'ufa' then
        select g.year into v_season
        from public.ufa_games g
        where g.start_timestamp > now() and g.week is not null
        order by g.start_timestamp asc
        limit 1;
        v_ready := v_season is not null;

      elsif r.competition = 'pul' then
        select g.season into v_season from public.pul_games g
        where g.game_date > v_today order by g.game_date asc limit 1;
        v_ready := v_season is not null;

      elsif r.competition = 'wul' then
        select g.season into v_season from public.wul_games g
        where g.game_date > v_today order by g.game_date asc limit 1;
        v_ready := v_season is not null;
      end if;

      if not coalesce(v_ready, false) or v_season is null then
        continue;
      end if;

      -- Already created for this event / season?
      if exists (
        select 1
        from public.fantasy_contests c
        join public.fantasy_leagues l on l.id = c.league_id
        where l.is_official
          and c.competition = r.competition
          and c.season_year = v_season
          and (v_event_id is null or c.settings ->> 'eventId' = v_event_id::text)
      ) then
        continue;
      end if;

      if v_event_id is not null then
        v_settings := jsonb_build_object(
          'mode', 'event', 'flex', 7, 'eventId', v_event_id,
          'maxTeams', 12, 'unlimitedTeams', true
        );
      else
        -- Points format: an unlimited league can't run a head-to-head schedule.
        v_settings := jsonb_build_object(
          'mode', 'weekly-stats', 'offenders', 4, 'defenders', 3, 'format', 'points',
          'maxTeams', 12, 'unlimitedTeams', true
        );
      end if;

      insert into public.fantasy_leagues (owner_id, name, invite_token, is_public, is_official)
      values (
        v_owner,
        left(coalesce(v_ev_name, v_season::text || ' ' || v_label), 60),
        translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_'),
        true,
        true
      )
      returning id into v_league;

      insert into public.fantasy_contests (league_id, competition, season_year, name, status, settings, created_by)
      values (v_league, r.competition, v_season, left(v_label || ' ' || v_season, 60), 'open', v_settings, v_owner);

      -- USAU ratings only rebuild weekly for events that already have a
      -- contest; build them now so the Players list ranks from day one.
      if r.competition in ('usau-club-nationals', 'usau-college-nationals')
         and not exists (
           select 1 from public.fantasy_player_ratings fr
           where fr.event_id = v_event_id and fr.player_league = 'usau'
         ) then
        perform public.fantasy_rebuild_player_ratings(v_event_id);
      end if;

      v_created := v_created + 1;
    exception when others then
      raise warning 'fantasy_ensure_official_leagues: % skipped — %', r.competition, sqlerrm;
    end;
  end loop;

  return v_created;
end;
$$;

revoke execute on function public.fantasy_ensure_official_leagues() from public, anon, authenticated;

-- ── 7. Patches of live functions ───────────────────────────────────────────
do $patch$
declare
  r record;
  v_oid oid;
  v_def text;
begin
  for r in
    select * from (values
      -- Official leagues never draft.
      (1, 'public.fantasy_schedule_draft(uuid,timestamp with time zone,integer,integer)',
       '5789a9167943dd96db7cc7eae2e7e03d',
       E'  -- A draft time is required, with at least 15 minutes'' notice: manual start',
       E'  if exists (\n    select 1 from public.fantasy_contests c\n    join public.fantasy_leagues l on l.id = c.league_id\n    where c.id = p_contest and l.is_official\n  ) then\n    raise exception ''Official leagues don''''t draft — every team picks any players.'' using errcode = ''P0001'';\n  end if;\n\n  -- A draft time is required, with at least 15 minutes'' notice: manual start'),
      (2, 'public.fantasy_schedule_auction_draft(uuid,timestamp with time zone,integer,integer,integer,integer,integer)',
       '93f6e26acf154fe731767bf4333f8718',
       E'  -- A draft time is required, with at least 15 minutes'' notice: manual start',
       E'  if exists (\n    select 1 from public.fantasy_contests c\n    join public.fantasy_leagues l on l.id = c.league_id\n    where c.id = p_contest and l.is_official\n  ) then\n    raise exception ''Official leagues don''''t draft — every team picks any players.'' using errcode = ''P0001'';\n  end if;\n\n  -- A draft time is required, with at least 15 minutes'' notice: manual start'),
      -- Official leagues never change hands (the platform account keeps them).
      (3, 'public.fantasy_hand_off_league(uuid,uuid)',
       '15df8340bda7801c4582bea01fc8396a',
       E'  -- Only while p_leaving still owns it; serializes with transfer/leave/delete.',
       E'  if exists (select 1 from public.fantasy_leagues where id = p_league and is_official) then\n    return false;\n  end if;\n\n  -- Only while p_leaving still owns it; serializes with transfer/leave/delete.'),
      -- Unlimited leagues skip the contest row lock (thousands of joins would queue on it).
      (4, 'public.fantasy_teams_enforce_contest_cap()',
       '840b030477da4a09aef3c561c10c78eb',
       E'  where id = NEW.contest_id\n  for update;',
       E'  where id = NEW.contest_id;'),
      (5, 'public.fantasy_teams_enforce_contest_cap()',
       NULL,
       E'  v_max_teams := coalesce',
       E'  -- Capped league: lock the contest row so concurrent joins count in turn.\n  perform 1 from public.fantasy_contests where id = NEW.contest_id for update;\n\n  v_max_teams := coalesce'),
      -- An official league's feed stays chat + results, not one row per join.
      (6, 'public.fantasy_activity_member_joined()',
       'b3d3947870d0a6305e97d3e4a6c2d1e8',
       E'begin\n  insert into public.fantasy_league_activity',
       E'begin\n  if exists (select 1 from public.fantasy_leagues where id = new.league_id and is_official) then\n    return new;\n  end if;\n  insert into public.fantasy_league_activity'),
      (7, 'public.fantasy_activity_team_created()',
       'bb0221c26c822d44ea174945aaa5a8fe',
       E'  select league_id into v_league from public.fantasy_contests where id = new.contest_id;\n',
       E'  select league_id into v_league from public.fantasy_contests where id = new.contest_id;\n  if exists (select 1 from public.fantasy_leagues where id = v_league and is_official) then\n    return new;\n  end if;\n'),
      -- Official chat: one message per 10 s per person on top of 30 / 10 min.
      (8, 'public.fantasy_league_messages_rate_limit()',
       '82f634394ecf613d6c17d157151bf61d',
       E'  return new;\nend;',
       E'  if exists (select 1 from public.fantasy_leagues where id = new.league_id and is_official)\n     and exists (\n       select 1 from public.fantasy_league_messages\n       where league_id = new.league_id and user_id = new.user_id\n         and created_at > now() - interval ''10 seconds''\n     ) then\n    raise exception ''Slow down — one message every 10 seconds.'' using errcode = ''check_violation'';\n  end if;\n  return new;\nend;')
    ) as t(ord, sig, md5, anchor, repl)
    order by ord
  loop
    v_oid := to_regprocedure(r.sig);
    if v_oid is null then raise exception '% not found', r.sig; end if;
    if r.md5 is not null and (select md5(prosrc) from pg_proc where oid = v_oid) <> r.md5 then
      raise exception '% changed since it was read (md5) — re-read before patching', r.sig;
    end if;
    v_def := pg_get_functiondef(v_oid);
    if (length(v_def) - length(replace(v_def, r.anchor, ''))) / length(r.anchor) <> 1 then
      raise exception '%: anchor not found exactly once', r.sig;
    end if;
    execute replace(v_def, r.anchor, r.repl);
  end loop;
end
$patch$;

-- Admins moderate official-league chat (no human commissioner there).
drop policy if exists "fantasy_league_messages admin delete official" on public.fantasy_league_messages;
create policy "fantasy_league_messages admin delete official"
  on public.fantasy_league_messages
  for delete
  to authenticated
  using (
    public.is_admin()
    and exists (select 1 from public.fantasy_leagues l where l.id = league_id and l.is_official)
  );

-- ── 8. Schedule ─────────────────────────────────────────────────────────────
select cron.unschedule(jobid) from cron.job where jobname = 'fantasy-ensure-official-leagues';
select cron.schedule(
  'fantasy-ensure-official-leagues',
  '7 * * * *',
  $cron$select public.fantasy_ensure_official_leagues()$cron$
);

notify pgrst, 'reload schema';
