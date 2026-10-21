-- Event search: year filter, a "nationals" synonym, newest-first ranking
-- (Hunter, 2026-10-20: "nationals" and "2025 nationals" didn't work).
--
-- 1. A 4-digit year in the query is a filter on season, not text to match.
--    "2025 nationals" used to rank 2026 first and pad with any fuzzy hit.
-- 2. "national(s)" matches every event USAU ran as Nationals. USAU called Club
--    Nationals "USA Ultimate National Championships" (2014-2022) and "Club
--    Championships" (2023-2024), so no text match on "nationals" can find
--    those years; the usau_is_nationals_name rules (inlined) know every era.
--    Leftover words ("club", "college", "d-iii", "masters") narrow by name or
--    competition level, since the old club names don't say "club".
-- 3. Periods/apostrophes are ignored for text matches ("us open" finds "U.S. Open").
-- 4. Strong matches first, then newest season first.
-- 5. The query is capped at 100 chars (anon-callable, 2 vCPU DB).
-- Signature and return shape are unchanged.

create or replace function public.search_usau_event_groups_fuzzy(q text, lim integer)
returns table(slug text, name text, season integer, start_date date, end_date date, division text, score real)
language sql
stable
set search_path to 'public', 'extensions'
as $function$
  with capped as (
    -- Anon-callable: bound the per-row word_similarity work.
    select left(q, 100) as q
  ), parsed as (
    select
      substring(c.q from '\m((?:19|20)\d{2})\M')::int as yr,
      btrim(regexp_replace(regexp_replace(c.q, '\m(19|20)\d{2}\M', ' ', 'g'), '\s+', ' ', 'g')) as rest
    from capped c
  ), terms as (
    select
      yr,
      rest,
      rest ~* '\mnationals?\M' as wants_nat,
      btrim(regexp_replace(regexp_replace(rest, '\mnationals?\M', ' ', 'gi'), '\s+', ' ', 'g')) as nat_rest
    from parsed
  ), scored as (
    select
      e.*,
      t.*,
      -- Inline copy of usau_is_nationals_name: that function is revoked from
      -- anon, and this one runs as the caller.
      t.wants_nat
      and lower(e.name) !~ '(regional|sectional|conference)'
      and lower(e.name) !~ '(u\.?\s?s\.?\s?open|pro[- ]?championship|pro[- ]?elite|tune ?up|warm ?up|\yinvite\y)'
      and lower(e.name) !~ '(wucc|wmucc|wjuc|worlds?\y)'
      and lower(e.name) !~ '(high school|middle school|\yyouth\y|state championship)'
      and lower(e.name) ~ '(national championship|club nationals|club championship|college championship|masters championship)'
      and (
        t.nat_rest = ''
        or (e.name || ' ' || lower(replace(e.competition_level::text, '_', ' '))) ilike '%' || t.nat_rest || '%'
        or word_similarity(t.nat_rest, e.name || ' ' || lower(replace(e.competition_level::text, '_', ' '))) >= 0.5
      ) as nat_hit,
      -- "U.S. Open" → "US Open", so a typed "us open" is a text match.
      regexp_replace(e.name, '[.'']', '', 'g') as bare
    from public.usau_events e
    cross join terms t
    where t.yr is null or e.season = t.yr
  ), hits as (
    select
      coalesce(s.series_group_key, s.usau_slug) as slug,
      coalesce(s.series_group_name, s.name) as name,
      s.season,
      s.start_date,
      s.end_date,
      s.series_division,
      greatest(
        case when s.nat_hit or s.rest = '' or s.name ilike '%' || s.rest || '%' or s.bare ilike '%' || s.rest || '%' then 1.0 else 0 end,
        case when s.rest <> '' then word_similarity(s.rest, s.name) else 0 end
      )::real as score
    from scored s
    where s.nat_hit
       or s.rest = ''
       or s.name ilike '%' || s.rest || '%'
       or s.bare ilike '%' || s.rest || '%'
       or word_similarity(s.rest, s.name) >= 0.4
  ), ranked as (
    select h.*, max(h.score) over (partition by h.slug) as top
    from hits h
  )
  select
    r.slug,
    min(r.name),
    min(r.season),
    min(r.start_date),
    max(r.end_date),
    case when count(*) filter (where r.score = r.top) = 1
      then max(r.series_division) filter (where r.score = r.top)
    end,
    max(r.score)
  from ranked r
  group by r.slug
  order by max(r.score) >= 0.99 desc, min(r.season) desc, max(r.score) desc, min(r.start_date) desc nulls last
  limit least(coalesce(lim, 24), 50);
$function$;

notify pgrst, 'reload schema';
