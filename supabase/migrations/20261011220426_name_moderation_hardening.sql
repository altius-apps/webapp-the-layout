-- Security review of 20261011214358:
--  - "neonazi"/"hitler" moved to the fully collapsed clause: a format char like
--    U+202E or U+034F inside the word used to split it and pass.
--  - Accents and fullwidth forms fold to ASCII first (NFKD, marks dropped), so
--    "nígger"/"cúnt" hit; "n1gger"/"n1gga" checked with digits kept.
--  - "niggle"/"niggling" no longer hit the nigg prefix; "Peniston" passes.

-- Lowercased, accents and zero-width/format chars removed.
create or replace function public.ugc_fold(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(regexp_replace(normalize(p_text, nfkd),
           '[̀-ͯ­͏​-‏‪-‮⁠-⁤︀-️﻿]', '', 'g'));
$$;

-- ugc_fold, then every non-letter run to one space and single letters rejoined.
create or replace function public.ugc_normalize(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(regexp_replace(public.ugc_fold(p_text),
           '[^a-z]+', ' ', 'g'),
           '\m([a-z]) (?=[a-z]\M)', '\1', 'g');
$$;

create or replace function public.jersey_text_is_clean(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_text is null
      or (regexp_replace(public.ugc_fold(p_text), '[^a-z]', '', 'g')
            !~ '(nigger|nigga|faggot|tranny|wetback|hitler|neonazi)'
          and regexp_replace(public.ugc_fold(p_text), '[^a-z0-9]', '', 'g') !~ 'n1gg(er|a)'
          and public.ugc_normalize(p_text)
              !~ '\m(nigg(?!l)|retard|cunt)|\m(kikes?|spics?|chinks?|gooks?|coon|fags?|rape|rapists?|nazis?|nazism|kkks?)\M');
$$;

create or replace function public.name_is_clean(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_text is null
      or (public.jersey_text_is_clean(p_text)
          and public.ugc_normalize(p_text)
              !~ '(fuck|pussy|bitch|dildo|penis(?!ton)|bastard)|\m(shits?|shitty|shithead|cocks?|dicks?|dickhead|sluts?|cum|porn|twats?|tits|whores?|assholes?)\M');
$$;

-- Nothing anonymous calls these; jersey_text_is_clean still had an anon grant
-- that now dead-ends on the helpers.
revoke execute on function public.jersey_text_is_clean(text) from anon;
revoke execute on function public.ugc_fold(text) from anon;
