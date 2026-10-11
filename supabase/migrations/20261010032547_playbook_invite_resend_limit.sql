-- Playbook team invites: same send bookkeeping as fantasy league invites
-- (20261010031548), for the shared invite-email Edge Function (Hunter,
-- 2026-10-09).
--
-- create_team_invite now stamps last_sent_at on every (re)issue and allows at
-- most 3 sends per address per team per rolling 24 h. The function calls it
-- right before each send, reads last_sent_at first for its 60 s cooldown, and
-- maps 'invite_resend_limit' to a 429. Before this, the web resend action's
-- "stamp after send" was a no-op (pb_team_invites has no UPDATE policy), so the
-- cooldown never fired and resends were unlimited.
--
-- Patched in place from the live body (shared with mobile), guarded on its md5.

alter table public.pb_team_invites
  add column send_count integer not null default 0,
  add column send_window_started_at timestamptz;

comment on column public.pb_team_invites.send_count is
  'Sends to this address since send_window_started_at (create_team_invite caps it at 3 per 24 h).';

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

do $mig$
declare
  v text;
begin
  if (select md5(prosrc) from pg_proc
      where oid = 'public.create_team_invite(uuid, text, public.pb_team_role)'::regprocedure)
     <> 'ef52d5a06c16ff56994d123f63e6c36e' then
    raise exception 'create_team_invite changed since 2026-10-09 — re-derive this patch from the live body';
  end if;

  v := pg_get_functiondef('public.create_team_invite(uuid, text, public.pb_team_role)'::regprocedure);

  v := pg_temp.replace_once(v,
'  v_expires_at timestamptz;
',
'  v_expires_at timestamptz;
  v_pending public.pb_team_invites;
',
    'declare block');

  v := pg_temp.replace_once(v,
'  v_token := translate(',
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

  v_token := translate(',
    'cap check');

  v := pg_temp.replace_once(v,
'  insert into public.pb_team_invites (team_id, email, role, token, invited_by, expires_at)
  values (p_team_id, v_email, p_role, v_token, v_caller, v_expires_at)
  on conflict (team_id, email) where accepted_at is null
  do update set
    token = excluded.token,
    role = excluded.role,
    invited_by = excluded.invited_by,
    expires_at = excluded.expires_at;',
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
    'upsert');

  execute v;
end;
$mig$;
