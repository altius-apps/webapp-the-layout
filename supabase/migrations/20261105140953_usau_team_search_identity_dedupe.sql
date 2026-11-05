-- search_usau_teams_fuzzy: one row per team IDENTITY, not per registration.
--
-- usau_teams holds a row per event registration (17.5k rows / 5.2k teams), and
-- every substring hit scored 1.0 with only an alphabetical tiebreak. "Colorado"
-- has 25 rows named exactly "Colorado" (Mamabird + Kali, one per season), so
-- the 24-row cap was filled entirely by duplicates: every other Colorado team
-- was starved out, and the clients' (name, level) dedupe collapsed Men + Women
-- into one arbitrary row (Women won → Mamabird vanished).
--
-- Now: collapse to (lower(name), gender_division, competition_level) BEFORE
-- the cap — the same identity getTeam clusters on, so any id in the cluster
-- opens the merged team page. Representative id prefers a row with a state,
-- then the most recently scraped. Cap survivors ranked by exact > prefix >
-- contains, then non-youth (mirrors YOUTH_NAME_RE in the search data layer),
-- then registration count (activity proxy), then name.
--
-- Signature, RETURNS TABLE columns, STABLE, search_path pin, left(q, 100) cap
-- and the 50-row clamp are unchanged, so grants and both clients still work.

create or replace function public.search_usau_teams_fuzzy(q text, lim integer default 24)
returns table(id uuid, name text, state text, competition_level text, gender_division text, score real)
language sql
stable
set search_path to 'public', 'extensions'
as $function$
  with params as (select left(q, 100) as q),
  hits as (
    select t.id, t.name, t.state, t.competition_level, t.gender_division, t.last_scraped_at,
           greatest(case when t.name ilike '%' || p.q || '%' then 1.0 else 0 end,
                    word_similarity(p.q, t.name))::real as score,
           case when lower(t.name) = lower(p.q) then 0
                when t.name ilike p.q || '%' then 1
                else 2 end as tier
    from public.usau_teams t
    cross join params p
    where t.name ilike '%' || p.q || '%' or word_similarity(p.q, t.name) >= 0.4
  ),
  idents as (
    select distinct on (lower(h.name), h.gender_division, h.competition_level)
           h.id, h.name, h.state, h.competition_level, h.gender_division, h.score, h.tier,
           count(*) over w as registrations
    from hits h
    window w as (partition by lower(h.name), h.gender_division, h.competition_level)
    order by lower(h.name), h.gender_division, h.competition_level,
             (h.state is null), h.last_scraped_at desc nulls last, h.id
  )
  select i.id, i.name, i.state, i.competition_level::text, i.gender_division::text, i.score
  from idents i
  order by i.score desc, i.tier,
           (i.name ~* '\m(u-?\d{2}|under[- ]?\d{2}|youth|academy|middle school|high school|boys|girls|hs|ms)\M'),
           i.registrations desc, i.name
  limit least(coalesce(lim, 24), 50);
$function$;

notify pgrst, 'reload schema';
