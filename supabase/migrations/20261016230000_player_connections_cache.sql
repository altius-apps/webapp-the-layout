-- Connections cache, step 1 of 2: build it in the background (Hunter, 2026-10-16).
--
-- Why: get_player_connections was the biggest per-visitor DB cost and the source
-- of all 367 statement timeouts in the 10-15/16 overnight crawl. The graph walk
-- itself is ~45 ms; the cost is find_usau_player_by_name, run once per returned
-- row. That function scans usau_players for '%<last name token>%', so its cost
-- explodes as the token gets shorter: "Lee" 555 ms, "Li" > 6 s, a 1-letter
-- token ~1 h. Prod averaged 366 ms/call.
--
-- This migration only BUILDS the cache: a table with one row per player_nodes
-- name, a background filler, and a rebuild_player_edges() patch that marks rows
-- stale when the graph is rebuilt. get_player_connections is NOT changed here;
-- the reader switches to the cache in a later migration, once coverage is 100%
-- and a cached-vs-live diff is clean. Mobile calls the same RPC, so it benefits
-- with no app change.
--
-- Filler design (security review, 10-17):
-- * A procedure that COMMITs per node, and claims each node (attempts +
--   backoff) in its own committed step before computing it. A node that ever
--   gets a tick cancelled cannot jam the head of the queue; an error leaves the
--   row pending for a retry after backoff (never a permanent empty list).
-- * Names whose last token is under 3 characters are not resolved to a usau_id
--   (link left null). Those lookups are the multi-second / hour-long ones, and
--   they time out on the live reader today, so the section was empty anyway.
-- * Odd minutes only; the profile fill runs on even minutes.
--
-- Shared DB with mobile: rebuild_player_edges is patched from its LIVE body
-- (md5 of prosrc + exactly one anchor), never re-created from committed text.

-- One row per graph node. usau_id/usau_at memoize find_usau_player_by_name for
-- that node's display name. conns = the ordered top 20; conns_at = '-infinity'
-- marks a stale row (still served while it is refilled).
create table public.player_connections_cache (
  name_key     text primary key,              -- = player_nodes.name = normalize_player_name(p_name)
  display_name text not null,
  usau_id      uuid,
  usau_at      timestamptz,
  conns        jsonb,
  conns_at     timestamptz,
  attempts     int not null default 0,
  next_try_at  timestamptz
);
create index player_connections_cache_pending_idx on public.player_connections_cache (conns_at nulls first, name_key)
  where conns is null or conns_at = '-infinity';

-- Internal: RLS on, no policies, no client grants. The reader switch (step 2)
-- reads it from a SECURITY DEFINER get_player_connections, so the table itself
-- is never exposed to the REST API.
alter table public.player_connections_cache enable row level security;
revoke all on public.player_connections_cache from public, anon, authenticated;

insert into public.player_connections_cache (name_key, display_name)
select name, display_name from public.player_nodes
on conflict do nothing;

