-- The searchable form of listings, shops and suggested terms. Written by hand, because drizzle's
-- schema builder cannot express these functions, and so that ordinary reads do not load the vectors.

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
--> statement-breakpoint

-- The one definition of folding, for listings and queries alike: no accents, no case, no punctuation,
-- and letters apart from digits, so "Liepāja" meets "Liepaja" and "iPhone13" meets "iPhone 13".
-- unaccent is only STABLE because its dictionary could be changed. This one is fixed, so a generated
-- column may use it.
CREATE FUNCTION agentshelf_fold(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN regexp_replace(
    regexp_replace(
      regexp_replace(
        lower(public.unaccent('public.unaccent'::regdictionary, value)),
        '[[:punct:]]+', ' ', 'g'
      ),
      '([[:alpha:]])([[:digit:]])', '\1 \2', 'g'
    ),
    '([[:digit:]])([[:alpha:]])', '\1 \2', 'g'
  );
--> statement-breakpoint

CREATE FUNCTION agentshelf_terms_vector(terms text[], place_terms text[]) RETURNS tsvector
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN setweight(to_tsvector('simple'::regconfig, agentshelf_fold(array_to_string(terms, ' '))), 'C')
    || setweight(to_tsvector('simple'::regconfig, agentshelf_fold(array_to_string(place_terms, ' '))), 'D');
--> statement-breakpoint

-- Weights say where a word came from: A title, B description, C terms or shop name, D place.
ALTER TABLE "products" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple'::regconfig, agentshelf_fold("title")), 'A')
  || setweight(
    to_tsvector('simple'::regconfig, agentshelf_fold("description" || ' ' || coalesce("description_lv", ''))),
    'B'
  )
) STORED;
--> statement-breakpoint

ALTER TABLE "shops" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple'::regconfig, agentshelf_fold("name")), 'C')
  || setweight(to_tsvector('simple'::regconfig, agentshelf_fold(coalesce("location", ''))), 'D')
) STORED;
--> statement-breakpoint

ALTER TABLE "product_search_terms" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (agentshelf_terms_vector("terms", "place_terms")) STORED;
