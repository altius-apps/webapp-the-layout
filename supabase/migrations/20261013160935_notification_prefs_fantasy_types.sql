-- Per-type fantasy push toggles (Hunter, 2026-10-13: a Fantasy sub-section in
-- the mobile app's Settings -> Notifications). notification_prefs.fantasy stays
-- the Fantasy master switch; these narrow it by notify-fantasy's categories:
--   fantasy_draft_reminders -> draft_reminder (24h / 1h before the draft)
--   fantasy_draft_updates   -> draft_live, draft_complete
--   fantasy_on_clock        -> draft_on_clock (your pick / nomination is up)
--   fantasy_matchups        -> matchup_result (weekly head-to-head finals)
-- Default on, like every pref: a missing row still means "everything on".
-- The table's own-row RLS policies cover the new columns; no grant changes.
-- APPLIED to prod 2026-10-13 from the mobile session (remote version
-- 20261013160935); saved here so the repo matches.

alter table public.notification_prefs
  add column if not exists fantasy_draft_reminders boolean not null default true,
  add column if not exists fantasy_draft_updates boolean not null default true,
  add column if not exists fantasy_on_clock boolean not null default true,
  add column if not exists fantasy_matchups boolean not null default true;
