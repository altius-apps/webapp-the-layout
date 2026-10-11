-- Exported from the remote migration ledger on 2026-10-11 (Feature Backlog #37): applied to prod but never committed to this repo.
-- Formation change: remove 'spread', add 'hex' (4H/3C) and 'threeTwo' (2H/5C).
-- Mirrors FORMATIONS in src/lib/utcg/formations.ts. Only the slot_types CASE
-- changed; the rest of utcg_record_match is unchanged.
create or replace function public.utcg_record_match(p_formation text, p_cards jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  uid uuid := auth.uid();
  slot_types text[];
  n int; i int; elem jsonb; pos text; slot text; in_position boolean;
  card record;
  scores numeric[] := array[]::numeric[];
  team_counts jsonb := '{}'::jsonb;
  div_counts jsonb := '{}'::jsonb;
  league_count int := 0;
  slugs text[] := array[]::text[];
  divs text[] := array[]::text[];
  positions text[] := array[]::text[];
  slots text[] := array[]::text[];
  chem_total int := 0;
  team_chem int; div_chem int; league_chem int; card_chem int;
  cnt int; mean_score numeric; chem_bonus numeric;
  boosted numeric[]; min_boosted numeric; strength numeric;
  wins int; reward int; w public.utcg_wallets;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  -- formation → slot types (handlers first), mirrors FORMATIONS
  slot_types := case p_formation
    when 'vert'     then array['handler','handler','cutter','cutter','cutter','cutter','cutter']
    when 'ho'       then array['handler','handler','handler','cutter','cutter','cutter','cutter']
    when 'hex'      then array['handler','handler','handler','handler','cutter','cutter','cutter']
    when 'threeTwo' then array['handler','handler','cutter','cutter','cutter','cutter','cutter']
    else null end;
  if slot_types is null then raise exception 'unknown formation %', p_formation; end if;

  n := jsonb_array_length(p_cards);
  if n <> 7 then raise exception 'squad must have exactly 7 cards'; end if;

  for i in 0..6 loop
    elem := p_cards -> i;
    slot := slot_types[i+1];

    select p.player_id, p.team_slug, p.year, p.player_score::numeric as score,
           p.goals, p.assists, p.yards_thrown, p.yards_received
      into card
      from public.utcg_owned_cards oc
      join public.twelve_oh_players p
        on p.league='ufa' and p.player_id=oc.player_id
       and p.team_slug=oc.team_slug and p.year=oc.year
      where oc.user_id = uid and oc.league='ufa'
        and oc.player_id = (elem->>'player_id')
        and oc.team_slug = (elem->>'team_slug')
        and oc.year = (elem->>'year')::int
        and oc.copies >= 1;
    if card is null then raise exception 'card not owned or invalid: %', elem; end if;

    if (elem->>'player_id') = any(
         select (p_cards->j->>'player_id') from generate_series(0,i-1) j
         where (p_cards->j->>'player_id') = (elem->>'player_id')
           and (p_cards->j->>'team_slug') = (elem->>'team_slug')
           and (p_cards->j->>'year') = (elem->>'year')
       ) then
      raise exception 'duplicate card in squad';
    end if;

    pos := public.utcg_derive_position(card.goals, card.assists, card.yards_thrown, card.yards_received);

    scores := scores || card.score;
    slugs := slugs || card.team_slug;
    divs := divs || coalesce(public.utcg_ufa_division(card.team_slug), '');
    positions := positions || pos;
    slots := slots || slot;

    team_counts := jsonb_set(team_counts, array[card.team_slug],
                    to_jsonb(coalesce((team_counts->>card.team_slug)::int,0)+1));
    if public.utcg_ufa_division(card.team_slug) is not null then
      div_counts := jsonb_set(div_counts, array[public.utcg_ufa_division(card.team_slug)],
                    to_jsonb(coalesce((div_counts->>public.utcg_ufa_division(card.team_slug))::int,0)+1));
    end if;
    league_count := league_count + 1;
  end loop;

  for i in 1..7 loop
    in_position := (positions[i] = 'hybrid') or (positions[i] = slots[i]);
    if not in_position then continue; end if;

    cnt := (team_counts->>slugs[i])::int;
    team_chem := case when cnt >= 4 then 3 when cnt >= 3 then 2 when cnt >= 2 then 1 else 0 end;

    if divs[i] <> '' then
      cnt := (div_counts->>divs[i])::int;
      div_chem := case when cnt >= 7 then 3 when cnt >= 5 then 2 when cnt >= 3 then 1 else 0 end;
    else
      div_chem := 0;
    end if;

    league_chem := case when league_count >= 7 then 3 when league_count >= 5 then 1 else 0 end;

    card_chem := least(3, greatest(team_chem, div_chem, league_chem));
    chem_total := chem_total + card_chem;
  end loop;

  select avg(s) into mean_score from unnest(scores) s;
  chem_bonus := (chem_total::numeric / 21.0) * 3.0;

  select array_agg(s + chem_bonus), min(s + chem_bonus)
    into boosted, min_boosted from unnest(scores) s;

  strength := mean_score + chem_bonus
    + case when min_boosted > 85 then 0.5 when min_boosted > 78 then 0.3 else 0 end;

  wins := round(
    case
      when strength <= 40 then 0
      when strength <= 81.6 then 0 + (strength-40)/(81.6-40)*(2-0)
      when strength <= 85.6 then 2 + (strength-81.6)/(85.6-81.6)*(5-2)
      when strength <= 87.7 then 5 + (strength-85.6)/(87.7-85.6)*(6-5)
      when strength <= 89.66 then 6 + (strength-87.7)/(89.66-87.7)*(7-6)
      when strength <= 91.14 then 7 + (strength-89.66)/(91.14-89.66)*(8-7)
      when strength <= 92.16 then 8 + (strength-91.14)/(92.16-91.14)*(9-8)
      when strength <= 93.16 then 9 + (strength-92.16)/(93.16-92.16)*(10-9)
      when strength <= 93.77 then 10 + (strength-93.16)/(93.77-93.16)*(11-10)
      when strength <= 94.46 then 11 + (strength-93.77)/(94.46-93.77)*(12-11)
      else 12 end
  );
  wins := greatest(0, least(12, wins));

  reward := 20 + wins * 12
          + case when wins >= 12 then 300 when wins >= 11 then 150 when wins >= 10 then 60 else 0 end;

  perform public.utcg_ensure_wallet();
  update public.utcg_wallets
    set coins = coins + reward, matches_played = matches_played + 1,
        best_wins = greatest(best_wins, wins)
    where user_id = uid returning * into w;

  return jsonb_build_object(
    'wins', wins, 'losses', 12 - wins, 'reward', reward,
    'chem', chem_total, 'strength', round(strength, 2),
    'coins', w.coins, 'packs_opened', w.packs_opened,
    'matches_played', w.matches_played, 'best_wins', w.best_wins
  );
end $function$;

grant execute on function public.utcg_record_match(text, jsonb) to authenticated;
revoke execute on function public.utcg_record_match(text, jsonb) from anon;
notify pgrst, 'reload schema';
