-- Fix: placement-bracket finals were crowning USAU national champions.
--
-- `usau_games.round = 'final'` marks the LAST GAME OF EVERY BRACKET, not the
-- gold-medal game. A Nationals event therefore yields several round='final'
-- rows — 11th Place, 13th Place, 5th Place (Pro Flight), … alongside the real
-- Championship Bracket final. `usau_nationals_finals` filtered only on
-- round='final', so whichever placement final Postgres returned first for a
-- (season, division) became that year's champion.
--
-- Observed: 2016 Men returned "11th Place" (Prairie Fire beat H.I.P 15-11)
-- ahead of "Championship Bracket" (Ironside beat Revolver 14-13). Prairie Fire
-- was crowned 2016 national champion, and because championYearsUsau feeds the
-- player profile hero, the badge propagated to all 27 players on that roster —
-- e.g. Jay Froude showed "USAU National Champion 2016" next to his real 2022
-- Johnny Bravo title.
--
-- Fix mirrors isChampionshipBracketName() in the mobile client
-- (src/lib/usau/data.ts): reject any bracket name carrying an ordinal
-- (\d+(st|nd|rd|th)) plus consolation/placement. Ties are also excluded — a
-- drawn game cannot decide a title.
--
-- ORDER MATTERS — "1st Place Bracket" IS the championship. The client checks
-- /\b1st place\b/ and /\bfirst place\b/ and returns TRUE *before* it applies
-- the ordinal rejection. An earlier revision of this migration ported only the
-- rejection and lost that precedence, so every 2018 final ("1st Place Bracket"
-- — the one season USAU used that name) was thrown out and Ben Jagt's real
-- 2018 PoNY title vanished from his profile. The exemption below restores it.
-- "First Place Bracket" (2022) was unaffected either way since it carries no
-- digit, which is exactly why the regression looked season-specific.
--
-- Verified across every stored Club Nationals season (2014-2025): exactly one
-- champion per (season, division), all historically correct. 2016 resolves to
-- Ironside / Brute Squad / Slow White; 2018 to PoNY / Fury / AMP.
--
-- NOTE: the same defect existed independently in the client-side fallback
-- assembler (getUsauClubChampionsBySeason) and is fixed in the same change;
-- both paths must agree or a cache miss would flip the badge back.
--
-- Patches live prosrc rather than restating the function — see
-- 20260729000000_player_profile_rpc_fixes.sql for why (four migrations exist
-- only in the remote DB; restating would revert them).

do $outer$
declare
  v_orig text;
  v_body text;
begin
  select prosrc into v_orig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = '_build_player_profile';

  if v_orig is null then
    raise exception '_build_player_profile not found -- apply the player_profile_rpc migrations first';
  end if;

  if v_orig like '%-- CHAMPIONSHIP BRACKET ONLY%' then
    raise notice '_build_player_profile champion filter already applied; skipping';
    return;
  end if;

  v_body := replace(
    v_orig,
    E'    where g.round = \'final\' and g.score_a is not null and g.score_b is not null\n  ),',
    E'    where g.round = \'final\' and g.score_a is not null and g.score_b is not null\n'
    '      and g.score_a <> g.score_b\n'
    '      -- CHAMPIONSHIP BRACKET ONLY: round=''final'' is the last game of ANY\n'
    '      -- bracket, so placement finals (11th/13th/5th Place) would otherwise\n'
    '      -- crown a champion. Mirrors isChampionshipBracketName() in the client,\n'
    '      -- INCLUDING its precedence: "1st Place"/"First Place" IS the title\n'
    '      -- bracket and must be accepted BEFORE the ordinal rejection, or 2018\n'
    '      -- ("1st Place Bracket") loses its real champions.\n'
    '      and (\n'
    '        coalesce(g.bracket_name, '''') ~* ''\\m(1st|first) place\\M''\n'
    '        or coalesce(g.bracket_name, '''') !~* ''\\m\\d+(st|nd|rd|th)\\M''\n'
    '      )\n'
    '      and coalesce(g.bracket_name, '''') !~* ''consolation|placement''\n'
    '  ),'
  );

  if v_body = v_orig then
    raise exception
      'champion-bracket patch did not apply -- the usau_nationals_finals WHERE '
      'clause no longer matches the deployed body; re-derive against current prosrc';
  end if;

  execute format(
    'create or replace function public._build_player_profile(p_anchor_id text) '
    'returns jsonb language plpgsql security invoker set search_path to ''public'' as %L',
    v_body
  );
end
$outer$;

-- Cached profiles carry the bad badge; force a rebuild.
truncate table public.player_profiles;
