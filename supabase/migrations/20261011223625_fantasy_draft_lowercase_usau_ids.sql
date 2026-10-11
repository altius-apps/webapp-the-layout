-- No duplicate picks (Hunter, 2026-10-11). USAU player ids are uuid::text (lower
-- case) and picks / nominations / queues store player_id as plain text, so a
-- capitalised copy of a drafted player's id passed the "already drafted" check
-- and the unique key: a direct API call (never the app) could draft the same
-- player twice, and autodraft could then hand them to another team too.
-- Lower-case USAU ids on the way in: fantasy_make_pick, fantasy_nominate and the
-- queue writer fantasy_set_queue (the autodraft queue loops read what it stored).
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
  v_lower constant text :=
'  -- USAU ids are uuid::text (lower case): a capitalised copy would pass the
  -- "already drafted" check and the unique key and draft the player twice.
  if p_player_league = ''usau'' then
    p_player_id := lower(p_player_id);
  end if;
';
  v_valid constant text :=
'  if not public.fantasy_draft_player_league_valid(v_contest.competition, p_player_league) then
';
begin
  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_make_pick(uuid, text, text, text)'::regprocedure)
     <> 'fdf1da8b6c990e48b91fa13a19f4a30a' then
    raise exception 'fantasy_make_pick changed since 2026-10-11 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_make_pick(uuid, text, text, text)'::regprocedure);
  v := pg_temp.replace_n(v, v_valid, v_lower || v_valid, 1, 'make_pick lower-case id');
  execute v;

  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_nominate(uuid, text, text, text, integer)'::regprocedure)
     <> '00964d7132820f208d0cf40ad966a5d0' then
    raise exception 'fantasy_nominate changed since 2026-10-11 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_nominate(uuid, text, text, text, integer)'::regprocedure);
  v := pg_temp.replace_n(v, v_valid, v_lower || v_valid, 1, 'nominate lower-case id');
  execute v;

  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_set_queue(uuid, jsonb)'::regprocedure)
     <> 'ee5bcd16c6ccdebf32f362eacbfbd5f3' then
    raise exception 'fantasy_set_queue changed since 2026-10-11 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_set_queue(uuid, jsonb)'::regprocedure);
  v := pg_temp.replace_n(v,
'  insert into public.fantasy_draft_queues (draft_id, team_id, entries, updated_at)
',
'  -- Store queued USAU ids lower case, so autodraft can''t take a capitalised
  -- copy of a player who''s already been drafted.
  select coalesce(jsonb_agg(
           case when x.e ->> ''playerLeague'' = ''usau'' and x.e ? ''playerId''
                then jsonb_set(x.e, ''{playerId}'', to_jsonb(lower(x.e ->> ''playerId'')))
                else x.e end
           order by x.ord), ''[]''::jsonb)
  into p_entries
  from jsonb_array_elements(p_entries) with ordinality as x(e, ord);

  insert into public.fantasy_draft_queues (draft_id, team_id, entries, updated_at)
', 1, 'set_queue lower-case ids');
  execute v;
end;
$mig$;
