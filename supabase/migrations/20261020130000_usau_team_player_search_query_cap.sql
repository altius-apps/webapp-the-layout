-- Cap the query length of the anon-callable USAU team / player fuzzy search
-- RPCs at 100 chars, the same as search_usau_event_groups_fuzzy (security
-- review 2026-10-20). Each row runs a similarity check against q, so an
-- unbounded q is CPU an anonymous caller can burn on a 2 vCPU DB.
--
-- Shared-RPC rule: these functions are shared with the mobile repo, so the
-- committed text isn't authoritative. Patch the LIVE definition
-- (pg_get_functiondef), changing only the lines below, and fail if the
-- expected text isn't there.

do $$
declare
  def text;
  patched text;
begin
  -- plpgsql: parameters are assignable, so clamp q once at the top.
  def := pg_get_functiondef('public.search_usau_players_fuzzy(text, integer)'::regprocedure);
  patched := replace(def, E'begin\n  perform set_config(', E'begin\n  q := left(q, 100);\n  perform set_config(');
  if patched = def then
    raise exception 'search_usau_players_fuzzy: expected body not found';
  end if;
  execute patched;

  -- sql: no assignment, so read every use of q through left(q, 100).
  def := pg_get_functiondef('public.search_usau_teams_fuzzy(text, integer)'::regprocedure);
  patched := replace(replace(def,
    $r$'%' || q || '%'$r$, $r$'%' || left(q, 100) || '%'$r$),
    'word_similarity(q, t.name)', 'word_similarity(left(q, 100), t.name)');
  if patched = def or position('word_similarity(q,' in patched) > 0 then
    raise exception 'search_usau_teams_fuzzy: expected body not found';
  end if;
  execute patched;
end $$;

notify pgrst, 'reload schema';
