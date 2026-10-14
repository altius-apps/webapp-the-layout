-- Draft scheduling notice: 30 → 15 minutes (Hunter, 2026-10-14).
--
-- Patches the live function bodies in place (shared DB with mobile — never
-- re-create these from committed text). Each function must still be the
-- 2026-10-13 version (md5 of prosrc) and hold exactly the expected number of
-- '30 minutes' strings (interval + messages + comment); every one becomes
-- '15 minutes'. pg_get_functiondef keeps security definer, search_path and
-- grants.
do $patch$
declare
  r record;
  v_oid oid;
  v_def text;
  v_hits int;
begin
  for r in
    select * from (values
      ('public.fantasy_draft_readiness(uuid)', '1336d7868a3ead7886bbaa66215e353a', 1),
      ('public.fantasy_reschedule_draft(uuid,timestamp with time zone)', '49171f498b0d92b586ffa8ddc0f97e67', 2),
      ('public.fantasy_schedule_draft(uuid,timestamp with time zone,integer,integer)', '666dfea9c73cfdcaa51efc52d351b239', 4),
      ('public.fantasy_schedule_auction_draft(uuid,timestamp with time zone,integer,integer,integer,integer,integer)', '641735c18b01f6deaef1de4142bed99f', 4)
    ) as t(sig, md5, hits)
  loop
    v_oid := to_regprocedure(r.sig);
    if v_oid is null then raise exception '% not found', r.sig; end if;
    if (select md5(prosrc) from pg_proc where oid = v_oid) <> r.md5 then
      raise exception '% changed since 2026-10-13 (md5) — re-read it before patching', r.sig;
    end if;
    v_def := pg_get_functiondef(v_oid);
    v_hits := (length(v_def) - length(replace(v_def, '30 minutes', ''))) / length('30 minutes');
    if v_hits <> r.hits then
      raise exception '%: expected % "30 minutes", found %', r.sig, r.hits, v_hits;
    end if;
    execute replace(v_def, '30 minutes', '15 minutes');
  end loop;
end
$patch$;
