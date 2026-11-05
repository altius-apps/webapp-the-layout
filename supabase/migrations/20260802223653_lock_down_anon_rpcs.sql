revoke execute on function public.fantasy_carry_over_rosters(integer) from anon, authenticated;
revoke execute on function public._rebuild_and_cache_player_profile(text) from anon, authenticated;

revoke execute on function public.jersey_listings_rate_limit() from anon, authenticated;
revoke execute on function public.jersey_messages_block_check() from anon, authenticated;
revoke execute on function public.jersey_messages_rate_limit() from anon, authenticated;
revoke execute on function public.jersey_messages_touch_thread() from anon, authenticated;
revoke execute on function public.jersey_wants_rate_limit() from anon, authenticated;
revoke execute on function public.set_jersey_updated_at() from anon, authenticated;
revoke execute on function public.sync_fantasy_owner_identity() from anon, authenticated;

alter function public.push_tokens_set_updated_at() set search_path = 'public', 'pg_temp';
alter function public.reject_duplicate_event_team() set search_path = 'public', 'pg_temp';
