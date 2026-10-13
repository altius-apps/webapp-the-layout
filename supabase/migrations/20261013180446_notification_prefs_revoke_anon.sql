-- notification_prefs: drop anon's table grants (Hunter, 2026-10-13). They came
-- from the default ACL and were inert under RLS (all 3 policies are own-row,
-- TO authenticated) except TRUNCATE, which RLS doesn't cover. Nothing anon
-- touches the table: both apps read it signed in with the user JWT, and the
-- edge functions use service_role (security review, 2026-10-13). An anon call
-- now gets 42501 instead of an empty list. The default ACL re-grants anon on
-- every new table, so this is a per-table fix.
-- APPLIED to prod 2026-10-13 (remote version 20261013180446).

revoke all on table public.notification_prefs from anon;

do $$
begin
  if has_table_privilege('anon', 'public.notification_prefs', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
    raise exception 'anon still holds a privilege on notification_prefs after revoke';
  end if;
  if not has_table_privilege('authenticated', 'public.notification_prefs', 'SELECT') then
    raise exception 'authenticated lost SELECT on notification_prefs';
  end if;
end;
$$;
