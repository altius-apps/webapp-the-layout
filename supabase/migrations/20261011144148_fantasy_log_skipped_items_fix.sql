-- Fix for 20261011141659_fantasy_log_skipped_items (same day, caught by the
-- security review before any skip happened): cron_health_log's CHECK only
-- allowed failure_class 'cron'/'http', so the new 'fantasy' insert would have
-- raised inside the EXCEPTION handler and aborted the whole hourly carry-over
-- (and rebuild_all_periods) on its first skipped item.
--  1. Allow 'fantasy' in the CHECK.
--  2. Make the log insert itself non-fatal: logging must never be able to
--     break the job it is reporting on.
alter table public.cron_health_log drop constraint cron_health_log_failure_class_check;
alter table public.cron_health_log add constraint cron_health_log_failure_class_check
  check (failure_class = any (array['cron'::text, 'http'::text, 'fantasy'::text]));

do $mig$
declare
  v_def text; v_old text; v_new text; f text;
begin
  foreach f in array array['fantasy_carry_over_rosters', 'fantasy_rebuild_all_periods'] loop
    select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = f;
    v_old := 'insert into public.cron_health_log';
    if v_def is null or position(v_old in v_def) = 0 then
      raise exception '% has no cron_health_log insert — aborting rather than guessing', f;
    end if;
    -- Wrap "insert ... do nothing;" in its own block.
    v_new := regexp_replace(
      v_def,
      '(insert into public\.cron_health_log.*?on conflict \(jobid, runid, failure_class\) do nothing;)',
      E'begin\n        \\1\n      exception when others then\n        raise warning ''' || f || E': could not log skip: %'', sqlerrm;\n      end;',
      's'
    );
    if v_new = v_def then
      raise exception '% insert block not matched — aborting', f;
    end if;
    execute v_new;
  end loop;
end
$mig$;
