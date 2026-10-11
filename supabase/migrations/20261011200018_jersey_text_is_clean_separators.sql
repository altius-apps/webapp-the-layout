-- Follow-up to 20261011194519 (security review): the word match let separated
-- or affixed forms through ("s.p.i.c", "spic123", "xX_spic_Xx", zero-width
-- chars). Strip invisible chars, turn every non-letter run into one space,
-- then rejoin single letters ("s p i c" -> "spic") before the word match.
create or replace function public.jersey_text_is_clean(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_text is null
      or (lower(regexp_replace(p_text, '[^a-zA-Z]', '', 'g')) !~ '(nigger|nigga|faggot|tranny)'
          and lower(regexp_replace(regexp_replace(regexp_replace(p_text,
                '[­​-‏⁠﻿]', '', 'g'),
                '[^a-zA-Z]+', ' ', 'g'),
                '\m([a-zA-Z]) (?=[a-zA-Z]\M)', '\1', 'g'))
              !~ '\m(nigg|retard|cunt)|\m(kikes?|spics?|chinks?|rapists?)\M');
$$;
