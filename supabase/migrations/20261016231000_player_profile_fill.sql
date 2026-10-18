-- Pre-fill every player profile so a page view never pays for a build
-- (Hunter, 2026-10-16). Crawler-proofing step 2, profile side.
--
-- Before: player_profiles held ~71k of 416,848 anchors (usau 410,706 — one id
-- per event registration, ~3.7 per person — ufa 3,837, pul 1,297, wul 1,008).
-- get_player_profile rebuilt every miss inline (~120 ms, p95 ~350 ms), so a
-- crawl of the long tail was a stream of builds on the read path. The every-
-- minute trickle (job 25) only refreshes existing rows; it never fills misses.
--
-- After:
-- * fill_player_profiles (pg_cron, even minutes, <= ~20 s, yields to the API)
--   fills every missing anchor: ufa/pul/wul first, then usau by a watermark.
--   A usau id whose same-person sibling is already cached is COPIED (no build);
--   profiles of same-name cluster siblings are identical apart from anchorId /
--   usauId / displayName (1,873 of 1,881 sampled groups; the 8 diffs were stale
--   rows). Copies carry build_ms = null. After a pass the watermark parks and a
--   catch-up pass runs hourly for new anchors.
-- * _rebuild_cluster_and_cache_player_profile builds one anchor and refreshes
--   its usau siblings in the same pass; the trickle uses it too, which also ends
--   sibling staleness (the stat triggers only flag the exact id).
-- * get_player_profile keeps the inline build for a true miss (both clients
--   treat a null profile as "not found" or run a multi-query fallback, so a
--   "not built yet" null would be wrong). It is hardened: ids over 64 chars are
--   rejected, an upper-case uuid is lower-cased (it used to build and cache under
--   its own key), and concurrent misses for one anchor build once (advisory lock).
--   A failed build now RAISES instead of returning null: web treats null as
--   "no such player" (notFound, cached), so a swallowed error must not look like
--   one. There is no stale row to serve on that path anyway.
--   Deliberately NO failure-ledger check on the read path: a flaky build must
--   never turn a real player into a cached 404. The ledger only paces the fill.
-- * Job 25 stays at 50 rows per tick while the fill runs (security review
--   10-17: three CPU-bound jobs would otherwise stack each minute). Raise it to
--   150 once the fill completes, so the filled corpus can pass its 7-day TTL in
--   ~2 days instead of ~6.
-- * The fill runs on even minutes, the connections fill on odd minutes, so the
--   two never overlap.
--
-- Shared DB with mobile: existing functions are patched from their LIVE bodies
-- (md5 of prosrc + exactly one anchor each), never re-created from committed
-- text. pg_get_functiondef keeps security definer, search_path and grants.
-- Payload shape is unchanged.

-- Fill state (definer functions only: RLS on, no policies, no grants).
create table public.player_profile_build_failures (
  anchor_id   text primary key,
  attempts    int  not null default 1,
  last_error  text,
  next_try_at timestamptz not null default now() + interval '1 hour'
);
create table public.player_fill_state (            -- one row: usau watermark + last completed pass
  id      boolean primary key default true check (id),
  usau_wm uuid        not null default '00000000-0000-0000-0000-000000000000',
  pass_at timestamptz not null default now() - interval '2 hours'
);
insert into public.player_fill_state default values;
alter table public.player_profile_build_failures enable row level security;
alter table public.player_fill_state enable row level security;
revoke all on public.player_profile_build_failures, public.player_fill_state from public, anon, authenticated;

