import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Shared enums.
 *
 * These are Postgres enums rather than check constraints or free text so that
 * an invalid state cannot be written by any client — including psql, a Supabase
 * dashboard edit, or a future service that does not go through this codebase.
 */

export const stockStatusEnum = pgEnum('stock_status', ['IN_STOCK', 'OUT_OF_STOCK', 'UNKNOWN']);

export const gradingCompanyEnum = pgEnum('grading_company', [
  'PSA',
  'BGS',
  'CGC',
  'SGC',
  'ARS',
  'OTHER',
]);

export const cardLanguageEnum = pgEnum('card_language', [
  'JAPANESE',
  'ENGLISH',
  'CHINESE',
  'KOREAN',
  'OTHER',
]);

export const psaVerdictEnum = pgEnum('psa_verdict', ['CONFIRMED', 'REVIEW', 'REJECTED']);

export const attributeSourceEnum = pgEnum('attribute_source', [
  'structured_data',
  'supplier_rule',
  'title_parser',
  'catalog_lookup',
  'manual',
  'ai_extraction',
  'ai_inference',
  'unknown',
]);

export const matchMethodEnum = pgEnum('match_method', ['AUTO', 'MANUAL']);

export const imageProcessingMethodEnum = pgEnum('image_processing_method', [
  'ORIGINAL',
  'SOURCE_REDACTED',
  'BLACK_MASK',
  'BLUR',
  'CROP',
  'MANUAL_REVIEW',
]);

export const imageProcessingStatusEnum = pgEnum('image_processing_status', [
  'PENDING',
  'PROCESSING',
  'READY',
  'NEEDS_REVIEW',
  'APPROVED',
  'FAILED',
]);

export const imageFaceEnum = pgEnum('image_face', ['FRONT', 'BACK', 'OTHER']);

export const listingStatusEnum = pgEnum('listing_status', [
  'DRAFT',
  'READY_FOR_REVIEW',
  'APPROVED',
  'PUBLISHED',
  'OUT_OF_STOCK',
  'ENDED',
  'ERROR',
]);

export const ebayEnvironmentEnum = pgEnum('ebay_environment', ['SANDBOX', 'PRODUCTION']);

/**
 * How import duty is handled for a given destination.
 *
 * MARKETPLACE_COLLECTED is not a theoretical case: eBay collects VAT at
 * checkout for EU consignments under €150 via IOSS, and for the UK/AU/NZ under
 * equivalent marketplace-facilitator rules. Treating every destination as
 * "buyer pays at the door" would systematically misprice those markets.
 *
 * CARRIER_QUOTE_REQUIRED and MANUAL_REVIEW exist so the system can say "I do
 * not know" instead of inventing a duty rate.
 */
export const customsModeEnum = pgEnum('customs_mode', [
  'BUYER_PAID',
  'SELLER_PAID',
  'MARKETPLACE_COLLECTED',
  'CARRIER_QUOTE_REQUIRED',
  'MANUAL_REVIEW',
]);

export const profitScenarioEnum = pgEnum('profit_scenario', ['OPTIMISTIC', 'BASE', 'PESSIMISTIC']);

export const syncJobTypeEnum = pgEnum('sync_job_type', [
  'SUPPLIER_FULL_SYNC',
  'SUPPLIER_STOCK_CHECK',
  'SUPPLIER_PRICE_CHECK',
  'IMAGE_PROCESSING',
  'AI_GENERATION',
  'MARKET_PRICE_REFRESH',
  'EBAY_LISTING_SYNC',
  'EBAY_METADATA_REFRESH',
]);

export const syncJobStatusEnum = pgEnum('sync_job_status', [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

export const logLevelEnum = pgEnum('log_level', ['DEBUG', 'INFO', 'WARN', 'ERROR']);
