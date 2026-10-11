-- Exported from the remote migration ledger on 2026-10-11 (Feature Backlog #37): applied to prod but never committed to this repo.
-- ═══════════════════════════════════════════════════════════════════════════
-- UTCG (Ultimate Trading Card Game) — per-user persistence.
--
-- SECURITY MODEL: server-authoritative economy.
--   - Users have READ-ONLY RLS on their own wallet / owned cards / ledger.
--   - Users have NO direct INSERT/UPDATE/DELETE on these tables.
--   - ALL mutations (open pack, quicksell dupes, spend coins, match reward)
--     go through SECURITY DEFINER functions (added in a follow-up migration)
--     that enforce the economy. This prevents the raw-REST bypass where a
--     client grants itself cards or coins (cf. Moderation DB backstop memo).
--
-- Card identity = the twelve_oh_players PK tuple, UFA-only for the MVP:
--   (player_id, team_slug, year). We denormalize league implicitly = 'ufa'.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Wallet: one row per user, holds soft currency + pack cadence ──
create table if not exists public.utcg_wallets (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  coins          integer not null default 0 check (coins >= 0),
  -- last time the user claimed their free (every-3-days) pack; null = never
  last_free_pack_at timestamptz,
  -- lifetime counters (display / anti-cheat sanity)
  packs_opened   integer not null default 0 check (packs_opened >= 0),
  matches_played integer not null default 0 check (matches_played >= 0),
  best_wins      integer not null default 0 check (best_wins between 0 and 12),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── Owned cards: one row per (user, card), with a duplicate count ──
-- copies>=1 always (a row exists only if the user owns ≥1). Dupes accumulate
-- as `copies`; quicksell decrements and refunds coins.
create table if not exists public.utcg_owned_cards (
  user_id     uuid not null references auth.users(id) on delete cascade,
  league      text not null default 'ufa' check (league = 'ufa'),
  player_id   text not null,
  team_slug   text not null,
  year        integer not null,
  copies      integer not null default 1 check (copies >= 1),
  first_acquired_at timestamptz not null default now(),
  primary key (user_id, league, player_id, team_slug, year)
);
create index if not exists utcg_owned_cards_user_idx on public.utcg_owned_cards(user_id);

-- ── Pack ledger: an audit row per pack opened (what was pulled) ──
-- Also the anti-cheat / support trail. Stores the pulled card tuples as jsonb.
create table if not exists public.utcg_pack_openings (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  pack_kind   text not null,               -- 'free' | 'bronze' | 'gold' | 'elite'
  coins_spent integer not null default 0 check (coins_spent >= 0),
  pulls       jsonb not null,              -- [{player_id, team_slug, year, player_score, is_new}]
  opened_at   timestamptz not null default now()
);
create index if not exists utcg_pack_openings_user_idx on public.utcg_pack_openings(user_id, opened_at desc);

-- ── RLS: read-own only; all writes via SECURITY DEFINER RPCs ──
alter table public.utcg_wallets       enable row level security;
alter table public.utcg_owned_cards   enable row level security;
alter table public.utcg_pack_openings enable row level security;

create policy utcg_wallets_select_own on public.utcg_wallets
  for select using ((select auth.uid()) = user_id);

create policy utcg_owned_cards_select_own on public.utcg_owned_cards
  for select using ((select auth.uid()) = user_id);

create policy utcg_pack_openings_select_own on public.utcg_pack_openings
  for select using ((select auth.uid()) = user_id);

-- NO insert/update/delete policies → clients cannot mutate directly.
-- (RLS default-deny for authenticated/anon; SECURITY DEFINER RPCs bypass RLS.)

-- keep updated_at fresh on wallet writes
create or replace function public.utcg_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists utcg_wallets_touch on public.utcg_wallets;
create trigger utcg_wallets_touch before update on public.utcg_wallets
  for each row execute function public.utcg_touch_updated_at();
