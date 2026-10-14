-- Admins are auto-members of official leagues so they can read and moderate
-- the chat (Hunter, 2026-10-14). Chat reads are member-only; the admin delete
-- policy from 20261014191428 only reaches rows the admin can see.

-- 1. New official leagues get every admin when they're created (patched in
--    place; md5 + exact-anchor guarded).
do $patch$
declare
  v_oid oid := to_regprocedure('public.fantasy_ensure_official_leagues()');
  v_def text;
  c_anchor constant text := E'      v_created := v_created + 1;';
  c_repl constant text :=
    E'      insert into public.fantasy_league_members (league_id, user_id, role)\n'
    || E'      select v_league, p.id, ''member''\n'
    || E'      from public.profiles p\n'
    || E'      where p.role = ''admin'' and p.id <> v_owner\n'
    || E'      on conflict (league_id, user_id) do nothing;\n\n'
    || E'      v_created := v_created + 1;';
begin
  if (select md5(prosrc) from pg_proc where oid = v_oid) <> '093d4423e3887916f7c8a6801fdf1ff6' then
    raise exception 'fantasy_ensure_official_leagues changed since it was read (md5)';
  end if;
  v_def := pg_get_functiondef(v_oid);
  if (length(v_def) - length(replace(v_def, c_anchor, ''))) / length(c_anchor) <> 1 then
    raise exception 'fantasy_ensure_official_leagues: anchor not found exactly once';
  end if;
  execute replace(v_def, c_anchor, c_repl);
end
$patch$;

-- 2. Someone made admin later joins every official league still in play.
create or replace function public.fantasy_admin_join_official_leagues()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role = 'admin' and (tg_op = 'INSERT' or old.role is distinct from new.role) then
    insert into public.fantasy_league_members (league_id, user_id, role)
    select l.id, new.id, 'member'
    from public.fantasy_leagues l
    where l.is_official
      and exists (
        select 1 from public.fantasy_contests c
        where c.league_id = l.id and c.status <> 'complete'
      )
    on conflict (league_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

revoke execute on function public.fantasy_admin_join_official_leagues() from public, anon, authenticated;

drop trigger if exists fantasy_admin_join_official_leagues on public.profiles;
create trigger fantasy_admin_join_official_leagues
  after insert or update of role on public.profiles
  for each row execute function public.fantasy_admin_join_official_leagues();

-- 3. Today's admins into today's official leagues.
insert into public.fantasy_league_members (league_id, user_id, role)
select l.id, p.id, 'member'
from public.fantasy_leagues l
cross join public.profiles p
where l.is_official
  and p.role = 'admin'
  and p.id <> l.owner_id
  and exists (
    select 1 from public.fantasy_contests c
    where c.league_id = l.id and c.status <> 'complete'
  )
on conflict (league_id, user_id) do nothing;
