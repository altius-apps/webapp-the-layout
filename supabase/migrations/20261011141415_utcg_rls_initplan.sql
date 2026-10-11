-- Feature Backlog #25 (2026-10-11): the 15 UTCG select policies called
-- auth.uid() bare, so Postgres re-evaluated it for every row (advisor
-- auth_rls_initplan). Wrapping it in a subselect makes it one initplan per
-- query. Same logic, same roles; only the auth.uid() calls change.
alter policy utcg_card_evolutions_select_own on public.utcg_card_evolutions using ((select auth.uid()) = user_id);
alter policy utcg_draft_runs_select_own on public.utcg_draft_runs using ((select auth.uid()) = user_id);
alter policy utcg_flash_claims_select_own on public.utcg_flash_claims using ((select auth.uid()) = user_id);
alter policy utcg_listings_select on public.utcg_listings using ((status = 'active'::text) or (seller_id = (select auth.uid())));
alter policy utcg_milestone_claims_select_own on public.utcg_milestone_claims using ((select auth.uid()) = user_id);
alter policy utcg_objective_progress_select_own on public.utcg_objective_progress using ((select auth.uid()) = user_id);
alter policy utcg_pvp_matches_select_participant on public.utcg_pvp_matches using ((challenger_id = (select auth.uid())) or (defender_id = (select auth.uid())));
alter policy utcg_pvp_squads_select_own on public.utcg_pvp_squads using (user_id = (select auth.uid()));
alter policy utcg_reward_packs_select_own on public.utcg_reward_packs using ((select auth.uid()) = user_id);
alter policy utcg_rivals_weeks_select_own on public.utcg_rivals_weeks using ((select auth.uid()) = user_id);
alter policy utcg_sbc_submissions_select_own on public.utcg_sbc_submissions using ((select auth.uid()) = user_id);
alter policy utcg_season_progress_select_own on public.utcg_season_progress using ((select auth.uid()) = user_id);
alter policy utcg_trade_offer_cards_select on public.utcg_trade_offer_cards using (
  exists (
    select 1
      from public.utcg_trade_offers o
      join public.utcg_listings l on l.id = o.listing_id
     where o.id = utcg_trade_offer_cards.offer_id
       and (o.offerer_id = (select auth.uid()) or l.seller_id = (select auth.uid()))
  )
);
alter policy utcg_trade_offers_select on public.utcg_trade_offers using (
  (offerer_id = (select auth.uid()))
  or exists (
    select 1 from public.utcg_listings l
     where l.id = utcg_trade_offers.listing_id and l.seller_id = (select auth.uid())
  )
);
alter policy utcg_weekly_results_select_own on public.utcg_weekly_results using ((select auth.uid()) = user_id);
