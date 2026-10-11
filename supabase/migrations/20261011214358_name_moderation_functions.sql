-- Backlog #29 part 1: the DB floor for UGC text. Every term here is also
-- blocked by the client filter (src/lib/moderation.ts), so a raw DB error only
-- shows on a client bypass.

-- Lowercase, drop zero-width chars, turn every non-letter run into one space,
-- then rejoin single letters ("s.p.i.c" -> "spic").
create or replace function public.ugc_normalize(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(regexp_replace(regexp_replace(regexp_replace(p_text,
           '[­​-‏⁠﻿]', '', 'g'),
           '[^a-zA-Z]+', ' ', 'g'),
           '\m([a-zA-Z]) (?=[a-zA-Z]\M)', '\1', 'g'));
$$;

-- Slurs/hate terms, for all UGC (jersey listings + messages, fantasy chat and
-- trades, and names via name_is_clean). Adds the hate terms the client already
-- blocks: neonazi/nazism/nazi(s), kkk, hitler, wetback, gook, coon, fag, rape.
-- "neonazi" is explicit, not a "...nazi" suffix rule: Ashkenazi is a surname.
create or replace function public.jersey_text_is_clean(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_text is null
      or (lower(regexp_replace(p_text, '[^a-zA-Z]', '', 'g')) !~ '(nigger|nigga|faggot|tranny|wetback)'
          and public.ugc_normalize(p_text)
              !~ '(hitler|neonazi)|\m(nigg|retard|cunt)|\m(kikes?|spics?|chinks?|gooks?|coon|fags?|rape|rapists?|nazis?|nazism|kkks?)\M');
$$;

-- Names (profiles display_name/username, fantasy team/league/contest names):
-- the hate floor plus common profanity. Short terms match as words so real
-- names pass (Dickson, Cummings, Shitong, Hancock).
create or replace function public.name_is_clean(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_text is null
      or (public.jersey_text_is_clean(p_text)
          and public.ugc_normalize(p_text)
              !~ '(fuck|pussy|bitch|dildo|penis|bastard)|\m(shits?|shitty|shithead|cocks?|dicks?|dickhead|sluts?|cum|porn|twats?|tits|whores?|assholes?)\M');
$$;
