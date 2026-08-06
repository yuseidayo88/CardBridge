import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { cardLanguageEnum, gradingCompanyEnum, matchMethodEnum } from './enums';
import { supplierProducts } from './suppliers';

/**
 * The identity of a physical card, with no price and no stock attached.
 *
 * One catalog_product may have several supplier_products behind it (the same
 * PSA 10 Charizard offered by two shops), and exactly one eBay listing in front
 * of it. That is the shape the whole system is organised around.
 */
export const catalogProducts = pgTable(
  'catalog_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    cardNameJa: text('card_name_ja').notNull(),
    cardNameEn: text('card_name_en'),
    cardNumber: text('card_number'),
    setCode: text('set_code'),
    setName: text('set_name'),
    rarity: text('rarity'),
    /** NULL when unknown. Never inferred — a wrong year breaks eBay search. */
    releaseYear: numeric('release_year', { precision: 4, scale: 0 }),
    language: cardLanguageEnum('language').notNull(),
    gradingCompany: gradingCompanyEnum('grading_company').notNull(),
    grade: numeric('grade', { precision: 3, scale: 1 }).notNull(),

    /** Deterministic identity string used for blocking during matching. */
    matchKey: text('match_key').notNull(),
    /**
     * An admin has eyeballed this identity. Required before a high-value item
     * can be published, because an identity error on a $500 card is expensive.
     */
    isVerified: boolean('is_verified').notNull().default(false),
    verifiedBy: text('verified_by'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('catalog_products_match_key_idx').on(t.matchKey),
    // The blocking index for candidate generation: narrow on the cheap
    // structural fields first, then score the survivors.
    index('catalog_products_blocking_idx').on(t.cardNumber, t.language, t.gradingCompany, t.grade),
  ],
);

/**
 * The link between a shop's offer and a card identity.
 *
 * Unmatching is a soft delete (`unmatched_at`) rather than a row deletion so
 * that a mistaken auto-merge that an admin undoes leaves a trace — otherwise
 * the same bad merge silently happens again on the next sync.
 */
export const productMatches = pgTable(
  'product_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    catalogProductId: uuid('catalog_product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'cascade' }),
    supplierProductId: uuid('supplier_product_id')
      .notNull()
      .references(() => supplierProducts.id, { onDelete: 'cascade' }),

    matchScore: numeric('match_score', { precision: 5, scale: 4 }).notNull(),
    matchMethod: matchMethodEnum('match_method').notNull(),
    /** Per-signal breakdown, so a reviewer can see why it scored what it did. */
    matchSignals: jsonb('match_signals')
      .notNull()
      .default(sql`'{}'::jsonb`),

    matchedBy: text('matched_by'),
    matchedAt: timestamp('matched_at', { withTimezone: true }).notNull().defaultNow(),
    unmatchedAt: timestamp('unmatched_at', { withTimezone: true }),
    unmatchedBy: text('unmatched_by'),
    unmatchReason: text('unmatch_reason'),
  },
  (t) => [
    index('product_matches_catalog_idx').on(t.catalogProductId),
    index('product_matches_supplier_product_idx').on(t.supplierProductId),
  ],
);

/**
 * Suggested merges awaiting a human.
 *
 * Kept separate from product_matches: a suggestion is not a link, and mixing
 * them would mean a scoring change could accidentally activate pending
 * suggestions as live matches.
 */
export const matchCandidates = pgTable(
  'match_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierProductId: uuid('supplier_product_id')
      .notNull()
      .references(() => supplierProducts.id, { onDelete: 'cascade' }),
    catalogProductId: uuid('catalog_product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'cascade' }),
    score: numeric('score', { precision: 5, scale: 4 }).notNull(),
    signals: jsonb('signals')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Reasons the pair can never be auto-merged, e.g. conflicting set codes. */
    blockers: jsonb('blockers')
      .notNull()
      .default(sql`'[]'::jsonb`),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
    resolution: text('resolution'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('match_candidates_uq').on(t.supplierProductId, t.catalogProductId),
    index('match_candidates_unresolved_idx').on(t.resolvedAt),
  ],
);

export const catalogProductsRelations = relations(catalogProducts, ({ many }) => ({
  matches: many(productMatches),
  candidates: many(matchCandidates),
}));

export const productMatchesRelations = relations(productMatches, ({ one }) => ({
  catalogProduct: one(catalogProducts, {
    fields: [productMatches.catalogProductId],
    references: [catalogProducts.id],
  }),
  supplierProduct: one(supplierProducts, {
    fields: [productMatches.supplierProductId],
    references: [supplierProducts.id],
  }),
}));
