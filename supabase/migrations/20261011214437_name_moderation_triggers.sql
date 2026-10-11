-- Backlog #29 part 2: reject bad names at the DB, not just in the client.
-- Only fires when the name actually changes, so existing rows and unrelated
-- updates (avatar, phone) are untouched. 0 existing rows failed on 2026-10-11.

-- Profiles: signup (handle_new_user, often an OAuth email prefix) must never
-- fail, so on INSERT a bad name is cleared; edits are rejected.
create or replace function public.profiles_moderate_names()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not public.name_is_clean(new.display_name) then new.display_name := null; end if;
    if not public.name_is_clean(new.username) then new.username := null; end if;
  elsif (new.display_name is distinct from old.display_name and not public.name_is_clean(new.display_name))
     or (new.username is distinct from old.username and not public.name_is_clean(new.username)) then
    raise exception 'That name isn''t allowed. Please choose another.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_moderate_names on public.profiles;
create trigger profiles_moderate_names
before insert or update of display_name, username on public.profiles
for each row execute function public.profiles_moderate_names();

-- Fantasy team/league/contest names: TG_ARGV = the name column(s) to check.
create or replace function public.reject_unclean_names()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  col text;
  val text;
begin
  foreach col in array tg_argv loop
    val := to_jsonb(new) ->> col;
    if (tg_op = 'INSERT' or val is distinct from to_jsonb(old) ->> col)
       and not public.name_is_clean(val) then
      raise exception 'That name isn''t allowed. Please choose another.' using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists fantasy_teams_moderate_name on public.fantasy_teams;
create trigger fantasy_teams_moderate_name
before insert or update of team_name on public.fantasy_teams
for each row execute function public.reject_unclean_names('team_name');

drop trigger if exists fantasy_leagues_moderate_name on public.fantasy_leagues;
create trigger fantasy_leagues_moderate_name
before insert or update of name on public.fantasy_leagues
for each row execute function public.reject_unclean_names('name');

drop trigger if exists fantasy_contests_moderate_name on public.fantasy_contests;
create trigger fantasy_contests_moderate_name
before insert or update of name on public.fantasy_contests
for each row execute function public.reject_unclean_names('name');

revoke execute on function public.profiles_moderate_names() from public, anon, authenticated;
revoke execute on function public.reject_unclean_names() from public, anon, authenticated;
