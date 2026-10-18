-- Add/drop and waiver claims: store the added player under the pool's own name,
-- not the name the client sent (Hunter, 2026-10-16; follows
-- 20261016200000_fantasy_draft_pool_check). Both already refuse players outside
-- the season pool; only p_add_name went onto rosters, transactions and claims
-- as sent. p_add_name is ignored now (kept so shipped clients don't break).
-- Waiver processing copies the claim's add_name, so it's covered through the claim.
--
-- Patched from the LIVE bodies (md5 of prosrc + exactly one anchor each).

do $patch$
declare
  r record;
  v_oid oid;
  v_def text;
  i int;
begin
  for r in
    select * from (values
      (
        'public.fantasy_add_drop(uuid,text,text,text,text,text)',
        '274a60668ca78802b0750b08377a682c',
        array[
          $a$  v_pool_ok      boolean;
begin$a$,
          $a$    raise exception 'player % not found in the % % pool', p_add_id, v_contest.competition, v_contest.season_year;
  end if;
$a$,
          $a$p_add_league, p_add_id, p_add_name, 'add');$a$,
          $a$p_drop_id, v_dropped_name, p_add_league, p_add_id, p_add_name);$a$
        ],
        array[
          $a$  v_pool_ok      boolean;
  v_add_name     text;
begin$a$,
          $a$    raise exception 'player % not found in the % % pool', p_add_id, v_contest.competition, v_contest.season_year;
  end if;
  -- The pool's own name, not the client's.
  v_add_name := coalesce(public.fantasy_draft_pool_player_name(v_contest, p_add_league, p_add_id), p_add_id);
$a$,
          $a$p_add_league, p_add_id, v_add_name, 'add');$a$,
          $a$p_drop_id, v_dropped_name, p_add_league, p_add_id, v_add_name);$a$
        ]
      ),
      (
        'public.fantasy_claim_waiver(uuid,text,text,text,integer,text,text)',
        '5a187e2711f28001fbf1069f896178b5',
        array[
          $a$  v_pool_ok boolean := false;
begin$a$,
          $a$  if not v_pool_ok then raise exception 'player not found in the season pool'; end if;
$a$,
          $a$values (p_contest, v_team, p_add_league, p_add_id, p_add_name, p_drop_league,$a$
        ],
        array[
          $a$  v_pool_ok boolean := false;
  v_add_name text;
begin$a$,
          $a$  if not v_pool_ok then raise exception 'player not found in the season pool'; end if;
  -- The pool's own name, not the client's.
  v_add_name := coalesce(public.fantasy_draft_pool_player_name(v_contest, p_add_league, p_add_id), p_add_id);
$a$,
          $a$values (p_contest, v_team, p_add_league, p_add_id, v_add_name, p_drop_league,$a$
        ]
      )
    ) as t(sig, md5, olds, news)
  loop
    v_oid := to_regprocedure(r.sig);
    if v_oid is null then
      raise exception '% not found', r.sig;
    end if;
    if (select md5(prosrc) from pg_proc where oid = v_oid) <> r.md5 then
      raise exception '% changed since 2026-10-16 (md5) — re-read it before patching', r.sig;
    end if;
    v_def := pg_get_functiondef(v_oid);
    for i in 1 .. array_length(r.olds, 1) loop
      if (length(v_def) - length(replace(v_def, r.olds[i], ''))) / length(r.olds[i]) <> 1 then
        raise exception '%: expected exactly one anchor %', r.sig, i;
      end if;
      v_def := replace(v_def, r.olds[i], r.news[i]);
    end loop;
    execute v_def;
  end loop;
end
$patch$;

notify pgrst, 'reload schema';
