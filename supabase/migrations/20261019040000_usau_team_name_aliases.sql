-- USAU team name aliases: one name per team across seasons (Hunter, 2026-10-18:
-- "add a database safety net that maps known name variants to one team name").
--
-- Cross-season team identity is lower(name) + gender_division + competition_level,
-- so a USAU rename or spelling variant ("Rhino" → "Rhino Slam!", "Dig" → "DiG")
-- splits one team's history. usau_team_name_aliases maps a variant's key
-- (lowercase letters and digits only) to the team's canonical name within one
-- division and level:
-- * the usau_teams trigger rewrites any inserted or renamed row to the canonical
--   name, whichever path writes it (HTML scrape, ultirzr, manual SQL);
-- * sync-event-details resolveTeam looks teams up by the canonical name, so a
--   variant joins the season's existing row instead of inserting a duplicate.
-- Rows are added only for teams confirmed to be the same team (no season with
-- both names, plus shared rosters, same region, or same school). The table
-- ships empty; the data change that fills it runs after the edge deploy.
-- Private: RLS on, no policies, no grants.

create table public.usau_team_name_aliases (
  alias_key         text not null,
  gender_division   public.usau_gender_division not null,
  competition_level public.usau_competition_level not null,
  canonical_name    text not null,
  note              text,
  created_at        timestamptz not null default now(),
  primary key (alias_key, gender_division, competition_level)
);
alter table public.usau_team_name_aliases enable row level security;
revoke all on public.usau_team_name_aliases from public, anon, authenticated;

create function public.usau_team_name_key(p_name text)
returns text
language sql
immutable
set search_path to 'public', 'pg_temp'
as $fn$
  select regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]', '', 'g')
$fn$;
revoke execute on function public.usau_team_name_key(text) from public, anon, authenticated;

-- The canonical name for a scraped team name, or the name unchanged. Called by
-- sync-event-details (service role) and the usau_teams trigger.
create function public.usau_canonical_team_name(p_name text, p_division public.usau_gender_division, p_level public.usau_competition_level)
returns text
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fn$
  select coalesce(
    (select a.canonical_name
       from public.usau_team_name_aliases a
      where a.alias_key = public.usau_team_name_key(p_name)
        and a.gender_division = p_division
        and a.competition_level = p_level),
    p_name)
$fn$;
revoke execute on function public.usau_canonical_team_name(text, public.usau_gender_division, public.usau_competition_level) from public, anon, authenticated;
grant execute on function public.usau_canonical_team_name(text, public.usau_gender_division, public.usau_competition_level) to service_role;

create function public._usau_teams_canonical_name()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
begin
  if new.name is not null and new.gender_division is not null and new.competition_level is not null then
    new.name := public.usau_canonical_team_name(new.name, new.gender_division, new.competition_level);
  end if;
  return new;
end
$fn$;
revoke execute on function public._usau_teams_canonical_name() from public, anon, authenticated;

create trigger usau_teams_canonical_name
  before insert or update of name, gender_division, competition_level on public.usau_teams
  for each row execute function public._usau_teams_canonical_name();

notify pgrst, 'reload schema';
