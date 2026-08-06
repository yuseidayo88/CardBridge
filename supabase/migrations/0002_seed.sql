-- =============================================================================
-- Seed data
--
-- Safe defaults only. Every value here is editable from the admin UI; nothing
-- in this file is relied upon by application code.
--
-- Fee rates below are PLACEHOLDERS marked as unverified. They are deliberately
-- pessimistic rather than accurate: an unverified rate that overstates cost
-- suppresses a marginal listing, while one that understates it publishes a
-- loss. Replace them with the seller account's actual fee schedule before
-- Phase 9.
-- =============================================================================

-- --- Suppliers ---------------------------------------------------------------
INSERT INTO public.suppliers (code, name, base_url, is_enabled, trust_score, permission_notes)
VALUES
  (
    'magi',
    'magi通販',
    'https://www.magicardshop.jp',
    true,
    50,
    'Permission obtained for: product data use, product image use, resale on eBay, automated fetching. Confirm in writing whether pre-redacted images (cert number hidden) can be supplied — see docs/design/00-proposal.md section 4.'
  ),
  (
    'cardrush',
    'カードラッシュ',
    'https://www.cardrush-pokemon.jp',
    true,
    50,
    'Permission obtained for: product data use, product image use, resale on eBay, automated fetching. Same pre-redacted image question as magi.'
  )
ON CONFLICT (code) DO NOTHING;

-- --- Supplier settings -------------------------------------------------------
-- Selectors are intentionally EMPTY. They are filled in from the structure
-- report produced by scripts/research/analyze-structure.ts once the sites can
-- actually be fetched. Guessing them from memory would be exactly the kind of
-- invented detail this project is meant to avoid.
INSERT INTO public.supplier_settings (
  supplier_id, selectors, stock_rules, category_urls,
  fetch_interval_minutes, max_pages_per_run, max_concurrency, min_request_interval_ms,
  safety_stock, domestic_shipping_fee_jpy, handling_fee_jpy, lead_time_days
)
SELECT
  s.id,
  '{}'::jsonb,
  -- Generic Japanese storefront stock vocabulary. Adapter-specific rules are
  -- layered on top once the real markup is known; these are the fallbacks.
  '[
    {"pattern": "売り切れ|完売|SOLD ?OUT|在庫切れ", "status": "OUT_OF_STOCK"},
    {"pattern": "残り\\s*(\\d+)\\s*(点|個)", "status": "IN_STOCK", "qtyGroup": 1},
    {"pattern": "在庫\\s*[:：]?\\s*(\\d+)", "status": "IN_STOCK", "qtyGroup": 1},
    {"pattern": "在庫あり|カートに入れる", "status": "IN_STOCK"}
  ]'::jsonb,
  CASE s.code
    WHEN 'magi' THEN '["https://www.magicardshop.jp/product-group/14"]'::jsonb
    WHEN 'cardrush' THEN '["https://www.cardrush-pokemon.jp/product-group/277"]'::jsonb
    ELSE '[]'::jsonb
  END,
  360,   -- full sync every 6 hours
  20,    -- page cap per run
  1,     -- one request at a time, per the partner-courtesy policy
  3000,  -- 3s between requests
  0,     -- safety stock; raise if a shop turns out to oversell
  0,     -- domestic shipping to our origin; fill in from the shop's rate card
  0,
  3
FROM public.suppliers s
WHERE s.code IN ('magi', 'cardrush')
ON CONFLICT (supplier_id) DO NOTHING;

-- --- Marketplaces ------------------------------------------------------------
-- Only EBAY_US is enabled for MVP. Additional marketplaces need their own
-- shipping rules, customs rules and cost profile before being switched on.
INSERT INTO public.marketplaces (code, name, currency, country_code, is_enabled)
VALUES
  ('EBAY_US', 'eBay United States', 'USD', 'US', true),
  ('EBAY_GB', 'eBay United Kingdom', 'GBP', 'GB', false),
  ('EBAY_AU', 'eBay Australia', 'AUD', 'AU', false),
  ('EBAY_DE', 'eBay Germany', 'EUR', 'DE', false)
ON CONFLICT (code) DO NOTHING;

-- --- Cost profile ------------------------------------------------------------
INSERT INTO public.cost_profiles (
  name, marketplace_id,
  category_fee_percent, fixed_fee_per_order, international_fee_percent,
  ad_rate_percent, fx_spread_percent, fx_buffer_percent, return_reserve_percent,
  packaging_cost, packaging_currency, other_cost, is_active, notes
)
SELECT
  'eBay US — default (UNVERIFIED)',
  m.id,
  13.25,  -- category final value fee: PLACEHOLDER, verify per category
  0.40,   -- per-order fixed fee: PLACEHOLDER
  1.65,   -- international fee: PLACEHOLDER
  2.00,   -- Promoted Listings ad rate: a business choice, not a fee
  1.50,   -- FX spread on payout conversion: PLACEHOLDER
  3.00,   -- FX risk buffer: our own reserve, not an eBay charge
  2.00,   -- return reserve: tune from actual return history
  250,    -- packaging: card saver + top loader + bubble mailer, JPY
  'JPY',
  0,
  true,
  'PLACEHOLDER RATES — every percentage here must be replaced with the figures from the actual seller account fee schedule before production listing. Verified rates should record the date checked.'
FROM public.marketplaces m
WHERE m.code = 'EBAY_US';

