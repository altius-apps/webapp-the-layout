-- notification_prefs: per-user push notification toggles (mobile Settings →
-- Notifications). One row per user; A MISSING ROW MEANS ALL DEFAULTS (opt-out
-- model) — the client only writes a row on the first toggle, and the future
-- push sender must treat "no row" as "everything enabled".
--
-- Columns are one boolean per notification category so the sender can filter
-- with a plain WHERE instead of unpacking jsonb. Categories are the contract
-- for the sender (not yet built, 2026-08-02):
--   push_enabled — master switch; when false, no category may fire.
--   game_start   — a followed team's game is starting.
--   game_final   — a followed team's game went final.
--   news         — occasional product/feature announcements.
-- New categories = additive columns with default true.
create table public.notification_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  push_enabled boolean not null default true,
  game_start boolean not null default true,
  game_final boolean not null default true,
  news boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.notification_prefs enable row level security;

-- Own-row only, all three verbs the client needs (no DELETE — the row dies
-- with the account via the FK cascade). auth.uid() wrapped in (select …) for
-- per-statement caching, house convention.
create policy notification_prefs_select_own on public.notification_prefs
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy notification_prefs_insert_own on public.notification_prefs
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy notification_prefs_update_own on public.notification_prefs
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update on public.notification_prefs to authenticated;
