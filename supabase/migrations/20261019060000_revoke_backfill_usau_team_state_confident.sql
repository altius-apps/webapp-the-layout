-- Security review 2026-10-19 (Hunter: "yes"): a one-off backfill that anon and
-- authenticated could still call. Under RLS it updated 0 rows, but each call ran a
-- ~41k-row aggregate. No app, cron or edge function calls it.
revoke execute on function public.backfill_usau_team_state_confident() from public, anon, authenticated;
