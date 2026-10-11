-- Review of 20261011223749:
--  - trim() only strips spaces, so a tab/newline-only signup name was stored
--    and rendered blank without triggering the name prompt. Strip all
--    whitespace before nullif.
--  - fantasy_league_activity payloads snapshot names at write time, so two
--    feed rows still showed an email prefix: swap it for the handle.
do $$
declare
  d text;
  old_expr constant text := 'nullif(trim(new.raw_user_meta_data->>''display_name''), '''')';
begin
  select pg_get_functiondef('public.handle_new_user()'::regprocedure) into d;
  if position(old_expr in d) = 0 then
    raise exception 'handle_new_user does not have the expected display_name expression';
  end if;
  execute replace(d, old_expr,
    'nullif(regexp_replace(new.raw_user_meta_data->>''display_name'', ''^\s+|\s+$'', '''', ''g''), '''')');
end $$;

update public.fantasy_league_activity a
set payload = (
  select jsonb_object_agg(kv.key,
           case when kv.value = to_jsonb(split_part(p.email, '@', 1))
                then coalesce(to_jsonb(p.username), to_jsonb('Someone'::text))
                else kv.value end)
  from jsonb_each(a.payload) kv
)
from public.profiles p
where p.id = a.actor_user_id
  and exists (select 1 from jsonb_each_text(a.payload) kv where kv.value = split_part(p.email, '@', 1));
