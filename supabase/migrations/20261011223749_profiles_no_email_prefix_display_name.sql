-- Hunter 2026-10-11: email prefixes were showing as public names (54 of 103
-- profiles, from the signup default). Signup now leaves display_name null
-- unless one was provided; fantasy prompts for a name when it's missing.
-- Also cut a provided name to 60 chars: a longer one violated
-- profiles_display_name_length and failed the whole signup.
-- Patched from the live body (never re-create shared functions from repo text).
do $$
declare
  d text;
  old_expr constant text := 'coalesce(new.raw_user_meta_data->>''display_name'', split_part(new.email, ''@'', 1))';
begin
  select pg_get_functiondef('public.handle_new_user()'::regprocedure) into d;
  if position(old_expr in d) = 0 then
    raise exception 'handle_new_user does not have the expected display_name default';
  end if;
  execute replace(d, old_expr,
    'left(nullif(trim(new.raw_user_meta_data->>''display_name''), ''''), 60)');
end $$;

-- Existing email-prefix names. Recoverable: split_part(email, '@', 1).
-- The profile resync triggers clear the copies on fantasy teams and members.
update public.profiles
set display_name = null
where display_name = split_part(email, '@', 1);
