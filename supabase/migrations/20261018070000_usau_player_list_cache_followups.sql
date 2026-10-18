-- USAU Players list cache: security-review follow-ups (2026-10-18).
--
-- 1. _list_usau_players_live runs as the owner inside the SECURITY DEFINER
--    list_usau_players, so pin pg_temp last like the wrapper: a temp relation
--    can never shadow a public table. Metadata only; prosrc is unchanged.
-- 2. Champion years in the cached lists come from usau_games, which the
--    roster-write check never saw, so a new Nationals final reached the default
--    lists only at the daily rebuild. The refresh now also rebuilds when the
--    Club champions change (md5 of _usau_club_champions_json, ~22 ms per tick).
--    champions_md5 starts NULL, so the first tick after this rebuilds once.

alter function public._list_usau_players_live(integer, integer, text, text, text, jsonb)
  set search_path = public, pg_temp;

alter table public.usau_player_list_state add column champions_md5 text;

do $guard$
begin
  if (select md5(prosrc) from pg_proc
       where oid = to_regprocedure('public.refresh_usau_player_list_cache(boolean)'))
     <> '5535ca6c5f9b819db99abac3565dc075' then
    raise exception 'refresh_usau_player_list_cache changed since 2026-10-18 (md5): re-read it before replacing';
  end if;
end
$guard$;

create or replace procedure public.refresh_usau_player_list_cache(p_force boolean default false)
language plpgsql
as $fn$
declare
  v_writes   bigint;
  v_last     bigint;
  v_at       timestamptz;
  v_champs   jsonb;
  v_md5      text;
  v_last_md5 text;
  r          record;
begin
  select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) into v_writes
    from pg_catalog.pg_stat_user_tables
   where schemaname = 'public' and relname in ('usau_rosters', 'usau_players', 'usau_teams');
  v_champs := public._usau_club_champions_json();
  v_md5 := md5(coalesce((select string_agg(e::text, ',' order by e::text)
                           from jsonb_array_elements(v_champs) e), ''));
  select roster_writes, refreshed_at, champions_md5 into v_last, v_at, v_last_md5
    from public.usau_player_list_state;
  -- Rebuild after roster writes (counters moved, or reset by a restart), when
  -- the Club champions change, and at least daily; otherwise nothing to do.
  if not p_force and v_writes = v_last and v_md5 = v_last_md5
     and v_at > now() - interval '1 day' then
    return;
  end if;

  for r in
    select l.level, d.division
      from unnest(array['CLUB', 'COLLEGE_D1', 'COLLEGE_D3', 'MASTERS', 'GRAND_MASTERS', 'GREAT_GRAND_MASTERS']) as l(level)
     cross join unnest(array['Men', 'Women', 'Mixed']) as d(division)
     where not (l.level like 'COLLEGE%' and d.division = 'Mixed')   -- college has no Mixed
  loop
    insert into public.usau_player_list_cache as c (level, division, rows, built_at)
    values (r.level, r.division,
            public._list_usau_players_live(500, null, r.division, r.level, null,
              case when r.level = 'CLUB' then v_champs else '[]'::jsonb end),
            now())
    on conflict (level, division) do update set rows = excluded.rows, built_at = excluded.built_at;
    commit;
  end loop;

  update public.usau_player_list_state
     set roster_writes = v_writes, champions_md5 = v_md5, refreshed_at = now();
  commit;
end
$fn$;
revoke execute on procedure public.refresh_usau_player_list_cache(boolean) from public, anon, authenticated;
