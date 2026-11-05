drop policy if exists profiles_select_authenticated on public.profiles;

create policy profiles_select_authenticated
  on public.profiles for select
  to authenticated
  using (true);

revoke select on public.profiles from authenticated;
grant select (id, display_name, username, avatar_url, avatar_icon, role, created_at, updated_at)
  on public.profiles to authenticated;

create or replace view public.profile_contact
  with (security_invoker = false) as
  select p.id, p.email, p.phone
  from public.profiles p
  where p.id = (select auth.uid())
     or public.is_admin()
     or exists (
       select 1
       from public.pb_team_members mine
       join public.pb_team_members theirs on theirs.team_id = mine.team_id
       where mine.user_id = (select auth.uid())
         and theirs.user_id = p.id
     );

grant select on public.profile_contact to authenticated;

comment on view public.profile_contact is
  'Email/phone for rows the caller may see: self, playbook teammates, or admin.
   Exists because SELECT on profiles.email/phone is revoked from authenticated
   so one user cannot enumerate every other user''s contact details.';
