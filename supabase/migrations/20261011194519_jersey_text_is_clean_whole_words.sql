-- The letters-only collapse matched short terms across word boundaries and
-- inside real names: "Cody Spicer", "Charles Pick" ("charlespick"), "Max
-- Knigge" (nigg). Long unambiguous terms stay collapsed-substring (catches
-- "n.i.g.g.e.r"); short ones now match as words. Same terms as before.
create or replace function public.jersey_text_is_clean(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_text is null
      or (lower(regexp_replace(p_text, '[^a-zA-Z]', '', 'g')) !~ '(nigger|nigga|faggot|tranny)'
          and lower(p_text) !~ '\m(nigg|retard|cunt)|\m(kikes?|spics?|chinks?|rapists?)\M');
$$;
