-- Exported from the remote migration ledger on 2026-10-11 (Feature Backlog #37): applied to prod but never committed to this repo.
-- Advisor hygiene for the UTCG functions:
--   1. pin search_path on the pure/immutable helpers (mutating RPCs already had it)
--   2. revoke anon EXECUTE — every RPC already rejects null auth.uid(), but make
--      it explicit so anon can't even reach them (matches intended auth-only use).

alter function public.utcg_touch_updated_at()      set search_path = public;
alter function public.utcg_pack_config(text)        set search_path = public;
alter function public.utcg_tier_rank(numeric)       set search_path = public;
alter function public.utcg_quicksell_value(int)     set search_path = public;
alter function public.utcg_ufa_division(text)       set search_path = public;
alter function public.utcg_derive_position(numeric, numeric, numeric, numeric) set search_path = public;

-- Revoke anon execute on the user-facing RPCs (authenticated grants remain).
revoke execute on function public.utcg_ensure_wallet() from anon;
revoke execute on function public.utcg_open_pack(text) from anon;
revoke execute on function public.utcg_quicksell(text, text, int, int) from anon;
revoke execute on function public.utcg_record_match(text, jsonb) from anon;