-- Build one anchor, then refresh its same-person usau siblings.
create function public._rebuild_cluster_and_cache_player_profile(p_anchor_id text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_start   timestamptz := clock_timestamp();
  v_profile jsonb;
begin
  -- Already (re)built in this transaction by a fan-out earlier in the same batch.
  select profile into v_profile from public.player_profiles
   where anchor_id = p_anchor_id and built_at = now();
  if v_profile is not null then
    return v_profile;
  end if;

  v_profile := public._rebuild_and_cache_player_profile(p_anchor_id);

  if v_profile is not null and v_profile->>'anchorLeague' = 'usau' then
    insert into public.player_profiles (anchor_id, profile, built_at, anchor_league, build_ms)
    select s.id::text,
           v_profile || jsonb_build_object('anchorId', s.id::text, 'usauId', s.id::text, 'displayName', s.display_name),
           now(), 'usau', null
      from public.usau_players s
     where s.id in (select jsonb_array_elements_text(v_profile->'usauClusterIds')::uuid)
       and s.id::text <> p_anchor_id
    on conflict (anchor_id) do update
      set profile = excluded.profile, built_at = excluded.built_at,
          anchor_league = excluded.anchor_league, build_ms = null
      where public.player_profiles.built_at < v_start;   -- never clobber a row rebuilt after we started
  end if;
  return v_profile;
end
$fn$;
revoke execute on function public._rebuild_cluster_and_cache_player_profile(text) from public, anon, authenticated;

create function public.fill_player_profiles(p_builds int default 50, p_budget_s numeric default 10)
returns int
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  r        record;
  v_id     uuid;
  v_ids    uuid[];
  v_last   uuid;
  v_wm     uuid;
  v_pass   timestamptz;
  v_builds int := 0;
  v_copied int;
  v_t0     timestamptz := clock_timestamp();
  c_zero   constant uuid := '00000000-0000-0000-0000-000000000000';
  c_end    constant uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
begin
  -- Yield to the API.
  if (select count(*) from pg_stat_activity where state = 'active' and application_name = 'postgrest') > 3 then
    return 0;
  end if;

  select usau_wm, pass_at into v_wm, v_pass from public.player_fill_state;
  if v_wm = c_end then
    if v_pass > now() - interval '1 hour' then
      return 0;                     -- pass complete: parked until the hourly catch-up
    end if;
    v_wm := c_zero;                 -- hourly catch-up pass for new anchors
  end if;

  -- ufa / pul / wul (~4k anchors in total): build each miss.
  for r in
    select u.id as aid from public.ufa_players u
     where not exists (select 1 from public.player_profiles p where p.anchor_id = u.id)
       and not exists (select 1 from public.player_profile_build_failures f
                        where f.anchor_id = u.id and f.next_try_at > now())
    union all
    select u.id::text from public.pul_players u
     where not exists (select 1 from public.player_profiles p where p.anchor_id = u.id::text)
       and not exists (select 1 from public.player_profile_build_failures f
                        where f.anchor_id = u.id::text and f.next_try_at > now())
    union all
    select u.id::text from public.wul_players u
     where not exists (select 1 from public.player_profiles p where p.anchor_id = u.id::text)
       and not exists (select 1 from public.player_profile_build_failures f
                        where f.anchor_id = u.id::text and f.next_try_at > now())
  loop
    if v_builds >= p_builds or clock_timestamp() - v_t0 > make_interval(secs => p_budget_s) then
      return v_builds;              -- budget spent before usau: leave the watermark alone
    end if;
    begin
      v_builds := v_builds + 1;
      if public._rebuild_cluster_and_cache_player_profile(r.aid) is null then
        raise exception 'unresolvable anchor';
      end if;
      delete from public.player_profile_build_failures where anchor_id = r.aid;
    exception when others then
      insert into public.player_profile_build_failures as f (anchor_id, last_error)
      values (r.aid, left(sqlerrm, 200))
      on conflict (anchor_id) do update
        set attempts = f.attempts + 1, last_error = excluded.last_error,
            next_try_at = now() + interval '1 hour' * least(24, power(2, f.attempts));
    end;
  end loop;

  -- usau by watermark, so a tick never re-walks the filled prefix.
  select array_agg(id order by id) into v_ids from (
    select u.id from public.usau_players u
     where u.id > v_wm
       and not exists (select 1 from public.player_profiles p where p.anchor_id = u.id::text)
       and not exists (select 1 from public.player_profile_build_failures f
                        where f.anchor_id = u.id::text and f.next_try_at > now())
     order by u.id
     limit 1000) s;

  if v_ids is null then
    update public.player_fill_state set usau_wm = c_end, pass_at = now();   -- pass complete: park
    return v_builds;
  end if;

  foreach v_id in array v_ids loop
    exit when v_builds >= p_builds or clock_timestamp() - v_t0 > make_interval(secs => p_budget_s);
    v_last := v_id;
    continue when exists (select 1 from public.player_profiles where anchor_id = v_id::text);  -- a fan-out filled it
    begin
      -- Same person already cached: copy, no build. A copy is exactly as fresh as its template.
      insert into public.player_profiles (anchor_id, profile, built_at, anchor_league, build_ms)
      select y.id::text,
             t.profile || jsonb_build_object('anchorId', y.id::text, 'usauId', y.id::text, 'displayName', y.display_name),
             t.built_at, 'usau', null
        from public.usau_players y
        join lateral (select p.profile, p.built_at from public.player_profiles p
                       where p.anchor_league = 'usau'
                         and lower(p.profile->>'displayName') = lower(y.display_name)
                         and jsonb_exists(p.profile->'usauClusterIds', y.id::text)
                       order by p.built_at desc       -- freshest sibling, never a flagged-stale one first
                       limit 1) t on true
       where y.id = v_id
      on conflict (anchor_id) do nothing;
      get diagnostics v_copied = row_count;

      if v_copied = 0 then
        v_builds := v_builds + 1;
        if public._rebuild_cluster_and_cache_player_profile(v_id::text) is null then
          raise exception 'unresolvable anchor';
        end if;
      end if;
      delete from public.player_profile_build_failures where anchor_id = v_id::text;
    exception when others then
      insert into public.player_profile_build_failures as f (anchor_id, last_error)
      values (v_id::text, left(sqlerrm, 200))
      on conflict (anchor_id) do update
        set attempts = f.attempts + 1, last_error = excluded.last_error,
            next_try_at = now() + interval '1 hour' * least(24, power(2, f.attempts));
    end;
  end loop;

  if v_last is not null then
    update public.player_fill_state set usau_wm = v_last;
  end if;
  return v_builds;
end
$fn$;
revoke execute on function public.fill_player_profiles(int, numeric) from public, anon, authenticated;

-- Patch get_player_profile (miss-path hardening) and the trickle (cluster fan-out).
do $patch$
declare
  r record; v_oid oid; v_def text; i int;
begin
  for r in
    select * from (values
      ( 'public.get_player_profile(text)', '0b163db878f4ca471b97076807d2b7a9',
        array[
$a$  if p_anchor_id is null or length(trim(p_anchor_id)) = 0 then
    return null;
  end if;
$a$,
$a$  begin
    v_fresh_profile := public._rebuild_and_cache_player_profile(p_anchor_id);
$a$,
$a$    -- Never let a write-path failure fail the read. If we have a stale cache
    -- row, prefer serving it over erroring out; otherwise fall through to
    -- null below.
    v_fresh_profile := null;
$a$,
$a$  -- Rebuild returned null (unresolvable anchor, or the write path raised and
  -- was swallowed above) -- fall back to a stale positive cache row if one
  -- exists (better a slightly stale real profile than nothing); null if
  -- there was never a cached row either.
$a$
        ],
        array[
$a$  if p_anchor_id is null or length(trim(p_anchor_id)) = 0 or length(p_anchor_id) > 64 then
    return null;
  end if;
  -- Canonical cache key: an upper-case uuid used to build and cache under its own key.
  if p_anchor_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    p_anchor_id := lower(p_anchor_id);
  end if;
$a$,
$a$  -- One inline build per anchor: concurrent misses wait here, then read the row the first one wrote.
  perform pg_advisory_xact_lock(hashtextextended('player_profile:' || p_anchor_id, 0));
  select profile into v_cached from public.player_profiles where anchor_id = p_anchor_id;
  if v_cached is not null then
    return v_cached;
  end if;

  begin
    v_fresh_profile := public._rebuild_and_cache_player_profile(p_anchor_id);
$a$,
$a$    -- A true miss has no stale row to serve: re-raise, so a failed build reads
    -- as an error (clients fall back) and never as null ("no such player").
    raise;
$a$,
$a$  -- Rebuild returned null: unresolvable anchor, no such player.
$a$
        ]
      ),
      ( 'public.trickle_rebuild_player_profiles(integer)', '1d0b9d1e5c2469b0486e43255754261b',
        array[ $a$      if public._rebuild_and_cache_player_profile(r.anchor_id) is null then$a$ ],
        array[ $a$      if public._rebuild_cluster_and_cache_player_profile(r.anchor_id) is null then$a$ ]
      )
    ) as t(sig, md5, olds, news)
  loop
    v_oid := to_regprocedure(r.sig);
    if v_oid is null then raise exception '% not found', r.sig; end if;
    if (select md5(prosrc) from pg_proc where oid = v_oid) <> r.md5 then
      raise exception '% changed since 2026-10-16 (md5): re-read it before patching', r.sig;
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

-- Background fill: even minutes, <= 100 builds / ~20 s per tick (~17% of one
-- core), skipped while the API is busy. Kill switch: select cron.alter_job(jobid,
-- active := false) from cron.job where jobname = 'fill-player-profiles';
select cron.schedule('fill-player-profiles', '*/2 * * * *', 'select public.fill_player_profiles(100, 20)');

notify pgrst, 'reload schema';
