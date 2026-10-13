-- Fantasy — a draft only starts once every team in the league's division has a
-- roster (Hunter, 2026-10-11).
--
-- With the Saturday floor gone (20261012002733), fantasy_draft_rosters_ready is
-- the only data gate on fantasy_start_draft, and it was true as soon as ONE
-- roster row existed anywhere in the event, ignoring the league's division:
--   * an event whose rosters land team by team could draft from a partial pool;
--   * a women's league could start while only men's rosters were in — its pool
--     filters to nothing, autodraft "picks" no one and the draft completes with
--     empty teams, which can't be undone (UNIQUE(contest_id), no reset).
--
-- Now: an event contest is ready only when its event has at least one team in
-- the league's division and every such team has a roster for the event.
-- Division is USAU-only (fantasy_contests_division_valid); WFDF / EUCS
-- contests are always 'all', so every team in the event counts.
--
-- Not a UI gate (Hunter: no full-rosters requirement before a start button):
-- neither app hides Start / Schedule on rosters_ready. They only show their
-- existing "Rosters not set on <source>" banner, which now also covers a
-- partial pool. fantasy_start_draft keeps refusing while this is false.
-- Weekly-stats contests are unchanged.
--
-- Shared with mobile: replaced only after asserting the live body.
-- Live md5(prosrc) (2026-10-11): fantasy_draft_rosters_ready 97c35b36c3a4c2fc7e6e756bd1c30130
-- APPLIED to prod 2026-10-11 (remote version 20261012003450) after rollback-only
-- dry runs (both live Club Nats leagues stay ready; a rosterless team in the
-- event blocks 'all' and 'women' leagues and start_draft, men's / mixed
-- unaffected); new md5 301ce0c6fa863970ff8e2a8c83473dab.

do $$
begin
  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_draft_rosters_ready(uuid)'::regprocedure)
     <> '97c35b36c3a4c2fc7e6e756bd1c30130' then
    raise exception 'fantasy_draft_rosters_ready changed since it was read (md5 mismatch) — re-read before replacing';
  end if;
end;
$$;

create or replace function public.fantasy_draft_rosters_ready(p_contest uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_competition text;
  v_event_id    text;
  v_division    text;
  v_event_uuid  uuid;
begin
  select competition, settings->>'eventId', coalesce(settings->>'division', 'all')
    into v_competition, v_event_id, v_division
  from public.fantasy_contests
  where id = p_contest;

  -- Event contests: the event has teams (in the league's division) and every
  -- one of them has a roster for the event.
  if v_competition in ('usau-club-nationals', 'usau-college-nationals') then
    if v_event_id is null then
      return false;
    end if;
    v_event_uuid := v_event_id::uuid;
    return exists (
             select 1
             from public.usau_event_teams et
             join public.usau_teams t on t.id = et.team_id
             where et.event_id = v_event_uuid
               and (v_division = 'all' or lower(t.gender_division::text) = v_division))
       and not exists (
             select 1
             from public.usau_event_teams et
             join public.usau_teams t on t.id = et.team_id
             where et.event_id = v_event_uuid
               and (v_division = 'all' or lower(t.gender_division::text) = v_division)
               and not exists (
                 select 1 from public.usau_rosters r
                 where r.event_id = v_event_uuid and r.team_id = et.team_id));
  elsif v_competition = 'wfdf-wucc' then
    if v_event_id is null then
      return false;
    end if;
    v_event_uuid := v_event_id::uuid;
    return exists (select 1 from public.wfdf_teams wt where wt.event_id = v_event_uuid)
       and not exists (
             select 1 from public.wfdf_teams wt
             where wt.event_id = v_event_uuid
               and not exists (
                 select 1 from public.wfdf_rosters r
                 where r.event_id = v_event_uuid and r.team_id = wt.id));
  elsif v_competition = 'eucs' then
    if v_event_id is null then
      return false;
    end if;
    v_event_uuid := v_event_id::uuid;
    return exists (select 1 from public.euf_teams ft where ft.event_id = v_event_uuid)
       and not exists (
             select 1 from public.euf_teams ft
             where ft.event_id = v_event_uuid
               and not exists (
                 select 1 from public.euf_rosters r
                 where r.event_id = v_event_uuid and r.team_id = ft.id));
  else
    return exists (select 1 from public.fantasy_contest_periods where contest_id = p_contest);
  end if;
end;
$$;

-- Internal only: SECURITY DEFINER callers execute as owner; no client grant.
revoke all on function public.fantasy_draft_rosters_ready(uuid) from public, anon, authenticated;

comment on function public.fantasy_draft_rosters_ready is 'True when a contest has the data to draft. Event contests: the event has teams in the league''s division and every one of them has a roster for the event (since 2026-10-11; was: any roster row). Weekly-stats contests: periods exist. Gates fantasy_start_draft; reported as fantasy_draft_readiness.rosters_ready.';

notify pgrst, 'reload schema';
