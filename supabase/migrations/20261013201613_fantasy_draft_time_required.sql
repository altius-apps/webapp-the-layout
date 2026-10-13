-- Every draft gets a time with at least 30 minutes' notice (Hunter, 2026-10-13).
-- Both apps dropped "Start manually"; the server now refuses it too:
--
--   * schedule_draft / schedule_auction_draft: p_at is required and must be at
--     least now() + 30 min (was: null = manual start, otherwise just > now()).
--   * reschedule_draft: p_at is required (a null switched a scheduled draft to
--     manual start). Its 30-min and missed-draft floors are unchanged.
--
-- A draft already scheduled without a time still starts via start_draft; prod
-- has none (the only one, Sports Center #1's, was reset the same day).
--
-- Patched IN PLACE from LIVE definitions (md5 asserted; anchors must occur
-- exactly once). Live md5(prosrc) (2026-10-13):
--   fantasy_schedule_draft          2f3af9f43bc7482a3f076042a2cb8ca6
--   fantasy_schedule_auction_draft  1107958cf304514b87cebec95671ceb5
--   fantasy_reschedule_draft        4d096a80b22aca1100eb8180fcd4723b
-- Rollback-only dry run as the commissioner (2026-10-13): no time and
-- 10 / 29 min rejected, 31 min accepted; reschedule to null and 20 min
-- rejected, 45 min accepted; definer + search_path kept. md5(prosrc) after:
--   fantasy_schedule_draft          666dfea9c73cfdcaa51efc52d351b239
--   fantasy_schedule_auction_draft  641735c18b01f6deaef1de4142bed99f
--   fantasy_reschedule_draft        49171f498b0d92b586ffa8ddc0f97e67
-- APPLIED to prod 2026-10-13 (remote version 20261013201613) after a security
-- review; live md5s match the above, grants and definer/search_path unchanged.

create or replace function pg_temp.assert_md5(p_fn regprocedure, p_md5 text)
returns void
language plpgsql
as $$
begin
  if (select md5(prosrc) from pg_proc where oid = p_fn) <> p_md5 then
    raise exception '% changed since it was read (md5 mismatch) — re-read before patching', p_fn;
  end if;
end;
$$;

create or replace function pg_temp.replace_once(p_src text, p_old text, p_new text, p_what text)
returns text
language plpgsql
as $$
begin
  if (length(p_src) - length(replace(p_src, p_old, ''))) / length(p_old) <> 1 then
    raise exception '%: anchor not found exactly once — aborting rather than guessing', p_what;
  end if;
  return replace(p_src, p_old, p_new);
end;
$$;

do $mig$
declare
  v text;
  fn text;
  at_old constant text := $old$  if p_at is not null and p_at <= now() then
    raise exception 'that draft time has already passed — pick a time in the future';
  end if;$old$;
  at_new constant text := $new$  -- A draft time is required, with at least 30 minutes' notice: manual start
  -- is gone from both apps (Hunter, 2026-10-13).
  if p_at is null then
    raise exception 'pick a draft time at least 30 minutes from now';
  end if;
  if p_at < now() + interval '30 minutes' then
    raise exception 'give the league at least 30 minutes'' notice — pick a later time';
  end if;$new$;
  resched_old constant text := $old$  if v_draft.status <> 'scheduled' then
    raise exception 'draft is not scheduled (status: %)', v_draft.status;
  end if;$old$;
  resched_new constant text := $new$  if v_draft.status <> 'scheduled' then
    raise exception 'draft is not scheduled (status: %)', v_draft.status;
  end if;

  -- A draft keeps a time: no switching to manual start (Hunter, 2026-10-13).
  if p_at is null then
    raise exception 'pick a new draft time';
  end if;$new$;
begin
  perform pg_temp.assert_md5('public.fantasy_schedule_draft(uuid, timestamptz, integer, integer)', '2f3af9f43bc7482a3f076042a2cb8ca6');
  perform pg_temp.assert_md5('public.fantasy_schedule_auction_draft(uuid, timestamptz, integer, integer, integer, integer, integer)', '1107958cf304514b87cebec95671ceb5');
  perform pg_temp.assert_md5('public.fantasy_reschedule_draft(uuid, timestamptz)', '4d096a80b22aca1100eb8180fcd4723b');

  foreach fn in array array[
    'public.fantasy_schedule_draft(uuid, timestamptz, integer, integer)',
    'public.fantasy_schedule_auction_draft(uuid, timestamptz, integer, integer, integer, integer, integer)'
  ] loop
    v := pg_get_functiondef(fn::regprocedure);
    v := pg_temp.replace_once(v, at_old, at_new, fn || ' draft time');
    execute v;
  end loop;

  v := pg_get_functiondef('public.fantasy_reschedule_draft(uuid, timestamptz)'::regprocedure);
  v := pg_temp.replace_once(v, resched_old, resched_new, 'fantasy_reschedule_draft null time');
  execute v;
end;
$mig$;