-- --- Customs rules -----------------------------------------------------------
-- The US removed its USD 800 de minimis exemption on 2025-08-29, so low-value
-- shipments that were previously duty-free no longer are. Rather than invent a
-- rate, the US rule is CARRIER_QUOTE_REQUIRED: the profit engine will refuse to
-- auto-list and send the item to manual review until a real quote is entered.
INSERT INTO public.customs_rules (
  country_code, mode, item_value_from, item_value_to,
  duty_rate_percent, import_tax_rate_percent, de_minimis_threshold,
  customs_brokerage_fee, fee_currency, hs_code, is_active, source_note
)
VALUES
  (
    'US', 'CARRIER_QUOTE_REQUIRED', 0, NULL,
    NULL, NULL, NULL,
    0, 'JPY', '9504.40',
    true,
    'US de minimis (USD 800) was removed effective 2025-08-29, so duty may apply at any value. No rate is assumed here: the carrier must quote it, or an admin must enter it. Verify before enabling automatic US pricing.'
  ),
  (
    'GB', 'MARKETPLACE_COLLECTED', 0, 135,
    0, 20, 135,
    0, 'JPY', '9504.40',
    true,
    'UK marketplace-facilitator rules: eBay collects VAT at checkout for consignments at or below GBP 135. UNVERIFIED — confirm the current threshold and rate.'
  ),
  (
    'GB', 'BUYER_PAID', 135, NULL,
    NULL, 20, NULL,
    0, 'JPY', '9504.40',
    true,
    'Above the GBP 135 threshold the buyer settles VAT and duty on import. UNVERIFIED.'
  ),
  (
    'DE', 'MARKETPLACE_COLLECTED', 0, 150,
    0, 19, 150,
    0, 'JPY', '9504.40',
    true,
    'EU IOSS: eBay collects VAT at checkout for consignments under EUR 150. UNVERIFIED — confirm rate per destination member state.'
  ),
  (
    'DE', 'BUYER_PAID', 150, NULL,
    NULL, 19, NULL,
    0, 'JPY', '9504.40',
    true,
    'Above EUR 150 the buyer settles import VAT and duty. UNVERIFIED.'
  ),
  (
    'AU', 'MARKETPLACE_COLLECTED', 0, 1000,
    0, 10, 1000,
    0, 'JPY', '9504.40',
    true,
    'Australian GST on low-value imported goods is collected by the marketplace. UNVERIFIED.'
  );

-- --- Application settings ----------------------------------------------------
-- The safety interlocks are seeded ON. Turning them off is a deliberate act
-- performed in the admin UI, and it additionally requires the environment
-- variables to agree — see packages/ebay/src/guard/dry-run-guard.ts.
INSERT INTO public.app_settings (key, value, description) VALUES
  ('dryRun', 'true'::jsonb,
   'Master safety switch. When true, no mutating eBay call is issued.'),
  ('allowProductionPublish', 'false'::jsonb,
   'Second interlock for production writes. Both this and DRY_RUN=false are required.'),
  ('maxPublishPerRun', '5'::jsonb,
   'Cap on publishes per job run, to bound the blast radius of a bug.'),

  ('highValueThresholdUsd', '"200"'::jsonb,
   'At or above this eBay price a listing always goes to manual review. 200 mirrors eBay''s Authenticity Guarantee threshold; Japan-based sellers are outside that programme, but it remains the point where buyer scrutiny rises.'),
  ('minProfitJpy', '"1500"'::jsonb, 'Absolute profit floor per unit, JPY.'),
  ('minProfitMarginPercent', '"15"'::jsonb, 'Profit margin floor, percent of sale price.'),

  ('minParseConfidence', '0.85'::jsonb, 'Below this, a product cannot auto-list.'),
  ('minAiConfidence', '0.85'::jsonb, 'Below this, AI copy cannot auto-list.'),
  ('minImageProcessingConfidence', '0.9'::jsonb, 'Below this, images go to manual review.'),
  ('autoMergeScoreThreshold', '0.95'::jsonb, 'At or above this, two products merge automatically.'),
  ('reviewMatchScoreThreshold', '0.75'::jsonb, 'Below this, a match is not even suggested.'),

  ('maxEbayQuantity', '1'::jsonb,
   'Hard cap on listed quantity. Held at 1 for MVP: we cannot reserve stock at a partner shop, so listing two of anything risks a cancellation.'),

  ('defaultImageProcessingMethod', '"ORIGINAL"'::jsonb,
   'Default for production. ORIGINAL because eBay forbids overlays that obscure the item and expects graded-card photos to show the grading company mark; masking the cert number sits in the untested gap between those rules.'),
  ('productionAllowedImageMethods', '["ORIGINAL","SOURCE_REDACTED"]'::jsonb,
   'Methods permitted on production listings. Redaction methods stay out until the policy question is answered in writing.'),
  ('allowRepresentativeImages', 'false'::jsonb,
   'Off. Graded singles are one-of-a-kind; eBay permits stock imagery only for new goods.'),
  ('maxMaskAreaPercent', '8'::jsonb, 'A mask larger than this is treated as a detection failure.'),

  ('shippingOriginPrefecture', '"東京都"'::jsonb, 'Origin for domestic shipping and lead times.'),
  ('shippingOriginCountry', '"JP"'::jsonb, 'Origin country.'),

  ('minSoldComparables', '3'::jsonb, 'Sold data points required before a price counts as evidence.'),
  ('marketDataMaxAgeDays', '90'::jsonb, 'Age at which market data stops counting.'),

  ('supplierFetchIntervalMinutes', '360'::jsonb, 'Default full-sync interval.'),
  ('stockCheckIntervalMinutes', '60'::jsonb, 'Default stock/price re-check interval.')
ON CONFLICT (key) DO NOTHING;
