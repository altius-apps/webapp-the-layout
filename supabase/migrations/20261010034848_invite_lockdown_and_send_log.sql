-- Invite lockdown + one send log for Playbook and fantasy invites (2026-10-09,
-- found by the mobile session's review of the shared invite-email function;
-- verified on prod in a rolled-back test).
--
-- HIGH: pb_team_invites let any team editor INSERT rows directly, with any
--   role and a token of their choosing. A coach could invite their own email
--   as 'owner' and accept it, becoming team owner (create_team_invite refuses
--   owner invites, but the direct INSERT skipped it). pb_team_members had the
--   same hole: any editor could INSERT a member row with role 'owner' (e.g.
--   for a second account). Clients never insert either directly: invites go
--   through create_team_invite, members through accept_team_invite and the
--   pb_teams_seed_owner trigger (both SECURITY DEFINER), so both INSERT
--   policies and grants go.
-- MEDIUM: the per-address send cap (20261010031548 / 20261010032547) lived on
--   the invite row, and editors may DELETE pending invites (revoke), so
--   delete + re-invite reset it: unlimited email to any address from our
--   sending domain. Limits now come from invite_sends, an append-only log no
--   client can read or write:
--     • at most 3 sends per address per league/team per rolling 24 h
--       ('invite_resend_limit')
--     • at most 20 sends per inviter per rolling hour across both kinds
--       ('invite_rate_limit')
--   The send_count/send_window_started_at columns added earlier today are
--   dropped.
-- LOW: accept_team_invite's upsert overwrote the member's role, so accepting
--   a lower-role invite demoted (even an owner). Accepting now only ever
--   raises a role, and returns the role the member actually has.
--
-- Shared functions are patched in place from the live bodies, guarded on md5.

-- ── Send log ────────────────────────────────────────────────────────────────
create table public.invite_sends (
  id         bigint generated always as identity primary key,
  kind       text        not null check (kind in ('fantasy', 'playbook')),
  scope_id   uuid        not null,  -- fantasy_leagues.id or pb_teams.id
  email      text        not null,
  invited_by uuid        not null,
  sent_at    timestamptz not null default now()
);

create index invite_sends_address_idx on public.invite_sends (kind, scope_id, email, sent_at desc);
create index invite_sends_inviter_idx on public.invite_sends (invited_by, sent_at desc);

comment on table public.invite_sends is
  'One row per invite (re)issue by create_team_invite / fantasy_create_league_invite. '
  'Append-only; the send limits read it. No client access.';

alter table public.invite_sends enable row level security;
revoke all on public.invite_sends from public, anon, authenticated;

-- ── Table access ────────────────────────────────────────────────────────────
drop policy "pb_team_invites_insert_editor" on public.pb_team_invites;
revoke insert, update, truncate, references, trigger on public.pb_team_invites from anon, authenticated;
revoke all on public.pb_team_invites from anon;

revoke insert, update, delete, truncate, references, trigger on public.fantasy_league_invites from anon, authenticated;
revoke all on public.fantasy_league_invites from anon;

drop policy "pb_team_members_insert_editor" on public.pb_team_members;
revoke insert, truncate, references, trigger on public.pb_team_members from anon, authenticated;
revoke all on public.pb_team_members from anon;

create or replace function pg_temp.replace_once(p_src text, p_old text, p_new text, p_what text)
returns text
language plpgsql
as $$
begin
  if (length(p_src) - length(replace(p_src, p_old, ''))) / length(p_old) <> 1 then
    raise exception '%: anchor not found exactly once — aborting rather than guessing', p_what;
  end if;
  return replace(p_src, p_old, p_new);
end;
$$;

-- ── create_team_invite ──────────────────────────────────────────────────────
do $mig$
declare
  v text;
