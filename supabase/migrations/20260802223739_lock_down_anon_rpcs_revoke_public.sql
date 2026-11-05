revoke execute on function public.fantasy_carry_over_rosters(integer) from public, anon, authenticated;
revoke execute on function public._rebuild_and_cache_player_profile(text) from public, anon, authenticated;

revoke execute on function public.jersey_listings_rate_limit() from public, anon, authenticated;
revoke execute on function public.jersey_messages_block_check() from public, anon, authenticated;
revoke execute on function public.jersey_messages_rate_limit() from public, anon, authenticated;
revoke execute on function public.jersey_messages_touch_thread() from public, anon, authenticated;
revoke execute on function public.jersey_wants_rate_limit() from public, anon, authenticated;
revoke execute on function public.set_jersey_updated_at() from public, anon, authenticated;
revoke execute on function public.sync_fantasy_owner_identity() from public, anon, authenticated;
