-- =============================================================================
-- Row Level Security
--
-- Posture: deny everything, to everyone, by default.
--
-- This application never talks to Postgres as `anon` or `authenticated`. All
-- data access goes through Next.js Server Actions / Route Handlers and the
-- worker, which connect with the service role. RLS is therefore not the
-- application's authorisation mechanism — it is the backstop for when someone
-- picks up a leaked anon key, opens the Supabase dashboard, or wires up a
-- client-side query "just for a quick dashboard".
--
-- The service role bypasses RLS by design, which is exactly why the service
-- role key must never reach the browser. See .env.example.
-- =============================================================================

-- Enable RLS on every application table.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT LIKE 'pg_%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- No policies are created for anon or authenticated. With RLS enabled and no
-- permissive policy, every statement from those roles returns zero rows or
-- fails. That is the intended state.

-- Belt and braces: revoke the table grants Supabase hands out by default, so a
-- future migration that accidentally adds a permissive policy still does not
-- expose data.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- =============================================================================
-- Admin identity helper
--
-- Used by any policy added later that wants "is the caller a live admin?".
-- SECURITY DEFINER so it can read admin_users without the caller needing to.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.is_active_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE id = auth.uid() AND is_active = 'true'
  );
$$;

REVOKE ALL ON FUNCTION public.is_active_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_active_admin() TO authenticated;

-- =============================================================================
-- Job queue integrity
-- =============================================================================

-- One live job per unit of work.
--
-- This partial unique index is what makes duplicate-job prevention a database
-- guarantee rather than an application convention. Two workers racing to
-- enqueue "full sync of magi" produce one row and one constraint violation,
-- so a partner's shop never sees two concurrent crawls because of a scheduler
-- hiccup. Terminal jobs are excluded so the same key can be reused tomorrow.
CREATE UNIQUE INDEX sync_jobs_active_lock_key_uq
  ON public.sync_jobs (lock_key)
  WHERE status IN ('QUEUED', 'RUNNING');

-- Claim query support: workers do
--   SELECT ... FROM sync_jobs
--   WHERE status = 'QUEUED' AND next_run_at <= now()
--   ORDER BY next_run_at
--   FOR UPDATE SKIP LOCKED LIMIT 1
CREATE INDEX sync_jobs_ready_idx
  ON public.sync_jobs (next_run_at)
  WHERE status = 'QUEUED';

-- Reclaim support: find jobs whose worker died mid-run.
CREATE INDEX sync_jobs_expired_lease_idx
  ON public.sync_jobs (lease_expires_at)
  WHERE status = 'RUNNING';

-- =============================================================================
-- Listing integrity
-- =============================================================================

-- A catalog product may have at most one live listing per marketplace and
-- environment. Ended listings are excluded so a relist is possible.
CREATE UNIQUE INDEX marketplace_listings_live_uq
  ON public.marketplace_listings (catalog_product_id, marketplace_id, environment)
  WHERE status IN ('PUBLISHED', 'APPROVED');

-- =============================================================================
-- Matching integrity
-- =============================================================================

-- A supplier product may be linked to only one catalog product at a time.
-- Unmatched (soft-deleted) rows are excluded so history is preserved.
CREATE UNIQUE INDEX product_matches_active_supplier_uq
  ON public.product_matches (supplier_product_id)
  WHERE unmatched_at IS NULL;

-- =============================================================================
-- Guard rails expressed as constraints
-- =============================================================================

-- Prices are never negative. A scrape that produces -1 is a parse bug, and it
-- should fail loudly at write time rather than quietly poison a margin.
ALTER TABLE public.supplier_products
  ADD CONSTRAINT supplier_products_price_non_negative
  CHECK (price_incl_tax_jpy >= 0);

ALTER TABLE public.supplier_products
  ADD CONSTRAINT supplier_products_stock_non_negative
  CHECK (stock_qty IS NULL OR stock_qty >= 0);

-- Confidence is a probability.
ALTER TABLE public.supplier_products
  ADD CONSTRAINT supplier_products_parse_confidence_range
  CHECK (parse_confidence >= 0 AND parse_confidence <= 1);

ALTER TABLE public.supplier_product_attributes
  ADD CONSTRAINT supplier_product_attributes_confidence_range
  CHECK (confidence >= 0 AND confidence <= 1);

-- The core invariant of the Attributed type, enforced in the database so that
-- no import path can create a row claiming a value it cannot account for.
ALTER TABLE public.supplier_product_attributes
  ADD CONSTRAINT supplier_product_attributes_unknown_is_null
  CHECK (NOT (source = 'unknown' AND value IS NOT NULL));

ALTER TABLE public.supplier_product_attributes
  ADD CONSTRAINT supplier_product_attributes_null_is_zero_confidence
  CHECK (NOT (value IS NULL AND confidence <> 0));

-- eBay quantity cannot go negative, and MVP policy caps it at 1.
ALTER TABLE public.marketplace_listings
  ADD CONSTRAINT marketplace_listings_quantity_non_negative
  CHECK (quantity >= 0);

-- A published listing must have a price and a title.
ALTER TABLE public.marketplace_listings
  ADD CONSTRAINT marketplace_listings_published_is_complete
  CHECK (
    status <> 'PUBLISHED'
    OR (price_value IS NOT NULL AND price_currency IS NOT NULL AND title_en IS NOT NULL)
  );

-- eBay titles are capped at 80 characters. Enforced here so an over-long title
-- cannot be stored, let alone submitted and rejected by the API.
ALTER TABLE public.marketplace_listings
  ADD CONSTRAINT marketplace_listings_title_length
  CHECK (title_en IS NULL OR char_length(title_en) <= 80);

-- A non-ORIGINAL image cannot reach APPROVED without a human having approved
-- it. This is the database half of the image policy interlock.
ALTER TABLE public.product_images
  ADD CONSTRAINT product_images_redaction_needs_approval
  CHECK (
    processing_method = 'ORIGINAL'
    OR processing_status <> 'APPROVED'
    OR manually_approved_at IS NOT NULL
  );

ALTER TABLE public.product_images
  ADD CONSTRAINT product_images_processing_confidence_range
  CHECK (
    processing_confidence IS NULL
    OR (processing_confidence >= 0 AND processing_confidence <= 1)
  );

-- Match scores are probabilities.
ALTER TABLE public.product_matches
  ADD CONSTRAINT product_matches_score_range
  CHECK (match_score >= 0 AND match_score <= 1);

-- =============================================================================
-- updated_at maintenance
-- =============================================================================
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'updated_at'
      AND NOT a.attisdropped
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()',
      t || '_touch_updated_at', t
    );
  END LOOP;
END $$;
