-- Trade offers: store each side as the owned roster rows say, not as the
-- client sent it (Hunter, 2026-10-16; follows the draft/add-drop pool fixes).
--
-- fantasy_propose_trade checked that every playerId was owned, then stored
-- p_give / p_get verbatim. Their playerName is what the other team reads on the
-- trade card, and on accept fantasy_trade_execute_internal copies those names
-- into fantasy_transactions and the league activity feed. So an offer could
-- show one player's name while trading another's id. Now each side is rebuilt
-- from fantasy_team_players (league, id, the roster's own name), one entry per
-- player, so a repeated id no longer counts twice either. The note was already
-- checked (ugc_text_is_clean); unchanged.
--
-- Patched from the LIVE body (md5 of prosrc + exactly one anchor).

do $patch$
declare
  v_oid oid := to_regprocedure('public.fantasy_propose_trade(uuid,uuid,jsonb,jsonb,text)');
  v_def text;
  v_anchor text := $a$  insert into public.fantasy_trades (contest_id, proposer_team_id, receiver_team_id, give, get, note, created_by)
$a$;
begin
  if v_oid is null then
    raise exception 'fantasy_propose_trade not found';
  end if;
  if (select md5(prosrc) from pg_proc where oid = v_oid) <> '6e9a6bfcc6e948c15c919fb9827c4d28' then
    raise exception 'fantasy_propose_trade changed since 2026-10-16 (md5) — re-read it before patching';
  end if;
  v_def := pg_get_functiondef(v_oid);
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'fantasy_propose_trade: expected exactly one fantasy_trades insert';
  end if;
  execute replace(v_def, v_anchor, $a$  -- Each side as the roster rows say (names included), once per player.
  select jsonb_agg(jsonb_build_object('playerLeague', tp.player_league, 'playerId', tp.player_id, 'playerName', tp.player_name)
                   order by tp.player_name)
  into p_give
  from public.fantasy_team_players tp
  where tp.contest_id = p_contest and tp.team_id = v_my_team
    and exists (select 1 from jsonb_array_elements(p_give) e
                where e->>'playerLeague' = tp.player_league and e->>'playerId' = tp.player_id);
  select jsonb_agg(jsonb_build_object('playerLeague', tp.player_league, 'playerId', tp.player_id, 'playerName', tp.player_name)
                   order by tp.player_name)
  into p_get
  from public.fantasy_team_players tp
  where tp.contest_id = p_contest and tp.team_id = p_receiver_team
    and exists (select 1 from jsonb_array_elements(p_get) e
                where e->>'playerLeague' = tp.player_league and e->>'playerId' = tp.player_id);

$a$ || v_anchor);
end
$patch$;

notify pgrst, 'reload schema';
