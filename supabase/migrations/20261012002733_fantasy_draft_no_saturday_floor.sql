-- Fantasy — event drafts no longer wait for the Saturday before the event
-- (Hunter, 2026-10-11).
--
-- 20260827100000 made event contests (Club/College Nationals, WFDF, EUCS) wait
-- until midnight ET on the Saturday before the event, on the assumption that
-- rosters land then. USAU posts Nationals pools about a week after regionals,
-- and the event's rosters are in well before that Saturday (2026 Club Nats:
-- rosters ready on Oct 11, floor was Sat Oct 17), so a league can draft as
-- soon as the data exists.
--
-- Still enforced, unchanged:
--   * fantasy_draft_rosters_ready: fantasy_start_draft refuses until the
--     event has published rosters (the real data gate);
--   * the 4-hour cutoff before the event lock (20261009032128).
--
-- fantasy_draft_earliest_at now returns null for every contest, the path its
-- six callers already take for weekly-stats games: schedule / auction schedule
-- / reschedule / start skip the floor check, fantasy_draft_default_at anchors
-- on start - 7 days (greatest() skips the null), and fantasy_draft_readiness
-- reports earliest_at = null, which both apps already treat as "no floor" (no
-- "Drafts open ..." pill, no picker minimum), so neither client changes. The
-- helper stays as the one switch if an event ever needs a floor again.
--
-- Shared with mobile: replaced only after asserting the live body.
-- Live md5(prosrc) (2026-10-11): fantasy_draft_earliest_at 22314e791ae2b758bb39f091dd5e5c2b
-- APPLIED to prod 2026-10-11 (remote version 20261012002733) after a
-- rollback-only dry run; new md5 86f735e14c5f64948264dde5ba2f9262.

do $$
begin
  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_draft_earliest_at(uuid)'::regprocedure)
     <> '22314e791ae2b758bb39f091dd5e5c2b' then
    raise exception 'fantasy_draft_earliest_at changed since it was read (md5 mismatch) — re-read before replacing';
  end if;
end;
$$;

create or replace function public.fantasy_draft_earliest_at(p_contest uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- No calendar floor for any contest (Hunter, 2026-10-11): a league drafts
  -- as soon as its event has rosters (fantasy_draft_rosters_ready gates go-live).
  return null;
end;
$$;

-- Internal only: SECURITY DEFINER callers execute as owner; no client grant.
revoke all on function public.fantasy_draft_earliest_at(uuid) from public, anon, authenticated;

comment on function public.fantasy_draft_earliest_at is 'Earliest allowed draft time for a contest. Null for every contest since 2026-10-11: no calendar floor, fantasy_draft_rosters_ready is the data gate. Kept so the callers and fantasy_draft_readiness.earliest_at (read by both apps) stay on the null path they already handle.';

comment on function public.fantasy_draft_default_at is 'Suggested draft time: event contests = 7 days before the event start at 8pm ET; weekly contests = 14 days before the first period lock, 8pm ET. Never under an hour out; null when there is nothing to anchor on yet (no eventId / no periods) or no slot is left before the event''s 4-hour cutoff.';

notify pgrst, 'reload schema';
