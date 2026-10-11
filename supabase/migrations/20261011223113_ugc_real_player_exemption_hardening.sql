-- Security review of 20261011221629:
--  HIGH: the mask truncated to 2000 chars and the recheck only saw that head,
--  so a slur after char 2000 in a jersey DM passed. The mask now never drops
--  input, and text over 2000 chars gets no exemption at all.
--  MEDIUM: grams were built by a correlated rescan (~480 ms on 2000 chars);
--  lead() makes it a single pass.
--  Hard terms are checked on the unmasked text too, so a real player name can
--  never carry one. Jersey team/league names lose the exemption (typed by the
--  user, not players).

-- Hard slurs on the fully collapsed text: no separator, format char or
-- masking can split them.
create or replace function public.ugc_has_hard_term(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(public.ugc_fold(p_text), '[^a-z]', '', 'g')
           ~ '(nigger|nigga|faggot|tranny|wetback|hitler|neonazi)'
      or regexp_replace(public.ugc_fold(p_text), '[^a-z0-9]', '', 'g') ~ 'n1gg(er|a)';
$$;

create or replace function public.jersey_text_is_clean(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_text is null
      or (not public.ugc_has_hard_term(p_text)
          and public.ugc_normalize(p_text)
              !~ '\m(nigg(?!l)|retard|cunt)|\m(kikes?|spics?|chinks?|gooks?|coon|fags?|rape|rapists?|nazis?|nazism|kkks?)\M');
$$;

-- (mask_real_player_names body here was superseded by 20261011223223.)

create or replace function public.ugc_text_is_clean(p_text text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when public.jersey_text_is_clean(p_text) then true
    when length(p_text) > 2000 or public.ugc_has_hard_term(p_text) then false
    else public.jersey_text_is_clean(public.mask_real_player_names(p_text))
  end;
$$;

revoke execute on function public.ugc_has_hard_term(text) from public, anon;
grant execute on function public.ugc_has_hard_term(text) to authenticated;

-- Jersey team/league names are the user's own text: no player exemption.
do $$
declare
  f text;
  d text;
begin
  foreach f in array array['jersey_listings_reject_profanity_v2', 'jersey_wants_reject_profanity_v2'] loop
    select pg_get_functiondef(p.oid) into strict d
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f;
    if position('public.ugc_text_is_clean(new.team_name)' in d) = 0
       or position('public.ugc_text_is_clean(new.league_name)' in d) = 0 then
      raise exception '% does not have the expected team/league checks', f;
    end if;
    d := replace(d, 'public.ugc_text_is_clean(new.team_name)', 'public.jersey_text_is_clean(new.team_name)');
    d := replace(d, 'public.ugc_text_is_clean(new.league_name)', 'public.jersey_text_is_clean(new.league_name)');
    execute d;
  end loop;
end $$;
