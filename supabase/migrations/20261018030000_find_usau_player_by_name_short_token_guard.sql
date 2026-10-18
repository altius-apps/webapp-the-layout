-- find_usau_player_by_name: no lookup when the last-name token is under 3
-- characters (security re-review 2026-10-17, HIGH; Hunter approved).
--
-- The function scans usau_players for '%<last token>%'. Under 3 characters that
-- matches most of the 410k rows and runs names_match on each: "Li" took > 6 s,
-- a 1-letter token ~1 h. It is anon-callable, so one POST burned up to anon's
-- 3 s statement_timeout of CPU and a dozen in parallel pinned both vCPUs.
-- Such names now return null at once. For 2-char surnames that is the answer
-- callers effectively got before (a timeout); callers already treat null as
-- "not found" (web findUsauPlayerByName, mobile, get_player_connections).
-- The guard is a parameter-only qual, so the planner evaluates it once as a
-- one-time filter before touching usau_players (verified: "Kevin Li" returns
-- null immediately; "Kirsten Lundquist" resolves to the same id as before).
--
-- Shared DB with mobile: patched from the LIVE body (md5 of prosrc + exactly
-- one anchor), never re-created from committed text. pg_get_functiondef keeps
-- STABLE, search_path and grants.

do $patch$
declare
  v_oid oid := to_regprocedure('public.find_usau_player_by_name(text)');
  v_def text;
  v_old text := $a$  where public.normalize_player_name(p.display_name) ilike$a$;
begin
  if v_oid is null then raise exception 'find_usau_player_by_name(text) not found'; end if;
  if (select md5(prosrc) from pg_proc where oid = v_oid) <> 'd9655e731bd6572f6600c90be732a6af' then
    raise exception 'find_usau_player_by_name changed since 2026-10-17 (md5): re-read it before patching';
  end if;
  v_def := pg_get_functiondef(v_oid);
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'find_usau_player_by_name: expected exactly one anchor';
  end if;
  execute replace(v_def, v_old, $b$  where length(split_part(public.normalize_player_name(p_name), ' ',
          array_length(regexp_split_to_array(public.normalize_player_name(p_name), '\s+'), 1))) >= 3
    and public.normalize_player_name(p.display_name) ilike$b$);
end
$patch$;

notify pgrst, 'reload schema';
