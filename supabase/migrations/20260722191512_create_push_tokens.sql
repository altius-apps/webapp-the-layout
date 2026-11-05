-- Expo push tokens — one row per (user, device token). Powers push
-- notifications: the app registers the device's Expo push token here on sign-in,
-- and a future sender (Edge Function → Expo Push API) reads them to deliver
-- notifications to a user's devices.
--
-- SECURITY: RLS is ON with OWN-ROW policies. A user may INSERT/UPDATE/SELECT/
-- DELETE only rows where user_id = auth.uid() — they manage their own device
-- tokens and can never read or touch another user's. The eventual SENDER runs
-- as an Edge Function with the service-role key (bypasses RLS) to read tokens
-- across users. No client ever reads another user's token.
--
-- The token itself is not a secret credential (it addresses a device via Expo's
-- push service; it can't be used to impersonate the user), but it IS
-- device-linking metadata, so we still scope reads to the owner.

create table if not exists public.push_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- The Expo push token string, e.g. "ExponentPushToken[xxxxxxxx]".
  token       text not null,
  -- 'ios' | 'android' — for per-platform sending/debugging.
  platform    text not null check (platform in ('ios', 'android')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- One row per distinct device token. A token moving to a new user (device
  -- handed off / re-login) updates the owner via upsert on this key.
  unique (token)
);

create index if not exists push_tokens_user_idx on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;

-- Own-row access only (mirrors profiles_*_own). auth.uid() is the caller.
create policy push_tokens_select_own on public.push_tokens
  for select using ((select auth.uid()) = user_id);

create policy push_tokens_insert_own on public.push_tokens
  for insert with check ((select auth.uid()) = user_id);

create policy push_tokens_update_own on public.push_tokens
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy push_tokens_delete_own on public.push_tokens
  for delete using ((select auth.uid()) = user_id);

-- Keep updated_at fresh on upsert-as-update.
create or replace function public.push_tokens_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger push_tokens_set_updated_at
  before update on public.push_tokens
  for each row execute function public.push_tokens_set_updated_at();
