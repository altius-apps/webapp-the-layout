-- Fantasy league invites: at most 3 sends per address per league per rolling
-- 24 h (Hunter, 2026-10-09).
--
-- The fantasy-invite-email Edge Function (mobile repo) calls
-- fantasy_create_league_invite right before every send, so each call is one
-- email. Its 60 s per-invite cooldown still allowed ~60 emails an hour to one
-- address. The cap lives here so it holds for every caller; the function maps
-- the 'invite_resend_limit' error to a 429.
--
-- Patched in place from the live body (shared with mobile), guarded on its md5.

alter table public.fantasy_league_invites
  add column send_count integer not null default 0,
  add column send_window_started_at timestamptz;

comment on column public.fantasy_league_invites.send_count is
  'Sends to this address since send_window_started_at (fantasy_create_league_invite caps it at 3 per 24 h).';

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
      where oid = 'public.fantasy_create_league_invite(uuid, text)'::regprocedure)
     <> 'bfd1b3abf4d924e782cdbdd49601d343' then
    raise exception 'fantasy_create_league_invite changed since 2026-10-09 — re-derive this patch from the live body';
  end if;

  v := pg_get_functiondef('public.fantasy_create_league_invite(uuid, text)'::regprocedure);

  v := pg_temp.replace_once(v,
'  v_expires_at timestamptz;
',
'  v_expires_at timestamptz;
  v_pending public.fantasy_league_invites;
',
    'declare block');

  v := pg_temp.replace_once(v,
'  v_token := translate(',
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

  v_token := translate(',
    'cap check');

  v := pg_temp.replace_once(v,
'  insert into public.fantasy_league_invites (league_id, email, token, invited_by, expires_at, last_sent_at)
  values (p_league, v_email, v_token, v_caller, v_expires_at, now())
  on conflict (league_id, email) where accepted_at is null
  do update set
    token = excluded.token,
    invited_by = excluded.invited_by,
    expires_at = excluded.expires_at,
    last_sent_at = now();',
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
    'upsert');

  execute v;
end;
$mig$;
