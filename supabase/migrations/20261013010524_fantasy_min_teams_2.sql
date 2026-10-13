-- Fantasy leagues need 2 teams, not 4 (Hunter, 2026-10-12).
--
--   * schedule_draft / schedule_auction_draft / start_draft: a draft needs 2+ teams.
--   * set_contest_limits: max teams 2–16.
--   * contest_team_limits: reports min_teams = 2 (both apps' draft card +
--     "Need N teams to draft" read it, so the copy follows with no client change).
--   * generate_schedule_internal: an H2H schedule needs 2+ teams. The existing
--     round-robin handles it: 2 teams = 1 round, 3 teams = a bye each week.
--
-- Patched IN PLACE from LIVE definitions (md5 asserted; anchors must occur
-- exactly once). Live md5(prosrc) (2026-10-12):
--   fantasy_schedule_draft             ed7c087c8572afd7ec15b72ffe67d06f
--   fantasy_schedule_auction_draft     d025dca713bac878af152eec61f27de4
--   fantasy_start_draft                2dceadcab17911b16184ff3e720b49ae
--   fantasy_set_contest_limits         d1833ae00be175f50b1b4666242ed695
--   fantasy_contest_team_limits        38138efbe4d86f92038b8f833aed5850
--   fantasy_generate_schedule_internal d63013b21de5f569c799e2cd6d47d8c9
-- APPLIED to prod 2026-10-12 (remote version 20261013010524) after a
-- rollback-only dry run; grants unchanged. New md5(prosrc):
--   fantasy_schedule_draft             2f3af9f43bc7482a3f076042a2cb8ca6
--   fantasy_schedule_auction_draft     1107958cf304514b87cebec95671ceb5
--   fantasy_start_draft                102b99cd5cc86926c5622ab23daa5ade
--   fantasy_set_contest_limits         c674fa10cdd8189823054970b7a88a2d
--   fantasy_contest_team_limits        02317439e25669b9ea007a055692a8c0
--   fantasy_generate_schedule_internal 963c10de371f2b6adc372421e72bcb88

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
  draft_old constant text :=
'  if jsonb_array_length(v_order) < 4 then
    raise exception ''a draft needs at least 4 teams'';';
  draft_new constant text :=
'  if jsonb_array_length(v_order) < 2 then
    raise exception ''a draft needs at least 2 teams'';';
begin
  perform pg_temp.assert_md5('public.fantasy_schedule_draft(uuid, timestamptz, integer, integer)', 'ed7c087c8572afd7ec15b72ffe67d06f');
  perform pg_temp.assert_md5('public.fantasy_schedule_auction_draft(uuid, timestamptz, integer, integer, integer, integer, integer)', 'd025dca713bac878af152eec61f27de4');
  perform pg_temp.assert_md5('public.fantasy_start_draft(uuid)', '2dceadcab17911b16184ff3e720b49ae');
  perform pg_temp.assert_md5('public.fantasy_set_contest_limits(uuid, integer, boolean)', 'd1833ae00be175f50b1b4666242ed695');
  perform pg_temp.assert_md5('public.fantasy_contest_team_limits(uuid)', '38138efbe4d86f92038b8f833aed5850');
  perform pg_temp.assert_md5('public.fantasy_generate_schedule_internal(uuid)', 'd63013b21de5f569c799e2cd6d47d8c9');

  foreach fn in array array[
    'public.fantasy_schedule_draft(uuid, timestamptz, integer, integer)',
    'public.fantasy_schedule_auction_draft(uuid, timestamptz, integer, integer, integer, integer, integer)',
    'public.fantasy_start_draft(uuid)'
  ] loop
    v := pg_get_functiondef(fn::regprocedure);
    v := pg_temp.replace_once(v, draft_old, draft_new, fn || ' min teams');
    execute v;
  end loop;

  v := pg_get_functiondef('public.fantasy_set_contest_limits(uuid, integer, boolean)'::regprocedure);
  v := pg_temp.replace_once(v,
'  if p_max_teams is null or p_max_teams < 4 or p_max_teams > 16 then
    raise exception ''max teams must be between 4 and 16'';',
'  if p_max_teams is null or p_max_teams < 2 or p_max_teams > 16 then
    raise exception ''max teams must be between 2 and 16'';',
    'fantasy_set_contest_limits range');
  execute v;

  v := pg_get_functiondef('public.fantasy_contest_team_limits(uuid)'::regprocedure);
  v := pg_temp.replace_once(v,
'    (select count(*)::int from public.fantasy_teams where contest_id = p_contest),
    4,',
'    (select count(*)::int from public.fantasy_teams where contest_id = p_contest),
    2,',
    'fantasy_contest_team_limits min_teams');
  execute v;

  v := pg_get_functiondef('public.fantasy_generate_schedule_internal(uuid)'::regprocedure);
  v := pg_temp.replace_once(v,
'  if n_teams is null or n_teams < 4 then
    raise exception ''a schedule needs at least 4 teams'';',
'  if n_teams is null or n_teams < 2 then
    raise exception ''a schedule needs at least 2 teams'';',
    'fantasy_generate_schedule_internal min teams');
  execute v;
end;
$mig$;
