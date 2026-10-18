-- Draft picks and nominations: only players in the contest's pool, stored under
-- the pool's own name (Hunter via mobile, 2026-10-16).
--
-- Before: fantasy_make_pick / fantasy_nominate checked the id's shape, the
-- player league and (division leagues only) the division. In an 'all' league,
-- and every WFDF/EUCS event league, any well-formed uuid could be drafted
-- (someone not at the event, or no one at all). And p_player_name went onto the
-- board exactly as the client sent it, skipping moderation. The draft queue
-- (autodraft and auction auto-nominate) had the same two gaps through its
-- entries' playerName.
--
-- After: one pool check, fantasy_draft_pool_player_name, mirrors the app's
-- player search (searchContestPlayers, src/lib/fantasy/draft.ts, web + mobile)
-- and returns the player's name in that pool, or null. Picks, nominations and
-- queued picks all use it; p_player_name / playerName are ignored (kept so
-- shipped clients don't break). New error: "that player isn't in this draft".
-- set_queue already rejects a queue it can't draft ("your queue has a player
-- who isn't in this draft"), now including players outside the pool.
--
-- Shared DB with mobile: existing functions are patched from their LIVE bodies
-- (md5 of prosrc + exactly one anchor each), never re-created from committed
-- text. pg_get_functiondef keeps security definer, search_path and grants.

create function public.fantasy_draft_pool_player_name(
  p_contest public.fantasy_contests,
  p_player_league text,
  p_player_id text
)
returns text
language sql
stable
set search_path = ''
as $$
  -- MIRRORS searchContestPlayers (src/lib/fantasy/draft.ts): weekly UFA = any
  -- UFA player; PUL/WUL = the season window fantasy_pool_first_season opens;
  -- event contests = that event's roster (USAU also by division).
  select case
    when not coalesce(public.fantasy_draft_player_league_valid(p_contest.competition, p_player_league), false) then null
    when p_player_league in ('usau', 'wfdf', 'euf')
         and coalesce(p_player_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then null
    when not public.fantasy_draft_player_in_division(p_contest, p_player_league, p_player_id) then null
    when p_player_league = 'ufa' then
      (select coalesce(p.full_name, p.id) from public.ufa_players p where p.id = p_player_id)
    when p_player_league = 'pul' then
      (select pl.player_name from public.pul_players pl
        where pl.player_name = p_player_id
          and pl.season between public.fantasy_pool_first_season('pul', p_contest.season_year) and p_contest.season_year
        limit 1)
    when p_player_league = 'wul' then
      (select wl.player_name from public.wul_players wl
        where wl.player_name = p_player_id
          and wl.season between public.fantasy_pool_first_season('wul', p_contest.season_year) and p_contest.season_year
        limit 1)
    when p_player_league = 'usau' then
      (select coalesce(up.display_name, up.id::text)
         from public.usau_rosters r
         join public.usau_players up on up.id = r.player_id
        where r.event_id = (p_contest.settings ->> 'eventId')::uuid
          and r.player_id = p_player_id::uuid
        limit 1)
    when p_player_league = 'wfdf' then
      (select coalesce(r.full_name, r.id::text) from public.wfdf_rosters r
        where r.id = p_player_id::uuid and r.event_id = (p_contest.settings ->> 'eventId')::uuid)
    when p_player_league = 'euf' then
      (select coalesce(r.full_name, r.id::text) from public.euf_rosters r
        where r.id = p_player_id::uuid and r.event_id = (p_contest.settings ->> 'eventId')::uuid)
  end;
$$;

-- Only the draft functions (security definer, owner) call it.
revoke execute on function public.fantasy_draft_pool_player_name(public.fantasy_contests, text, text)
  from public, anon, authenticated;

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
        'public.fantasy_make_pick(uuid,text,text,text)',
        'd92973f1c0e41cafa3d4dd2f9b22be8e',
        array[
          $a$  v_total_picks  int;
begin$a$,
          $a$    raise exception 'that player isn''t in this league''s division';
  end if;
$a$,
          $a$p_player_league, p_player_id, p_player_name, false)$a$
        ],
        array[
          $a$  v_total_picks  int;
  v_name         text;
begin$a$,
          $a$    raise exception 'that player isn''t in this league''s division';
  end if;
  -- In the contest's player pool, under the pool's own name. p_player_name is
  -- ignored (kept so shipped clients don't break): it used to be stored as sent.
  v_name := public.fantasy_draft_pool_player_name(v_contest, p_player_league, p_player_id);
  if v_name is null then
    raise exception 'that player isn''t in this draft';
  end if;
$a$,
          $a$p_player_league, p_player_id, v_name, false)$a$
        ]
      ),
      (
        'public.fantasy_nominate(uuid,text,text,text,integer)',
        '4882093c66f690ceda02f8dfaa5c9847',
        array[
          $a$  v_nom        public.fantasy_draft_nominations;
begin$a$,
          $a$    raise exception 'that player isn''t in this league''s division';
  end if;
$a$,
          $a$p_draft, v_draft.current_overall, v_team_id, p_player_league, p_player_id, p_player_name,$a$
        ],
        array[
          $a$  v_nom        public.fantasy_draft_nominations;
  v_name       text;
begin$a$,
          $a$    raise exception 'that player isn''t in this league''s division';
  end if;
  -- In the contest's player pool, under the pool's own name. p_player_name is
  -- ignored (kept so shipped clients don't break): it used to be stored as sent.
  v_name := public.fantasy_draft_pool_player_name(v_contest, p_player_league, p_player_id);
  if v_name is null then
    raise exception 'that player isn''t in this draft';
  end if;
$a$,
          $a$p_draft, v_draft.current_overall, v_team_id, p_player_league, p_player_id, v_name,$a$
        ]
      ),
      (
        'public.fantasy_draft_queue_entry_ok(public.fantasy_contests,jsonb)',
        '6057b8d3380dd2890e13fb2404e36d13',
        array[
          $a$    else public.fantasy_draft_player_in_division(p_contest, p_entry ->> 'playerLeague', p_entry ->> 'playerId')
$a$
        ],
        array[
          $a$    when not public.fantasy_draft_player_in_division(p_contest, p_entry ->> 'playerLeague', p_entry ->> 'playerId') then false
    -- In the contest's player pool (autodraft takes queued players as-is).
    else public.fantasy_draft_pool_player_name(p_contest, p_entry ->> 'playerLeague', p_entry ->> 'playerId') is not null
$a$
        ]
      ),
      (
        'public.fantasy_draft_run_clock(uuid)',
        '92b90514191279341c5de15637ecff9d',
        array[
          $a$v_pick_name := coalesce(v_entry ->> 'playerName', v_entry ->> 'playerId');$a$
        ],
        array[
          $a$v_pick_name := public.fantasy_draft_pool_player_name(v_contest, v_entry ->> 'playerLeague', v_entry ->> 'playerId');$a$
        ]
      ),
      (
        'public.fantasy_auction_advance(uuid)',
        '40bebfcbbff46ea7cbb856d615da5644',
        array[
          $a$v_best_name := coalesce(v_entry ->> 'playerName', v_entry ->> 'playerId');$a$
        ],
        array[
          $a$v_best_name := public.fantasy_draft_pool_player_name(v_contest, v_entry ->> 'playerLeague', v_entry ->> 'playerId');$a$
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
