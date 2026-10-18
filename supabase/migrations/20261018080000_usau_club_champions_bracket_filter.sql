-- Club champions: one rule on web, mobile and SQL (Hunter, 2026-10-18: "yes").
--
-- Mobile's getUsauClubChampionsBySeason (since 08-03) crowns a final only from the
-- gold-medal bracket (isChampionshipBracketName) and skips tied finals, then the
-- latest-scheduled final wins. Web's src/lib/usau/data.ts now does the same, and
-- so does this SQL mirror. _usau_is_championship_bracket is a line-for-line port
-- of the TS isChampionshipBracketName + isPlacementBracketName (keep them in
-- sync); checked equal to the TS on every distinct usau_games.bracket_name.
-- Same 33 champions as before, so the cached player lists need no rebuild.

create function public._usau_is_championship_bracket(p_name text)
returns boolean
language sql
immutable
set search_path to 'public', 'pg_temp'
as $fn$
  select case
    when b = '' then false
    when b ~ '\y1st place\y' or b ~ '\yfirst place\y' then true
    when b = '1st' then true
    when b ~ '\y[0-9]+(st|nd|rd|th)\y' then false
    when case   -- isPlacementBracketName
           when b ~ '\y1st\y' or b ~ '\yfirst\y' then false
           when b ~ '\y[0-9]+(st|nd|rd|th)\y' then true
           when b ~ ('\y(' || o || ')\s+place\y') then true
           when regexp_replace(regexp_replace(b, '^.*[·:]\s*', ''), '^\s+|\s+$', '', 'g') ~ ('^(' || o || ')$') then true
           when b ~ 'backdoor|game[- ]to[- ]go|\yg2g\y' then true
           else position('consolation' in b) > 0 or position('placement' in b) > 0
         end then false
    when b = 'finals' then true
    when b ~ '(^|\s)championship(\s+(bracket|final|game))?$' then true
    when b in ('bracket', 'bracket play', 'sunday bracket') then true
    when b = 'champs' then true
    else false
  end
  from (select lower(regexp_replace(regexp_replace(coalesce(p_name, ''), '^.*·', ''), '^\s+|\s+$', '', 'g')) as b,
               'second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth'::text as o) t
$fn$;
revoke execute on function public._usau_is_championship_bracket(text) from public, anon, authenticated;

do $guard$
begin
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('public._usau_club_champions_json()'))
     <> '07dbd4b217d00df0021fb6a9e1386c2d' then
    raise exception '_usau_club_champions_json changed since 2026-10-18 (md5): re-read it before replacing';
  end if;
end
$guard$;

create or replace function public._usau_club_champions_json()
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $fn$
  with nationals as (
    select e.id, e.season from public.usau_events e
     where e.competition_level = 'CLUB'
       and (e.usau_slug ilike '%national-championships%' or e.usau_slug ilike '%club-nationals%'
            or e.usau_slug ilike '%usa-ultimate-club-championships%')
       and e.usau_slug not ilike '%us-open%'
  ),
  finals as (
    select n.season, g.scheduled_at, g.id as game_id,
           case when g.score_a > g.score_b then g.team_a_id else g.team_b_id end as team_id,
           coalesce(case when g.score_a > g.score_b then ta.gender_division::text else tb.gender_division::text end,
                    case when lower(coalesce(g.bracket_name, '')) like '%mixed%' then 'Mixed'
                         when lower(coalesce(g.bracket_name, '')) like '%women%' then 'Women'
                         when lower(coalesce(g.bracket_name, '')) like '%men%' then 'Men' end) as division
      from public.usau_games g
      join nationals n on n.id = g.event_id
      left join public.usau_teams ta on ta.id = g.team_a_id
      left join public.usau_teams tb on tb.id = g.team_b_id
     where g.round = 'final' and g.score_a is not null and g.score_b is not null
       and g.score_a <> g.score_b
       and g.team_a_id is not null and g.team_b_id is not null
       and public._usau_is_championship_bracket(g.bracket_name)
  )
  select coalesce(jsonb_agg(jsonb_build_object('season', season, 'division', division, 'team_id', team_id)), '[]'::jsonb)
  from (select distinct on (season, division) season, division, team_id
          from finals where division is not null
         order by season, division, scheduled_at desc nulls last, game_id) w;
$fn$;
revoke execute on function public._usau_club_champions_json() from public, anon, authenticated;
