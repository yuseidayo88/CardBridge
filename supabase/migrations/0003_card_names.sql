-- Japanese card name -> official English name.
--
-- This table is what lets the system produce an eBay title without asking a
-- model to guess an English release name. See
-- packages/core/src/catalog/card-name-lookup.ts for the resolution rules.

CREATE TABLE IF NOT EXISTS card_names (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  name_ja      text NOT NULL,
  -- Normalised form: width folded, spaces removed. Queries match on this.
  name_key     text NOT NULL,
  name_en      text NOT NULL,

  set_code     text,
  card_number  text,

  source       text NOT NULL,
  is_verified  boolean NOT NULL DEFAULT false,
  verified_by  text,
  verified_at  timestamptz,

  note         text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS card_names_key_idx
  ON card_names (name_key, set_code, card_number);

-- The same card in the same set with the same number is one row. Set and number
-- are nullable, and NULL is not equal to NULL in a unique index, so name-only
-- rows are deduplicated by a separate partial index rather than being silently
-- allowed to duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS card_names_full_uq
  ON card_names (name_key, set_code, card_number)
  WHERE set_code IS NOT NULL AND card_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS card_names_name_only_uq
  ON card_names (name_key)
  WHERE set_code IS NULL AND card_number IS NULL;

-- An empty English name would resolve as a "hit" and produce a listing titled
-- with nothing but a grade.
ALTER TABLE card_names
  ADD CONSTRAINT card_names_en_not_blank CHECK (length(btrim(name_en)) > 0);

ALTER TABLE card_names
  ADD CONSTRAINT card_names_key_not_blank CHECK (length(btrim(name_key)) > 0);

-- Verification must be attributable: an is_verified row with nobody's name on
-- it is indistinguishable from one that was flipped by a bug.
ALTER TABLE card_names
  ADD CONSTRAINT card_names_verified_has_author
  CHECK (is_verified = false OR verified_by IS NOT NULL);

ALTER TABLE card_names ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_names FORCE ROW LEVEL SECURITY;
REVOKE ALL ON card_names FROM anon, authenticated;
