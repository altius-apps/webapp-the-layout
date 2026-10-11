-- Exported from the remote migration ledger on 2026-10-11 (Feature Backlog #37): applied to prod but never committed to this repo.
-- SECURITY FIX (confirmed live, reproduced by security review):
-- _upsert_player_profile(p_anchor_id, p_profile jsonb, p_anchor_league, p_build_ms)
-- was SECURITY DEFINER with EXECUTE granted to anon/authenticated, and took the
-- PROFILE JSON AS A CALLER-SUPPLIED PARAMETER with no validation that it came
-- from _build_player_profile. Any anon caller could invoke it directly with
-- hand-crafted JSON; get_player_profile would then serve that attacker-chosen
-- content to every subsequent caller for the full 15-minute cache window.
-- Reproduced live pre-fix: anon had EXECUTE on the 4-arg signature (verified
-- via has_function_privilege) — this was a real, exploitable cache-poisoning
-- hole, not a theoretical one.
--
-- FIX: fold the rebuild INTO the DEFINER writer. The new
-- _rebuild_and_cache_player_profile(p_anchor_id text) takes ONLY an anchor id,
-- computes the profile itself by calling _build_player_profile internally
-- (still INVOKER, still reading only public data), and upserts the result IT
-- computed — never a value the caller handed in. This removes the
-- caller-supplied-jsonb attack surface entirely: there is no longer any
-- parameter through which a caller can influence what gets written beyond
-- which anchor_id gets rebuilt (and rebuilding your own cache entry with the
-- TRUE server-computed profile for that id is not a poisoning vector — it's
-- exactly what a cache-miss is supposed to do).
--
-- The old 4-arg _upsert_player_profile is DROPPED outright (not just
-- revoked) — no reason to leave a caller-supplied-jsonb signature sitting on
-- the schema for someone to rediscover.
--
-- Also fixes the companion LOW finding: get_player_profile was marked STABLE
-- despite writing on cache-miss (calls the DEFINER writer, which performs an
-- INSERT ... ON CONFLICT DO UPDATE). STABLE is a lie for a function with a
-- side effect; changed to VOLATILE (the safe default for anything that writes
-- or calls something that writes).

drop function if exists public._upsert_player_profile(text, jsonb, text, integer);

create or replace function public._rebuild_and_cache_player_profile(p_anchor_id text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_profile jsonb;
  v_start timestamptz := clock_timestamp();
begin
  -- Computed server-side from p_anchor_id ONLY. Nothing the caller supplies
  -- reaches the INSERT below except the anchor_id itself (which only selects
  -- WHICH cache row gets rebuilt, not what value it gets rebuilt to).
  v_profile := public._build_player_profile(p_anchor_id);

  if v_profile is null then
    -- Unresolvable anchor. Do not write a row for it — same "don't
    -- negative-cache" reasoning as before: a brand-new player synced moments
    -- later should be resolvable on the very next call, not blocked by a
    -- stale miss row. Nothing to poison here either way, since there is no
    -- caller-supplied content in play.
    return null;
  end if;

  insert into public.player_profiles (anchor_id, profile, built_at, anchor_league, build_ms)
  values (
    p_anchor_id,
    v_profile,
    now(),
    v_profile->>'anchorLeague',
    (extract(epoch from (clock_timestamp() - v_start)) * 1000)::integer
  )
  on conflict (anchor_id) do update
    set profile = excluded.profile,
        built_at = excluded.built_at,
        anchor_league = excluded.anchor_league,
        build_ms = excluded.build_ms;

  return v_profile;
end;
$$;

comment on function public._rebuild_and_cache_player_profile(text) is
  'SECURITY DEFINER writer that computes AND upserts a player profile from an '
  'anchor_id alone -- replaces the retired _upsert_player_profile(text, jsonb, '
  'text, integer), which took the profile JSON as a caller-supplied parameter '
  '(a confirmed live cache-poisoning hole: anon could call it directly with '
  'hand-crafted JSON and get_player_profile would serve that content to every '
  'subsequent caller for 15 minutes). This function removes that attack '
  'surface entirely by computing the payload itself via _build_player_profile '
  '-- the caller can trigger a rebuild of a given anchor_id but cannot '
  'influence its content. Pinned search_path (public, pg_temp). Returns the '
  'rebuilt profile (or null for an unresolvable anchor) so the reader does not '
  'need a second call to get the value it just wrote.';

revoke all on function public._rebuild_and_cache_player_profile(text) from public;
grant execute on function public._rebuild_and_cache_player_profile(text) to anon, authenticated;

-- Reader: VOLATILE (it writes on cache-miss via the DEFINER writer above --
-- STABLE was incorrect), and now delegates the entire miss path (build +
-- cache) to _rebuild_and_cache_player_profile instead of building locally and
-- upserting the result itself.
create or replace function public.get_player_profile(p_anchor_id text)
returns jsonb
language plpgsql
volatile
set search_path to 'public'
as $$
declare
  c_staleness_window constant interval := interval '15 minutes'; -- matches sync-live-events-every-15-min cadence
  v_cached jsonb;
  v_built_at timestamptz;
  v_fresh_profile jsonb;
begin
  if p_anchor_id is null or length(trim(p_anchor_id)) = 0 then
    return null;
  end if;

  select profile, built_at into v_cached, v_built_at
  from public.player_profiles
  where anchor_id = p_anchor_id;

  if v_cached is not null and v_built_at > now() - c_staleness_window then
    return v_cached;
  end if;

  begin
    v_fresh_profile := public._rebuild_and_cache_player_profile(p_anchor_id);
  exception when others then
    -- Never let a write-path failure fail the read. If we have a stale cache
    -- row, prefer serving it over erroring out; otherwise fall through to
    -- null below.
    v_fresh_profile := null;
  end;

  if v_fresh_profile is not null then
    return v_fresh_profile;
  end if;

  -- Rebuild returned null (unresolvable anchor, or the write path raised and
  -- was swallowed above) -- fall back to a stale positive cache row if one
  -- exists (better a slightly stale real profile than nothing); null if
  -- there was never a cached row either.
  return v_cached;
end;
$$;

comment on function public.get_player_profile(text) is
  'Cache-aside entry point for the unified cross-league player profile. '
  'Accepts a UFA slug, USAU uuid, PUL uuid, or WUL uuid. Returns the cached '
  'profile jsonb when fresher than 15 minutes (matches the sync-live-events '
  'cron cadence); otherwise delegates the rebuild-and-cache miss path to '
  '_rebuild_and_cache_player_profile (SECURITY DEFINER, anchor-id-only -- see '
  'that function''s comment for why the old caller-supplied-jsonb writer was '
  'retired). Returns null for an anchor that resolves to no known player '
  '(never raises). VOLATILE: this function writes on cache-miss, so STABLE '
  '(its original, incorrect marking) would have been a lie. SECURITY INVOKER '
  'itself: safe because every source table it (transitively) reads is '
  'public-SELECT; the one privileged operation (the cache write) is fully '
  'contained inside the DEFINER writer it calls.';

revoke all on function public.get_player_profile(text) from public;
grant execute on function public.get_player_profile(text) to anon, authenticated;
