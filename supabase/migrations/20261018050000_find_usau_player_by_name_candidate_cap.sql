-- find_usau_player_by_name: bound the cost of ANY last-name token (security
-- review 2026-10-18 follow-up to 20261018030000; Hunter approved the DoS fix).
--
-- The short-token guard closed 1–2 character tokens, but cost tracks how many
-- names CONTAIN the token, and normalizing each candidate is the expensive
-- part: "son" matches 25k of 408k names (4.6 s), "ell" 19k (3.6 s), "ann" 12k,
-- "mar" 12k. Anon could still burn up to its 3 s statement_timeout per POST.
-- Real surnames sit far below that ("lee" 3.4k, "smith" 2.7k, "chen" 2.2k).
--
-- Now candidates are gathered once into a CTE capped at 5,001 rows; over 5,000
-- returns null without running names_match. Measured in a rolled-back dry run:
-- son/ell/ann/mar ~0.42 s each (null); Lee 0.86 → 0.69 s, Smith 0.60 → 0.58 s,
-- Johnson 0.53 → 0.44 s, Chen 0.48 → 0.44 s, Lundquist 61 → 18 ms — same ids.
-- Tokens matching > 5,000 names stop resolving; they took > 2 s and mostly hit
-- anon's 3 s timeout before.
--
-- Full body replacement (the WHERE becomes a CTE), guarded by the live md5.
-- Same signature and attributes (LANGUAGE sql, STABLE, invoker,
-- search_path=public); CREATE OR REPLACE keeps the grants.

do $guard$
begin
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.find_usau_player_by_name(text)'))
       <> 'a9979a66cb0153e8e1ab39c1c8fa5c13' then
    raise exception 'find_usau_player_by_name changed since 2026-10-18 (md5): re-read it before replacing';
  end if;
end
$guard$;

create or replace function public.find_usau_player_by_name(p_name text)
 returns uuid
 language sql
 stable
 set search_path to 'public'
as $function$
  with tok as (
    select split_part(public.normalize_player_name(p_name), ' ',
             array_length(regexp_split_to_array(public.normalize_player_name(p_name), '\s+'), 1)) as t
  ),
  cand as materialized (
    select p.id, p.display_name
    from public.usau_players p, tok
    where length(tok.t) >= 3
      and public.normalize_player_name(p.display_name) ilike '%' || tok.t || '%'
    limit 5001
  )
  select c.id
  from cand c
  where (select count(*) from cand) <= 5000
    and public.names_match(p_name, c.display_name)
  order by (
    select count(distinct (r.team_id, r.season))
    from public.usau_rosters r
    where r.player_id = c.id
  ) desc, c.id
  limit 1;
$function$;

notify pgrst, 'reload schema';