-- One node. The graph part is the live get_player_connections body verbatim
-- (p_name -> the node's name, limit 20), verified row-for-row against the live
-- RPC. Never runs on the read path.
create function public._fill_one_player_connections(p_name text, p_display text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
begin
  with me as (select p_name as n),
  anchor as (select pn.teams from public.player_nodes pn where pn.name = (select n from me)),
  direct_all as (
    select case when e.name_a = (select n from me) then e.name_b else e.name_a end as t, e.weight, e.ctx as my_ctx
      from public.player_edges e where e.name_a = (select n from me) or e.name_b = (select n from me)),
  my_teammates as (select t from direct_all),
  direct as (select t, my_ctx from direct_all order by weight desc limit 60),
  second as (
    select cand, via, my_ctx, ab_ctx from (
      select case when e.name_a = d.t then e.name_b else e.name_a end as cand, d.t as via, d.my_ctx, e.ctx as ab_ctx,
             row_number() over (partition by d.t order by e.weight desc) as rn
        from direct d join public.player_edges e on (e.name_a = d.t or e.name_b = d.t)) z where rn <= 60),
  bridges as (
    select s.cand, s.via from second s
     where s.cand <> (select n from me) and s.cand not in (select t from my_teammates) and not (s.my_ctx && s.ab_ctx)),
  ranked as (
    select b.cand, count(distinct b.via) as bridge_count, (array_agg(b.via order by b.via))[1] as via_name
      from bridges b group by b.cand),
  qualified as (
    select r.cand, r.bridge_count, r.via_name, pn.display_name, pn.leagues, pn.ufa_career_score as score,
           (coalesce(pn.ufa_career_score, 0) >= 78 and pn.leagues && array['ufa','pul','wul']) as is_pro,
           coalesce(array_length(pn.nationals_seasons, 1), 0) > 0 as is_nationals,
           coalesce(pn.teams && (select teams from anchor), false) as is_alumni
      from ranked r join public.player_nodes pn on pn.name = r.cand),
  final as (
    select q.cand, q.display_name, q.leagues, q.score, q.bridge_count::int as bridge_count,
           vn.display_name as via_display, q.is_pro, q.is_nationals, q.is_alumni,
           (q.is_pro::int + q.is_nationals::int + q.is_alumni::int + (q.bridge_count >= 2)::int) as rank_reasons
      from qualified q left join public.player_nodes vn on vn.name = q.via_name
     where q.is_pro or q.is_nationals or q.is_alumni or q.bridge_count >= 2
     order by rank_reasons desc, coalesce(q.score, 0) desc, q.bridge_count desc
     limit 20),
  f as (
    select final.*, row_number() over (order by rank_reasons desc, coalesce(score, 0) desc, bridge_count desc, cand) as rn
      from final),
  memo as (              -- resolve each candidate once per display name; re-resolve after 30 days
    insert into public.player_connections_cache as k (name_key, display_name, usau_id, usau_at)
    select f.cand, f.display_name,
           -- Same last-token extraction as find_usau_player_by_name; under 3 chars, no lookup.
           case when length(split_part(public.normalize_player_name(f.display_name), ' ',
                       array_length(regexp_split_to_array(public.normalize_player_name(f.display_name), '\s+'), 1))) >= 3
                then public.find_usau_player_by_name(f.display_name) end,
           now()
      from f
     where not exists (select 1 from public.player_connections_cache m
                        where m.name_key = f.cand and m.display_name = f.display_name
                          and m.usau_at > now() - interval '30 days')
    on conflict (name_key) do update
      set display_name = excluded.display_name, usau_id = excluded.usau_id, usau_at = excluded.usau_at
    returning k.name_key, k.usau_id)
  insert into public.player_connections_cache as k (name_key, display_name, conns, conns_at, attempts, next_try_at)
  select p_name, p_display,
         coalesce((select jsonb_agg(jsonb_build_object(
                      'rank', f.rn, 'name', f.cand, 'display_name', f.display_name, 'leagues', f.leagues,
                      'score', f.score, 'bridge_count', f.bridge_count, 'via_display', f.via_display,
                      'is_pro', f.is_pro, 'is_nationals', f.is_nationals, 'is_alumni', f.is_alumni,
                      'usau_id', case when memo.name_key is not null then memo.usau_id else m.usau_id end) order by f.rn)
                     from f
                     left join memo on memo.name_key = f.cand
                     left join public.player_connections_cache m on m.name_key = f.cand), '[]'::jsonb),
         now(), 0, null
  on conflict (name_key) do update
    set conns = excluded.conns, conns_at = excluded.conns_at, attempts = 0, next_try_at = null;
end
$fn$;
revoke execute on function public._fill_one_player_connections(text, text) from public, anon, authenticated;

-- The fill. A procedure so it can COMMIT per node. Transaction control is not
-- allowed in a SECURITY DEFINER procedure or one with a SET clause, so this is
-- invoker with no SET (it runs as the cron owner) and every name is qualified.
create procedure public.fill_player_connections(p_max int default 200, p_budget_s numeric default 16)
language plpgsql
as $fn$
declare
  v_name    text;
  v_display text;
  v_n       int := 0;
  v_t0      timestamptz := clock_timestamp();
begin
  loop
    exit when v_n >= p_max or clock_timestamp() - v_t0 > make_interval(secs => p_budget_s);
    exit when (select count(*) from pg_catalog.pg_stat_activity
                where state = 'active' and application_name = 'postgrest') > 3;   -- yield to the API

    select k.name_key, k.display_name into v_name, v_display
      from public.player_connections_cache k
     where (k.conns is null or k.conns_at = '-infinity')
       and (k.next_try_at is null or k.next_try_at <= now())
     order by k.conns_at nulls first, k.name_key
     limit 1;
    exit when not found;

    -- Claim first, committed: a node that gets a tick cancelled is skipped
    -- (backoff) next time instead of retried at the head of the queue forever.
    update public.player_connections_cache
       set attempts = attempts + 1,
           next_try_at = now() + interval '1 hour' * least(24, power(2, attempts))
     where name_key = v_name;
    commit;

    begin
      perform public._fill_one_player_connections(v_name, v_display);
    exception when others then
      raise warning 'fill_player_connections: % failed: %', v_name, sqlerrm;   -- stays pending, retried after backoff
    end;
    commit;
    v_n := v_n + 1;
  end loop;
end
$fn$;
revoke execute on procedure public.fill_player_connections(int, numeric) from public, anon, authenticated;

-- Invalidate on graph rebuild, inside rebuild_player_edges()'s own transaction:
-- existing rows go stale (still served) and get refilled, new nodes get pending
-- rows, vanished nodes are dropped.
do $patch$
declare
  v_oid oid;
  v_def text;
  v_old text := $a$  select count(*) into n_nodes from public.player_nodes;$a$;
begin
  v_oid := to_regprocedure('public.rebuild_player_edges()');
  if v_oid is null then raise exception 'rebuild_player_edges() not found'; end if;
  if (select md5(prosrc) from pg_proc where oid = v_oid) <> '0eaa6f5d9293b5165de7ac01e22ff3a7' then
    raise exception 'rebuild_player_edges changed since 2026-10-16 (md5): re-read it before patching';
  end if;
  v_def := pg_get_functiondef(v_oid);
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'rebuild_player_edges: expected exactly one anchor';
  end if;
  execute replace(v_def, v_old, $b$  insert into public.player_connections_cache as k (name_key, display_name)
  select pn.name, pn.display_name from public.player_nodes pn
  on conflict (name_key) do update
    set display_name = excluded.display_name,
        conns_at = case when k.conns is not null then '-infinity'::timestamptz else k.conns_at end,
        attempts = 0, next_try_at = null;
  delete from public.player_connections_cache k
   where not exists (select 1 from public.player_nodes pn where pn.name = k.name_key);
$b$ || v_old);
end
$patch$;

-- Background fill: odd minutes, <= ~16 s per tick (~13% of one core), skipped
-- while the API is busy. Must stay a single CALL statement (a multi-statement
-- command runs as one transaction block and the procedure's COMMIT fails).
-- Kill switch: select cron.alter_job(jobid, active := false) from cron.job
-- where jobname = 'fill-player-connections';
select cron.schedule('fill-player-connections', '1-59/2 * * * *', 'call public.fill_player_connections(200, 16)');

notify pgrst, 'reload schema';
