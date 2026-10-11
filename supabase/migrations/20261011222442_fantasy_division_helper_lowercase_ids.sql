-- fantasy_draft_player_in_division accepted upper-case ids (case-insensitive
-- regex) and the uuid cast then matched the roster, but picks store player_id as
-- text, so 'ABC…' slips past the "already drafted" check and the unique key and
-- the same player could be drafted twice in a division league (security review,
-- 2026-10-11). USAU ids are always uuid::text (lower case): accept only that.
create or replace function public.fantasy_draft_player_in_division(
  p_contest public.fantasy_contests,
  p_player_league text,
  p_player_id text
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when coalesce(p_contest.settings ->> 'division', 'all') = 'all' then true
    when p_player_league is distinct from 'usau'
      or p_player_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then false
    else exists (
      select 1
      from public.usau_rosters r
      join public.usau_teams t on t.id = r.team_id
      where r.event_id = (p_contest.settings ->> 'eventId')::uuid
        and r.player_id = p_player_id::uuid
        and lower(t.gender_division::text) = p_contest.settings ->> 'division'
    )
  end;
$$;

revoke execute on function public.fantasy_draft_player_in_division(public.fantasy_contests, text, text) from public, anon, authenticated;
