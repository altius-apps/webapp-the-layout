-- Security review 2026-10-19 (MEDIUM): an empty or 1-character p_search skipped
-- the cache and ran the full live aggregate (~2-5 s, anon cap 3 s), a cheap way
-- to burn DB CPU. Both apps already send a search only at >= 2 characters, so
-- shorter searches now count as no search and the default list comes from the
-- cache when level and division are set. Shape and signature unchanged.

do $guard$
begin
  if (select md5(prosrc) from pg_proc
       where oid = to_regprocedure('public.list_usau_players(integer,integer,text,text,text,jsonb)'))
     <> '14531e751a11076e80dfed3c9e340405' then
    raise exception 'list_usau_players changed since 2026-10-18 (md5): re-read it before replacing';
  end if;
end
$guard$;

create or replace function public.list_usau_players(p_limit integer DEFAULT 60, p_season integer DEFAULT NULL::integer, p_division text DEFAULT NULL::text, p_level text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_champions jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(
    -- Default list: a slice of the precomputed top 500 (an existing row with
    -- no players still answers '[]' without falling through).
    (select coalesce((select jsonb_agg(e.v order by e.i)
                        from jsonb_array_elements(c.rows) with ordinality as e(v, i)
                       where e.i <= least(greatest(coalesce(p_limit, 60), 1), 500)), '[]'::jsonb)
       from public.usau_player_list_cache c
      where s.q is null and p_season is null
        and c.level = p_level and c.division = p_division),
    public._list_usau_players_live(p_limit, p_season, p_division, p_level, s.q, p_champions)
  )
  from (select case when length(btrim(coalesce(p_search, ''))) >= 2 then btrim(p_search) end as q) s;
$function$;
grant execute on function public.list_usau_players(integer, integer, text, text, text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
