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
import { attributeSourceEnum, psaVerdictEnum, stockStatusEnum } from './enums';

export const suppliers = pgTable('suppliers', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  isEnabled: boolean('is_enabled').notNull().default(true),
  /** Admin-tunable tiebreaker when two shops offer the same card at one price. */
  trustScore: numeric('trust_score', { precision: 5, scale: 2 }).notNull().default('50'),
  /**
   * Free-text record of what this partner has actually agreed to — image reuse,
   * automated fetching, resale on eBay. Kept next to the data it governs so
   * nobody has to go hunting through email to answer "are we allowed to?".
   */
  permissionNotes: text('permission_notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Everything shop-specific that could change without a code deploy.
 *
 * The selectors and stock rules live here as JSONB rather than in TypeScript so
 * that when a partner reskins their site, the fix is a row update — not a
 * release. That is the whole point of the adapter split.
 */
export const supplierSettings = pgTable('supplier_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  supplierId: uuid('supplier_id')
    .notNull()
    .references(() => suppliers.id, { onDelete: 'cascade' })
    .unique(),

  /** CSS selectors, URL templates, pagination config. See adapters/base. */
  selectors: jsonb('selectors')
    .notNull()
    .default(sql`'{}'::jsonb`),
  /** Ordered rules mapping on-page stock text to a StockStatus + quantity. */
  stockRules: jsonb('stock_rules')
    .notNull()
    .default(sql`'[]'::jsonb`),
  /** Category URLs to crawl, already normalised. */
  categoryUrls: jsonb('category_urls')
    .notNull()
    .default(sql`'[]'::jsonb`),

  fetchIntervalMinutes: integer('fetch_interval_minutes').notNull().default(360),
  maxPagesPerRun: integer('max_pages_per_run').notNull().default(20),
  maxConcurrency: integer('max_concurrency').notNull().default(1),
  minRequestIntervalMs: integer('min_request_interval_ms').notNull().default(3000),

  /**
   * Stock held back from eBay. A shop that says "1 left" may already have sold
   * it to a walk-in customer; safety stock is how we avoid selling what we
   * cannot buy.
   */
  safetyStock: integer('safety_stock').notNull().default(0),
  /** Shop -> our shipping origin, in JPY. Part of true landed cost. */
  domesticShippingFeeJpy: numeric('domestic_shipping_fee_jpy', { precision: 20, scale: 6 })
    .notNull()
    .default('0'),
  handlingFeeJpy: numeric('handling_fee_jpy', { precision: 20, scale: 6 }).notNull().default('0'),
  leadTimeDays: integer('lead_time_days').notNull().default(3),
  /** 0..1. Historical rate at which orders from this shop actually ship. */
  reliabilityScore: numeric('reliability_score', { precision: 5, scale: 4 }).notNull().default('1'),

  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastSyncError: text('last_sync_error'),
  adapterHealthy: boolean('adapter_healthy').notNull().default(true),
  adapterHealthCheckedAt: timestamp('adapter_health_checked_at', { withTimezone: true }),
  adapterHealthDetail: jsonb('adapter_health_detail'),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const supplierProducts = pgTable(
  'supplier_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    /**
     * The shop's own identifier. Never a slug and never derived from the title:
     * a shop that renames "リザードンex" to "リザードン ex" must not create a
     * second row and orphan the price history of the first.
     */
    sourceProductId: text('source_product_id').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    rawTitle: text('raw_title').notNull(),

    priceInclTaxJpy: numeric('price_incl_tax_jpy', { precision: 20, scale: 6 }).notNull(),
    /** NULL means the shop does not publish a count, only in/out of stock. */
    stockQty: integer('stock_qty'),
    stockStatus: stockStatusEnum('stock_status').notNull(),

    psaVerdict: psaVerdictEnum('psa_verdict').notNull().default('REVIEW'),
    psaEvidence: jsonb('psa_evidence')
      .notNull()
      .default(sql`'[]'::jsonb`),

    /** Verbatim scrape output, so re-parsing never needs another HTTP request. */
    rawPayload: jsonb('raw_payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    parseWarnings: jsonb('parse_warnings')
      .notNull()
      .default(sql`'[]'::jsonb`),
    parseConfidence: numeric('parse_confidence', { precision: 5, scale: 4 }).notNull().default('0'),

    /** Hash of meaningful content — drives "has anything actually changed?". */
    contentHash: text('content_hash').notNull(),
    /** Conditional-GET tokens, so an unchanged page costs one 304. */
    etag: text('etag'),
    lastModified: text('last_modified'),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the product disappears from the shop; rows are never deleted. */
    disappearedAt: timestamp('disappeared_at', { withTimezone: true }),
  },
  (t) => [
    unique('supplier_products_supplier_source_uq').on(t.supplierId, t.sourceProductId),
    index('supplier_products_supplier_idx').on(t.supplierId),
    index('supplier_products_stock_idx').on(t.stockStatus),
    index('supplier_products_verdict_idx').on(t.psaVerdict),
    index('supplier_products_last_checked_idx').on(t.lastCheckedAt),
  ],
);

/**
 * Parsed card attributes, one row per field.
 *
 * A wide table with `card_number`, `card_number_source`, `card_number_confidence`
 * columns would work, but it makes adding a field a migration and makes
 * "show me every value the AI guessed" a 30-column query. One row per attribute
 * keeps provenance queryable.
 */
export const supplierProductAttributes = pgTable(
  'supplier_product_attributes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierProductId: uuid('supplier_product_id')
      .notNull()
      .references(() => supplierProducts.id, { onDelete: 'cascade' }),
    /** e.g. cardNameJa, cardNumber, setCode, releaseYear, grade. */
    field: text('field').notNull(),
    /** NULL is meaningful: it means "not determined", never "empty string". */
    value: text('value'),
    source: attributeSourceEnum('source').notNull(),
    confidence: numeric('confidence', { precision: 5, scale: 4 }).notNull(),
    note: text('note'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('supplier_product_attributes_uq').on(t.supplierProductId, t.field),
    index('supplier_product_attributes_field_idx').on(t.field),
  ],
);

/** Append-only. Never updated, so a price can always be reconstructed. */
export const priceHistory = pgTable(
  'price_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierProductId: uuid('supplier_product_id')
      .notNull()
      .references(() => supplierProducts.id, { onDelete: 'cascade' }),
    priceInclTaxJpy: numeric('price_incl_tax_jpy', { precision: 20, scale: 6 }).notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('price_history_product_time_idx').on(t.supplierProductId, t.observedAt)],
);

export const stockHistory = pgTable(
  'stock_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierProductId: uuid('supplier_product_id')
      .notNull()
      .references(() => supplierProducts.id, { onDelete: 'cascade' }),
    stockQty: integer('stock_qty'),
    stockStatus: stockStatusEnum('stock_status').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('stock_history_product_time_idx').on(t.supplierProductId, t.observedAt)],
);

export const suppliersRelations = relations(suppliers, ({ one, many }) => ({
  settings: one(supplierSettings, {
    fields: [suppliers.id],
    references: [supplierSettings.supplierId],
  }),
  products: many(supplierProducts),
}));

export const supplierProductsRelations = relations(supplierProducts, ({ one, many }) => ({
  supplier: one(suppliers, {
    fields: [supplierProducts.supplierId],
    references: [suppliers.id],
  }),
  attributes: many(supplierProductAttributes),
  priceHistory: many(priceHistory),
  stockHistory: many(stockHistory),
}));
