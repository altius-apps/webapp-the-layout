-- Feature Backlog #41 (2026-10-11): fantasy_carry_over_rosters and
-- fantasy_rebuild_all_periods skip a failing team/contest with only a
-- RAISE WARNING, which nothing reads. Each skip now also lands in
-- cron_health_log (failure_class 'fantasy'), which check_cron_health() already
-- reports. runid is a hash of the item (+ week/day) so a persistent failure
-- logs once per team-week / contest-day, not every hourly run.
--
-- PATCHED IN PLACE from the live definition (pg_get_functiondef + exact-string
-- replace), not re-created from committed text: these bodies are shared with
-- the mobile repo and have diverged from this repo's SQL. Aborts if the
-- expected line is missing rather than guessing.
do $mig$
declare
  v_def text; v_old text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fantasy_carry_over_rosters';
  v_old := $q$raise warning 'fantasy_carry_over_rosters: skipped team % (% -> %): %', rec.tid, v_prev_week, rec.active_week, sqlerrm;$q$;
  if v_def is null or position(v_old in v_def) = 0 then
    raise exception 'carry-over warning line not found in deployed body — aborting rather than guessing';
  end if;
  v_new := v_old || $q$
      insert into public.cron_health_log (jobid, jobname, runid, failure_class, status, detail, occurred_at)
      values (0, 'fantasy_carry_over_rosters', hashtextextended(rec.tid::text || '|' || rec.active_week::text, 0), 'fantasy', 'skipped',
              left(format('team %s (%s -> %s): %s', rec.tid, v_prev_week, rec.active_week, sqlerrm), 500), now())
      on conflict (jobid, runid, failure_class) do nothing;$q$;
  execute replace(v_def, v_old, v_new);

  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fantasy_rebuild_all_periods';
  v_old := $q$raise warning 'fantasy_rebuild_all_periods: skipped contest %: %', r.id, sqlerrm;$q$;
  if v_def is null or position(v_old in v_def) = 0 then
    raise exception 'rebuild_all_periods warning line not found in deployed body — aborting rather than guessing';
  end if;
  v_new := v_old || $q$
      insert into public.cron_health_log (jobid, jobname, runid, failure_class, status, detail, occurred_at)
      values (0, 'fantasy_rebuild_all_periods', hashtextextended(r.id::text || '|' || current_date::text, 0), 'fantasy', 'skipped',
              left(format('contest %s: %s', r.id, sqlerrm), 500), now())
      on conflict (jobid, runid, failure_class) do nothing;$q$;
  execute replace(v_def, v_old, v_new);
end
$mig$;
