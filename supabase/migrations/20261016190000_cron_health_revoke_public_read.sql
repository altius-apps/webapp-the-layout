-- cron_health is a definer view over cron.job + cron.job_run_details, so its
-- default grants let anyone (anon included) list every background job, its
-- schedule and its last failure message. Nothing in web or mobile reads it;
-- it's for the SQL editor. Owner + service_role keep access.
revoke select on public.cron_health from public, anon, authenticated;
