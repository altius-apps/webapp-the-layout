-- The draft always finishes (Hunter, 2026-10-11).
--   • fantasy_draft_seed_event_rosters: the draft IS the event roster. Clear any
--     event lineup a team saved before the draft (a direct API write or an older
--     client) before seeding; otherwise the 7-slot cap fails the seed inside
--     fantasy_draft_on_complete, the last pick rolls back and the draft never
--     ends (security review, 2026-10-11). Also drops a pre-draft slot holding a
--     player from another division.
--   • fantasy_auction_advance: stamp current_started_at when an auction
--     completes, like the snake paths, so the room can send everyone back to
--     the league a minute after the end.
-- Shared with mobile: patched in place, guarded on today's md5.

create or replace function pg_temp.replace_n(p_src text, p_old text, p_new text, p_n int, p_what text)
returns text
language plpgsql
as $$
begin
  if (length(p_src) - length(replace(p_src, p_old, ''))) / length(p_old) <> p_n then
    raise exception '%: anchor not found exactly % time(s) — aborting rather than guessing', p_what, p_n;
  end if;
  return replace(p_src, p_old, p_new);
end;
$$;

do $mig$
declare
  v text;
begin
  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_draft_seed_event_rosters(uuid, text, integer)'::regprocedure)
     <> 'c714cc89b59e9fb46d5bff4ef745b6fb' then
    raise exception 'fantasy_draft_seed_event_rosters changed since 2026-10-11 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_draft_seed_event_rosters(uuid, text, integer)'::regprocedure);
  v := pg_temp.replace_n(v,
'  select draft_type into v_draft_type from public.fantasy_drafts where id = p_draft;
',
'  select draft_type into v_draft_type from public.fantasy_drafts where id = p_draft;

  -- The draft is the roster: drop any event lineup saved before it, so the
  -- seed below can never trip the roster cap and stall the last pick.
  delete from public.fantasy_roster_slots rs
  where rs.week = ''event''
    and rs.team_id in (
      select t.id
      from public.fantasy_teams t
      join public.fantasy_drafts d on d.contest_id = t.contest_id
      where d.id = p_draft
    );
', 1, 'seed clears pre-draft slots');
  execute v;

  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_auction_advance(uuid)'::regprocedure)
     <> '39a8e868a4dbf604cbc3598ea4f3f1c5' then
    raise exception 'fantasy_auction_advance changed since 2026-10-11 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_auction_advance(uuid)'::regprocedure);
  v := pg_temp.replace_n(v,
'      update public.fantasy_drafts set status = ''complete'' where id = p_draft;
',
'      update public.fantasy_drafts set status = ''complete'', current_started_at = now() where id = p_draft;
', 2, 'auction completion stamps the end time');
  execute v;
end;
$mig$;
