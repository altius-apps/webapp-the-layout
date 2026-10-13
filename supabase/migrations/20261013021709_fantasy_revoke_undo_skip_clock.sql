-- Fantasy — no undo-last-pick and no skip-the-clock in the draft room
-- (Hunter, 2026-10-12). Both apps removed their commissioner bar; this locks
-- the two RPCs so no client can call them.
--
-- REVOKE only (reversible), not DROP. Nothing else calls them: no function
-- body, cron job, pg_depend row or deployed edge function references either
-- (checked 2026-10-12). Before this, EXECUTE was held by postgres,
-- authenticated and service_role (PUBLIC already revoked); after it, postgres
-- and service_role only. Both still open with fantasy_draft_commissioner_check,
-- which needs auth.uid(), so a bare service_role call fails too: a stuck
-- draft is fixed by a direct table edit.
-- APPLIED to prod 2026-10-12 (remote version 20261013021709) after a
-- rollback-only dry run and a security review (clean); verified anon and
-- authenticated can no longer execute either function.

revoke execute on function public.fantasy_undo_last_pick(uuid) from public, anon, authenticated;
revoke execute on function public.fantasy_skip_clock(uuid) from public, anon, authenticated;

do $$
declare
  fn regprocedure;
  r text;
begin
  foreach fn in array array[
    'public.fantasy_undo_last_pick(uuid)'::regprocedure,
    'public.fantasy_skip_clock(uuid)'::regprocedure
  ] loop
    foreach r in array array['public', 'anon', 'authenticated'] loop
      if has_function_privilege(r, fn, 'execute') then
        raise exception '% still executable by % after revoke', fn, r;
      end if;
    end loop;
  end loop;
end;
$$;