begin
  if (select md5(prosrc) from pg_proc
      where oid = 'public.create_team_invite(uuid, text, public.pb_team_role)'::regprocedure)
     <> 'c66688a7c5cb74df4cbc67b76bee9d6e' then
    raise exception 'create_team_invite changed since 2026-10-09 — re-derive this patch from the live body';
  end if;

  v := pg_get_functiondef('public.create_team_invite(uuid, text, public.pb_team_role)'::regprocedure);

  v := pg_temp.replace_once(v,
'  v_pending public.pb_team_invites;
', '', 'declare block');

  v := pg_temp.replace_once(v,
'  -- Lock any pending invite to this address so parallel sends count in turn.
  select * into v_pending
  from public.pb_team_invites
  where team_id = p_team_id and email = v_email and accepted_at is null
  for update;

  if found
     and v_pending.send_window_started_at > now() - interval ''24 hours''
     and v_pending.send_count >= 3 then
    raise exception ''invite_resend_limit''
      using detail = ''This address was already invited 3 times in the last 24 hours.'';
  end if;
',
'  -- Limits read invite_sends, which no client can touch, so revoking (deleting)
  -- a pending invite resets nothing. The locks (address, then inviter) make
  -- parallel sends count in turn.
  perform pg_advisory_xact_lock(hashtext(''invite_sends''), hashtext(''playbook:'' || p_team_id || '':'' || v_email));
  perform pg_advisory_xact_lock(hashtext(''invite_inviter''), hashtext(v_caller::text));

  if (select count(*) from public.invite_sends s
      where s.kind = ''playbook'' and s.scope_id = p_team_id and s.email = v_email
        and s.sent_at > now() - interval ''24 hours'') >= 3 then
    raise exception ''invite_resend_limit''
      using detail = ''This address was already invited 3 times in the last 24 hours.'';
  end if;

  if (select count(*) from public.invite_sends s
      where s.invited_by = v_caller and s.sent_at > now() - interval ''1 hour'') >= 20 then
    raise exception ''invite_rate_limit''
      using detail = ''Too many invites sent in the last hour.'';
  end if;
',
    'limit check');

  v := pg_temp.replace_once(v,
'  insert into public.pb_team_invites as i
    (team_id, email, role, token, invited_by, expires_at, last_sent_at, send_count, send_window_started_at)
  values (p_team_id, v_email, p_role, v_token, v_caller, v_expires_at, now(), 1, now())
  on conflict (team_id, email) where accepted_at is null
  do update set
    token = excluded.token,
    role = excluded.role,
    invited_by = excluded.invited_by,
    expires_at = excluded.expires_at,
    last_sent_at = now(),
    send_count = case when i.send_window_started_at > now() - interval ''24 hours''
                      then i.send_count + 1 else 1 end,
    send_window_started_at = case when i.send_window_started_at > now() - interval ''24 hours''
                                  then i.send_window_started_at else now() end;',
'  insert into public.pb_team_invites (team_id, email, role, token, invited_by, expires_at, last_sent_at)
  values (p_team_id, v_email, p_role, v_token, v_caller, v_expires_at, now())
  on conflict (team_id, email) where accepted_at is null
  do update set
    token = excluded.token,
    role = excluded.role,
    invited_by = excluded.invited_by,
    expires_at = excluded.expires_at,
    last_sent_at = now();

  insert into public.invite_sends (kind, scope_id, email, invited_by)
  values (''playbook'', p_team_id, v_email, v_caller);',
    'upsert');

  execute v;
end;
$mig$;

-- ── fantasy_create_league_invite ────────────────────────────────────────────
do $mig$
declare
  v text;
begin
  if (select md5(prosrc) from pg_proc
      where oid = 'public.fantasy_create_league_invite(uuid, text)'::regprocedure)
     <> 'f7dba9fe35e900cdb70127b95b84904a' then
    raise exception 'fantasy_create_league_invite changed since 2026-10-09 — re-derive this patch from the live body';
  end if;

  v := pg_get_functiondef('public.fantasy_create_league_invite(uuid, text)'::regprocedure);

  v := pg_temp.replace_once(v,
'  v_pending public.fantasy_league_invites;
', '', 'declare block');

  v := pg_temp.replace_once(v,
'  -- Lock any pending invite to this address so parallel sends count in turn.
  select * into v_pending
  from public.fantasy_league_invites
  where league_id = p_league and email = v_email and accepted_at is null
  for update;

  if found
     and v_pending.send_window_started_at > now() - interval ''24 hours''
     and v_pending.send_count >= 3 then
    raise exception ''invite_resend_limit''
      using detail = ''This address was already invited 3 times in the last 24 hours.'';
  end if;
',
'  -- Limits read invite_sends, which no client can touch. The locks (address,
  -- then inviter) make parallel sends count in turn.
  perform pg_advisory_xact_lock(hashtext(''invite_sends''), hashtext(''fantasy:'' || p_league || '':'' || v_email));
  perform pg_advisory_xact_lock(hashtext(''invite_inviter''), hashtext(v_caller::text));

  if (select count(*) from public.invite_sends s
      where s.kind = ''fantasy'' and s.scope_id = p_league and s.email = v_email
        and s.sent_at > now() - interval ''24 hours'') >= 3 then
    raise exception ''invite_resend_limit''
      using detail = ''This address was already invited 3 times in the last 24 hours.'';
  end if;

  if (select count(*) from public.invite_sends s
      where s.invited_by = v_caller and s.sent_at > now() - interval ''1 hour'') >= 20 then
    raise exception ''invite_rate_limit''
      using detail = ''Too many invites sent in the last hour.'';
  end if;
',
    'limit check');

  v := pg_temp.replace_once(v,
'  insert into public.fantasy_league_invites as i
    (league_id, email, token, invited_by, expires_at, last_sent_at, send_count, send_window_started_at)
  values (p_league, v_email, v_token, v_caller, v_expires_at, now(), 1, now())
  on conflict (league_id, email) where accepted_at is null
  do update set
    token = excluded.token,
    invited_by = excluded.invited_by,
    expires_at = excluded.expires_at,
    last_sent_at = now(),
    send_count = case when i.send_window_started_at > now() - interval ''24 hours''
                      then i.send_count + 1 else 1 end,
    send_window_started_at = case when i.send_window_started_at > now() - interval ''24 hours''
                                  then i.send_window_started_at else now() end;',
'  insert into public.fantasy_league_invites (league_id, email, token, invited_by, expires_at, last_sent_at)
  values (p_league, v_email, v_token, v_caller, v_expires_at, now())
  on conflict (league_id, email) where accepted_at is null
  do update set
    token = excluded.token,
    invited_by = excluded.invited_by,
    expires_at = excluded.expires_at,
    last_sent_at = now();

  insert into public.invite_sends (kind, scope_id, email, invited_by)
  values (''fantasy'', p_league, v_email, v_caller);',
    'upsert');

  execute v;
end;
$mig$;

alter table public.pb_team_invites
  drop column send_count,
  drop column send_window_started_at;

alter table public.fantasy_league_invites
  drop column send_count,
  drop column send_window_started_at;

-- ── accept_team_invite: never demote ────────────────────────────────────────
do $mig$
declare
  v text;
begin
  if (select md5(prosrc) from pg_proc
      where oid = 'public.accept_team_invite(text)'::regprocedure)
     <> 'ad21df16ba871183cdd9ad9e82d8bb0f' then
    raise exception 'accept_team_invite changed since 2026-10-09 — re-derive this patch from the live body';
  end if;

  v := pg_get_functiondef('public.accept_team_invite(text)'::regprocedure);

  v := pg_temp.replace_once(v,
'  on conflict (team_id, user_id) do update
    set role = excluded.role;
',
'  on conflict (team_id, user_id) do update
    set role = excluded.role
    -- Only ever raise a role (member < coach < owner).
    where (case public.pb_team_members.role when ''owner'' then 3 when ''coach'' then 2 else 1 end)
        < (case excluded.role when ''owner'' then 3 when ''coach'' then 2 else 1 end);

  select m.role into v_out_role
  from public.pb_team_members m
  where m.team_id = v_out_team_id and m.user_id = v_caller;
',
    'member upsert');

  execute v;
end;
$mig$;
