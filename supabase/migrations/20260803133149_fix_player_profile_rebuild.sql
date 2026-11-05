-- REGRESSION FIX for 20260802000000_lock_down_anon_rpcs.sql.
--
-- That migration revoked EXECUTE on _rebuild_and_cache_player_profile(text)
-- from public/anon/authenticated — correct in isolation (it was an
-- unauthenticated compute amplifier), but it broke player profiles:
--
--   get_player_profile(anchor_id) is the PUBLIC read wrapper and was
--   SECURITY INVOKER. On a cache miss (or a row older than the 15-minute
--   staleness window) it calls _rebuild_and_cache_player_profile to build the
--   profile. As INVOKER that inner call ran with the CALLER's rights, which no
--   longer include EXECUTE — so it raised, got swallowed by the wrapper's
--   `exception when others` guard, and the wrapper returned null.
--
--   Symptom: "we couldn't load this player" for any player not already in
--   public.player_profiles. 28,022 anchors were cached and kept working, which
--   is why this looked like a one-player bug rather than a total outage.
--   Reported for 'tbrooks1' (Tobias Brooks) via the standouts carousel.
--
-- FIX: make the wrapper SECURITY DEFINER. It then rebuilds with the owner's
-- rights while _rebuild_and_cache_player_profile stays un-callable directly
-- over /rest/v1/rpc — the lockdown's actual goal. The wrapper is safe as
-- DEFINER: its only parameter selects WHICH anchor to read/rebuild, never what
-- gets written (see the inner function's own comment), and it returns the same
-- public profile JSON the app already renders for signed-out users.
--
-- search_path is pinned (it already was) so the definer context can't be
-- hijacked by a caller-controlled path.

alter function public.get_player_profile(text) security definer;
alter function public.get_player_profile(text) set search_path = 'public', 'pg_temp';
