-- mask_real_player_names, final body. Worst case at 2000 chars went from
-- ~480 ms to ~32 ms:
--  - grams built with lead() in one pass (was a correlated rescan per gram);
--  - pul/euf matched by hash join on lower(name) (was compact_name_key per gram
--    and a linear = any() on pul_players, which has no lower() index);
--  - matched word positions computed once (materialized) and filtered with a
--    hashed NOT IN (the anti-join re-ran the lookup once per word).
-- Unchanged over 2000 chars: it never drops input (see 20261011223113).
create or replace function public.mask_real_player_names(p_text text)
returns text
language sql
stable
set search_path = ''
as $$
  select case when p_text is null or length(p_text) > 2000 then p_text else (
    with w as (
      select t.ord, t.word,
             lower(regexp_replace(t.word, '^[^[:alnum:]]+|[^[:alnum:]]+$', '', 'g')) as norm
      from regexp_split_to_table(p_text, '\s+') with ordinality as t(word, ord)
    ),
    runs as (
      select ord, norm,
             lead(norm, 1) over o as n1, lead(norm, 2) over o as n2, lead(norm, 3) over o as n3
      from w
      window o as (order by ord)
    ),
    grams as materialized (
      select ord as first_ord, ord + 1 as last_ord, norm || ' ' || n1 as name from runs where n1 is not null
      union all
      select ord, ord + 2, norm || ' ' || n1 || ' ' || n2 from runs where n2 is not null
      union all
      select ord, ord + 3, norm || ' ' || n1 || ' ' || n2 || ' ' || n3 from runs where n3 is not null
    ),
    candidates as (select array_agg(distinct name) as names from grams),
    cand as (select distinct name from grams),
    real_names as (
      select lower(p.full_name) as name from public.ufa_players p, candidates c where lower(p.full_name) = any(c.names)
      union select lower(p.display_name) from public.usau_players p, candidates c where lower(p.display_name) = any(c.names)
      union select lower(p.full_name) from public.wfdf_rosters p, candidates c where lower(p.full_name) = any(c.names)
      union select lower(p.player_name) from public.wul_players p, candidates c where lower(p.player_name) = any(c.names)
      union select n.name from public.pul_players p join cand n on lower(p.player_name) = n.name
      union select n.name from public.euf_rosters p join cand n on lower(p.full_name) = n.name
    ),
    masked as materialized (
      select distinct generate_series(g.first_ord, g.last_ord) as ord
      from grams g join real_names r on r.name = g.name
    )
    select coalesce(string_agg(w.word, ' ' order by w.ord), '')
    from w
    where w.ord not in (select ord from masked)
  ) end;
$$;
