import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { ebayEnvironmentEnum, listingStatusEnum } from './enums';
import { catalogProducts } from './catalog';

export const marketplaces = pgTable('marketplaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** e.g. EBAY_US. Matches eBay's marketplace IDs. */
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  currency: text('currency').notNull(),
  countryCode: text('country_code').notNull(),
  isEnabled: boolean('is_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const marketplaceListings = pgTable(
  'marketplace_listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    catalogProductId: uuid('catalog_product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'cascade' }),
    marketplaceId: uuid('marketplace_id')
      .notNull()
      .references(() => marketplaces.id),
    environment: ebayEnvironmentEnum('environment').notNull().default('SANDBOX'),

    /** Our SKU. Deterministic — see core/listing/sku.ts. */
    sku: text('sku').notNull(),
    ebayOfferId: text('ebay_offer_id'),
    ebayListingId: text('ebay_listing_id'),

    status: listingStatusEnum('status').notNull().default('DRAFT'),
    priceValue: numeric('price_value', { precision: 20, scale: 6 }),
    priceCurrency: text('price_currency'),
    quantity: integer('quantity').notNull().default(0),

    titleEn: text('title_en'),
    descriptionEn: text('description_en'),
    itemSpecifics: jsonb('item_specifics')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Exact payload last sent (or that would be sent, in dry run). */
    ebayPayload: jsonb('ebay_payload'),
    /** Hash of the payload an admin approved, so edits invalidate approval. */
    approvedPayloadHash: text('approved_payload_hash'),

    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),

    /** Blocking reasons from the eligibility engine, shown in the admin UI. */
    eligibilityBlockers: jsonb('eligibility_blockers')
      .notNull()
      .default(sql`'[]'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One SKU per marketplace per environment. This is the constraint that
    // makes accidental duplicate listings impossible rather than merely
    // unlikely.
    unique('marketplace_listings_sku_uq').on(t.marketplaceId, t.environment, t.sku),
    unique('marketplace_listings_product_uq').on(
      t.catalogProductId,
      t.marketplaceId,
      t.environment,
    ),
    index('marketplace_listings_status_idx').on(t.status),
  ],
);

/**
 * Cached eBay Metadata API responses.
 *
 * Condition descriptor IDs (27501 Professional Grader, 27502 Grade, 27503
 * Certification Number) and their permitted values are fetched from
 * getItemConditionPolicies rather than hard-coded, because eBay revises these
 * and a stale literal produces listings that are silently wrong about what
 * grade they are advertising.
 */
export const ebayConditionPolicies = pgTable(
  'ebay_condition_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    marketplaceCode: text('marketplace_code').notNull(),
    categoryId: text('category_id').notNull(),
    environment: ebayEnvironmentEnum('environment').notNull(),
    payload: jsonb('payload').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('ebay_condition_policies_uq').on(t.marketplaceCode, t.categoryId, t.environment)],
);

/** Cached getItemAspectsForCategory — which Item Specifics are required. */
export const ebayAspectPolicies = pgTable(
  'ebay_aspect_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    marketplaceCode: text('marketplace_code').notNull(),
    categoryId: text('category_id').notNull(),
    environment: ebayEnvironmentEnum('environment').notNull(),
    payload: jsonb('payload').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('ebay_aspect_policies_uq').on(t.marketplaceCode, t.categoryId, t.environment)],
);

/**
 * eBay OAuth tokens.
 *
 * Stored encrypted with AES-256-GCM (key from TOKEN_ENCRYPTION_KEY, which never
 * goes near the database). A Supabase service-role leak alone therefore does
 * not hand an attacker the ability to list or end items on the seller account.
 */
export const ebayCredentials = pgTable(
  'ebay_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    account: text('account').notNull(),
    environment: ebayEnvironmentEnum('environment').notNull(),
    refreshTokenEnc: text('refresh_token_enc').notNull(),
    accessTokenEnc: text('access_token_enc'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scopes: jsonb('scopes')
      .notNull()
      .default(sql`'[]'::jsonb`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('ebay_credentials_uq').on(t.account, t.environment)],
);

/**
 * Observed eBay market prices.
 *
 * `isSufficient` is the important column. The Marketplace Insights API (sold
 * data) is a Limited Release that is not open to new applicants, and the old
 * findCompletedItems was retired in February 2025, so sold comparables often
 * come from an admin reading Terapeak by hand. When there is not enough data,
 * this flag is false and the eligibility engine refuses to auto-list rather
 * than pricing against active asks alone.
 */
export const marketPrices = pgTable(
  'market_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    catalogProductId: uuid('catalog_product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'cascade' }),
    marketplaceId: uuid('marketplace_id')
      .notNull()
      .references(() => marketplaces.id),

    /** BROWSE_API | MANUAL_ENTRY | MARKETPLACE_INSIGHTS */
    source: text('source').notNull(),
    currency: text('currency').notNull(),

    soldMedian: numeric('sold_median', { precision: 20, scale: 6 }),
    soldMin: numeric('sold_min', { precision: 20, scale: 6 }),
    soldMax: numeric('sold_max', { precision: 20, scale: 6 }),
    soldCount: integer('sold_count'),
    /** Median including shipping — the number a buyer actually compares. */
    soldMedianWithShipping: numeric('sold_median_with_shipping', {
      precision: 20,
      scale: 6,
    }),

    activeMin: numeric('active_min', { precision: 20, scale: 6 }),
    activeMedian: numeric('active_median', { precision: 20, scale: 6 }),
    /** The spread matters: a wide gap between min and max means the "median"
     *  is describing several different cards that happen to share a name. */
    activeMax: numeric('active_max', { precision: 20, scale: 6 }),
    activeCount: integer('active_count'),

    sampleWindowDays: integer('sample_window_days'),
    outliersExcluded: integer('outliers_excluded'),
    isSufficient: boolean('is_sufficient').notNull().default(false),
    notes: text('notes'),
    enteredBy: text('entered_by'),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('market_prices_product_idx').on(t.catalogProductId, t.collectedAt),
    index('market_prices_sufficient_idx').on(t.isSufficient),
  ],
);

export const marketplaceListingsRelations = relations(marketplaceListings, ({ one }) => ({
  catalogProduct: one(catalogProducts, {
    fields: [marketplaceListings.catalogProductId],
    references: [catalogProducts.id],
  }),
  marketplace: one(marketplaces, {
    fields: [marketplaceListings.marketplaceId],
    references: [marketplaces.id],
  }),
}));
