-- Public leagues: leave out the ones the caller is already in (Hunter,
-- 2026-10-14: "if I'm IN the league it should only show up under My
-- Leagues"). Filtered in the candidate set so joined leagues don't use up the
-- 300 candidate slots. Mobile calls the same RPC, so both apps get it.
--
-- Patches the live function body in place (shared DB with mobile — never
-- re-create from committed text). Must still be the 20261014191428 version
-- (md5 of prosrc) with exactly one anchor. pg_get_functiondef keeps security
-- invoker, search_path and grants.
do $patch$
declare
  v_oid oid := to_regprocedure('public.fantasy_public_leagues(integer)');
  v_def text;
  v_anchor text := E'    where l.is_public\n';
begin
  if v_oid is null then raise exception 'fantasy_public_leagues(integer) not found'; end if;
  if (select md5(prosrc) from pg_proc where oid = v_oid) <> '02088db4c6732971287c14ff2466e741' then
    raise exception 'fantasy_public_leagues changed since 20261014191428 (md5) — re-read it before patching';
  end if;
  v_def := pg_get_functiondef(v_oid);
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'fantasy_public_leagues: expected exactly one candidate where-clause';
  end if;
  execute replace(v_def, v_anchor, v_anchor ||
    E'      and not exists (select 1 from public.fantasy_league_members m\n' ||
    E'                      where m.league_id = l.id and m.user_id = (select auth.uid()))\n');
end
$patch$;

notify pgrst, 'reload schema';
