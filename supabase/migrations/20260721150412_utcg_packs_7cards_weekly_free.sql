-- Exported from the remote migration ledger on 2026-10-11 (Feature Backlog #37): applied to prod but never committed to this repo.
-- Mirror packs.ts changes: all packs now yield 7 cards; free pack cadence → weekly.
-- (Keep in sync with src/lib/utcg/packs.ts.)

create or replace function public.utcg_pack_config(p_kind text)
returns table (
  size int, price int, guarantee_rank int,
  w_greatest numeric, w_elite numeric, w_star numeric, w_solidpro numeric,
  w_contributor numeric, w_leagueavg numeric, w_fringe numeric
) language sql immutable set search_path = public as $$
  select t.size, t.price, t.guarantee_rank,
         t.w_greatest, t.w_elite, t.w_star, t.w_solidpro,
         t.w_contributor, t.w_leagueavg, t.w_fringe
  from (values
    ('free',   7, 0,    2, 0.2, 1.0,  4.0,  6.0, 16.0, 30.0, 42.8),
    ('bronze', 7, 250,  2, 0.2, 1.0,  4.0,  6.0, 18.0, 34.0, 36.8),
    ('gold',   7, 750,  4, 0.5, 3.0, 10.0, 12.0, 24.0, 30.0, 20.5),
    ('elite',  7, 2000, 6, 1.5, 8.0, 22.0, 18.0, 26.0, 16.0,  8.5)
  ) as t(kind, size, price, guarantee_rank,
         w_greatest, w_elite, w_star, w_solidpro, w_contributor, w_leagueavg, w_fringe)
  where t.kind = p_kind;
$$;

-- Bump the free-pack cooldown in utcg_open_pack from 3 days → 7 days.
-- Only the cooldown_ms constant changes; the rest of the body is identical.
create or replace function public.utcg_open_pack(p_kind text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  cfg record; w public.utcg_wallets;
  now_ts timestamptz := now();
  cooldown_ms bigint := 7 * 24 * 60 * 60 * 1000;  -- weekly
  i int; rolled_rank int; wsum numeric; r numeric; picked record;
  pulls jsonb := '[]'::jsonb; got_guarantee boolean := false; is_new boolean;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into cfg from public.utcg_pack_config(p_kind);
  if cfg is null then raise exception 'unknown pack %', p_kind; end if;

  select * into w from public.utcg_wallets where user_id = uid for update;
  if w is null then
    perform public.utcg_ensure_wallet();
    select * into w from public.utcg_wallets where user_id = uid for update;
  end if;

  if p_kind = 'free' then
    if w.last_free_pack_at is not null
       and now_ts < w.last_free_pack_at + (cooldown_ms || ' milliseconds')::interval then
      raise exception 'free pack on cooldown';
    end if;
  else
    if w.coins < cfg.price then raise exception 'insufficient coins'; end if;
  end if;

  wsum := cfg.w_greatest + cfg.w_elite + cfg.w_star + cfg.w_solidpro
        + cfg.w_contributor + cfg.w_leagueavg + cfg.w_fringe;

  for i in 1..cfg.size loop
    r := random() * wsum;
    rolled_rank := case
      when r < cfg.w_greatest then 7
      when r < cfg.w_greatest + cfg.w_elite then 6
      when r < cfg.w_greatest + cfg.w_elite + cfg.w_star then 5
      when r < cfg.w_greatest + cfg.w_elite + cfg.w_star + cfg.w_solidpro then 4
      when r < cfg.w_greatest + cfg.w_elite + cfg.w_star + cfg.w_solidpro + cfg.w_contributor then 3
      when r < cfg.w_greatest + cfg.w_elite + cfg.w_star + cfg.w_solidpro + cfg.w_contributor + cfg.w_leagueavg then 2
      else 1 end;

    if i = cfg.size and not got_guarantee and rolled_rank < cfg.guarantee_rank then
      rolled_rank := cfg.guarantee_rank;
    end if;
    if rolled_rank >= cfg.guarantee_rank then got_guarantee := true; end if;

    select p.player_id, p.name, p.team_slug, p.team_abbr, p.year,
           p.player_score::numeric as player_score
      into picked
      from public.twelve_oh_players p
      where p.league = 'ufa'
        and public.utcg_tier_rank(p.player_score::numeric) = rolled_rank
      order by random() limit 1;

    if picked is null then
      select p.player_id, p.name, p.team_slug, p.team_abbr, p.year,
             p.player_score::numeric as player_score
        into picked
        from public.twelve_oh_players p
        where p.league = 'ufa'
        order by abs(public.utcg_tier_rank(p.player_score::numeric) - rolled_rank), random()
        limit 1;
    end if;

    insert into public.utcg_owned_cards (user_id, league, player_id, team_slug, year, copies)
      values (uid, 'ufa', picked.player_id, picked.team_slug, picked.year, 1)
      on conflict (user_id, league, player_id, team_slug, year)
        do update set copies = public.utcg_owned_cards.copies + 1
      returning (xmax = 0) into is_new;

    pulls := pulls || jsonb_build_object(
      'player_id', picked.player_id, 'name', picked.name,
      'team_slug', picked.team_slug, 'team_abbr', picked.team_abbr,
      'year', picked.year, 'player_score', picked.player_score,
      'tier_rank', public.utcg_tier_rank(picked.player_score),
      'is_new', is_new);
  end loop;

  if p_kind = 'free' then
    update public.utcg_wallets
      set last_free_pack_at = now_ts, packs_opened = packs_opened + 1 where user_id = uid;
  else
    update public.utcg_wallets
      set coins = coins - cfg.price, packs_opened = packs_opened + 1 where user_id = uid;
  end if;

  insert into public.utcg_pack_openings (user_id, pack_kind, coins_spent, pulls)
    values (uid, p_kind, case when p_kind='free' then 0 else cfg.price end, pulls);

  return pulls;
end $$;

grant execute on function public.utcg_open_pack(text) to authenticated;
revoke execute on function public.utcg_open_pack(text) from anon;
notify pgrst, 'reload schema';
