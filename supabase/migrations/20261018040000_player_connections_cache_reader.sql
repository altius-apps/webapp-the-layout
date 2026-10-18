-- Connections cache, step 2 of 2: get_player_connections reads the cache
-- (Hunter-approved plan, 2026-10-16; switched 2026-10-18).
--
-- Gate met before switching: player_connections_cache 57,824 / 57,824 nodes
-- filled (0 pending), and a 25-name random sample of cached top-5 vs the live
-- function was identical (0 row diffs, 0 name diffs).
--
-- Same signature, column names/types/order and p_limit clamp, so web and the
-- mobile app need no change. A name with no filled row returns no rows, the
-- same as a graph miss before. SECURITY DEFINER with a pinned search_path so
-- the cache table stays private (RLS on, no client grants); CREATE OR REPLACE
-- keeps the existing EXECUTE grants. Before: ~45 ms graph walk + up to 20
-- find_usau_player_by_name lookups per call (366 ms prod average, the source of
-- the 3 s timeouts). After: one primary-key read.
--
-- Rollback: re-create the previous body (pg_get_functiondef captured
-- 2026-10-18, md5(prosrc) 7e3a715ba8766ff760ff347185d63ef6) — kept verbatim in
-- the vault note Ops/Security & Efficiency Backlog.md § 10-18.

do $guard$
begin
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.get_player_connections(text,integer)'))
       <> '7e3a715ba8766ff760ff347185d63ef6' then
    raise exception 'get_player_connections changed since 2026-10-18 (md5): re-read it before replacing';
  end if;
end
$guard$;

create or replace function public.get_player_connections(p_name text, p_limit integer default 5)
 returns table(name text, display_name text, leagues text[], score numeric, bridge_count integer,
               via_display text, is_pro boolean, is_nationals boolean, is_alumni boolean, usau_id uuid)
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select c.name, c.display_name, c.leagues, c.score, c.bridge_count, c.via_display,
         c.is_pro, c.is_nationals, c.is_alumni, c.usau_id
    from public.player_connections_cache k
   cross join lateral jsonb_to_recordset(k.conns) as c(rank int, name text, display_name text, leagues text[],
          score numeric, bridge_count int, via_display text, is_pro boolean, is_nationals boolean,
          is_alumni boolean, usau_id uuid)
   where k.name_key = public.normalize_player_name(p_name)
   order by c.rank
   limit least(greatest(coalesce(p_limit, 5), 1), 20)
$function$;

notify pgrst, 'reload schema';
