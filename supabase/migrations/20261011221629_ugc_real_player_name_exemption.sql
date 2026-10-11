-- Hunter 2026-10-11: jersey listings and chat may name real players whose
-- names contain a blocked word (Evan Coon, Zoey Rape, Jason Dick), verified
-- against our player tables, never on the writer's say-so. User names
-- (display/team/league) get no exemption: name_is_clean is unchanged.

-- The text with every 2-4 word run that exactly matches a real player's full
-- name (any league, case-insensitive) removed. Capped at 2000 chars.
create or replace function public.mask_real_player_names(p_text text)
returns text
language sql
stable
set search_path = ''
as $$
  with w as (
    select t.ord, t.word,
           lower(regexp_replace(t.word, '^[^[:alnum:]]+|[^[:alnum:]]+$', '', 'g')) as norm
    from regexp_split_to_table(left(coalesce(p_text, ''), 2000), '\s+') with ordinality as t(word, ord)
  ),
  grams as (
    select a.ord as first_ord, a.ord + n.n - 1 as last_ord,
           (select string_agg(b.norm, ' ' order by b.ord) from w b
             where b.ord between a.ord and a.ord + n.n - 1) as name
    from w a
    cross join generate_series(2, 4) as n(n)
    where a.ord + n.n - 1 <= (select max(ord) from w)
  ),
  candidates as (select array_agg(distinct name) as names from grams),
  real_names as (
    select lower(p.full_name) as name from public.ufa_players p, candidates c where lower(p.full_name) = any(c.names)
    union select lower(p.display_name) from public.usau_players p, candidates c where lower(p.display_name) = any(c.names)
    union select lower(p.full_name) from public.wfdf_rosters p, candidates c where lower(p.full_name) = any(c.names)
    union select lower(p.player_name) from public.pul_players p, candidates c where lower(p.player_name) = any(c.names)
    union select lower(p.player_name) from public.wul_players p, candidates c where lower(p.player_name) = any(c.names)
    union select g.name from grams g
          where exists (select 1 from public.euf_rosters r where r.name_key = public.compact_name_key(g.name))
  ),
  hits as (select g.first_ord, g.last_ord from grams g join real_names r on r.name = g.name)
  select coalesce(string_agg(w.word, ' ' order by w.ord), '')
  from w
  where not exists (select 1 from hits h where w.ord between h.first_ord and h.last_ord);
$$;

-- jersey_text_is_clean, retried with real player names removed. Only pays for
-- the player lookup when the plain check fails.
create or replace function public.ugc_text_is_clean(p_text text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case when public.jersey_text_is_clean(p_text) then true
              else public.jersey_text_is_clean(public.mask_real_player_names(p_text)) end;
$$;

revoke execute on function public.mask_real_player_names(text) from public, anon;
revoke execute on function public.ugc_text_is_clean(text) from public, anon;
grant execute on function public.mask_real_player_names(text) to authenticated;
grant execute on function public.ugc_text_is_clean(text) to authenticated;

-- Jersey/chat triggers and trade notes switch to the exemption-aware check.
-- Patched from the live bodies (shared with mobile; never re-create from repo text).
do $$
declare
  f text;
  d text;
begin
  foreach f in array array[
    'fantasy_league_messages_reject_profanity', 'jersey_reject_profanity',
    'jersey_wants_reject_profanity', 'jersey_messages_reject_profanity',
    'jersey_events_reject_profanity', 'jersey_listings_reject_profanity_v2',
    'jersey_wants_reject_profanity_v2', 'fantasy_propose_trade'
  ] loop
    select pg_get_functiondef(p.oid) into strict d
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f;
    if position('public.jersey_text_is_clean(' in d) = 0 then
      raise exception '% has no jersey_text_is_clean call', f;
    end if;
    execute replace(d, 'public.jersey_text_is_clean(', 'public.ugc_text_is_clean(');
  end loop;
end $$;

notify pgrst, 'reload schema';
