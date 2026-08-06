import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { customsModeEnum, profitScenarioEnum } from './enums';
import { catalogProducts } from './catalog';
import { marketplaces } from './marketplace';
import { suppliers } from './suppliers';

/**
 * Fee and cost settings.
 *
 * No rate in this file appears anywhere in the source. eBay changes its final
 * value fee schedule, promoted-listing rates move with the market, and a
 * hard-coded 13.25% becomes quietly wrong months before anyone notices the
 * margins slipping. Every calculation stores the snapshot of the profile it
 * used, so a historical decision can always be explained.
 */
export const costProfiles = pgTable(
  'cost_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    marketplaceId: uuid('marketplace_id').references(() => marketplaces.id),

    /** eBay category final value fee, percent of total amount of sale. */
    categoryFeePercent: numeric('category_fee_percent', { precision: 8, scale: 5 }).notNull(),
    /** Per-order fixed fee. */
    fixedFeePerOrder: numeric('fixed_fee_per_order', { precision: 20, scale: 6 }).notNull(),
    /** Surcharge for a buyer registered outside the seller's country. */
    internationalFeePercent: numeric('international_fee_percent', { precision: 8, scale: 5 })
      .notNull()
      .default('0'),
    /** Promoted Listings ad rate. */
    adRatePercent: numeric('ad_rate_percent', { precision: 8, scale: 5 }).notNull().default('0'),
    /** Spread charged on currency conversion of the payout. */
    fxSpreadPercent: numeric('fx_spread_percent', { precision: 8, scale: 5 })
      .notNull()
      .default('0'),
    /**
     * Extra buffer held against FX movement between listing and payout.
     * Distinct from the spread: one is a fee, this is a risk reserve.
     */
    fxBufferPercent: numeric('fx_buffer_percent', { precision: 8, scale: 5 })
      .notNull()
      .default('0'),
    /** Expected cost of returns, amortised across all sales. */
    returnReservePercent: numeric('return_reserve_percent', { precision: 8, scale: 5 })
      .notNull()
      .default('0'),
    packagingCost: numeric('packaging_cost', { precision: 20, scale: 6 }).notNull().default('0'),
    packagingCurrency: text('packaging_currency').notNull().default('JPY'),
    otherCost: numeric('other_cost', { precision: 20, scale: 6 }).notNull().default('0'),

    isActive: boolean('is_active').notNull().default(true),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('cost_profiles_active_idx').on(t.isActive, t.effectiveFrom)],
);

/**
 * International shipping rate table.
 *
 * A table rather than a carrier API call, because MVP needs a number it can
 * defend offline. Bands are matched most-specific-first.
 */
export const shippingRules = pgTable(
  'shipping_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    countryCode: text('country_code').notNull(),
    carrier: text('carrier').notNull(),
    service: text('service').notNull(),

    weightFromGrams: integer('weight_from_grams').notNull().default(0),
    weightToGrams: integer('weight_to_grams').notNull(),
    /** Item-value band, for services priced or restricted by declared value. */
    itemValueFrom: numeric('item_value_from', { precision: 20, scale: 6 }),
    itemValueTo: numeric('item_value_to', { precision: 20, scale: 6 }),

    /** What it costs us. */
    cost: numeric('cost', { precision: 20, scale: 6 }).notNull(),
    costCurrency: text('cost_currency').notNull().default('JPY'),
    /** What the buyer is charged. Differs from cost under free shipping. */
    buyerCharged: numeric('buyer_charged', { precision: 20, scale: 6 }).notNull().default('0'),
    buyerChargedCurrency: text('buyer_charged_currency').notNull().default('USD'),

    signatureOptionCost: numeric('signature_option_cost', { precision: 20, scale: 6 })
      .notNull()
      .default('0'),
    insuranceCost: numeric('insurance_cost', { precision: 20, scale: 6 }).notNull().default('0'),
    /** Fuel/remote-area surcharges the carrier adds after the fact. */
    carrierSurcharge: numeric('carrier_surcharge', { precision: 20, scale: 6 })
      .notNull()
      .default('0'),

    estimatedDays: integer('estimated_days'),
    isTracked: boolean('is_tracked').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    priority: integer('priority').notNull().default(0),
    notes: text('notes'),
  },
  (t) => [index('shipping_rules_lookup_idx').on(t.countryCode, t.isActive, t.priority)],
);

/**
 * Import duty handling per destination and price band.
 *
 * Deliberately not a single global switch. The US removed its $800 de minimis
 * exemption on 2025-08-29, so low-value US shipments now attract duty that they
 * previously did not; the EU has eBay collecting VAT at checkout under IOSS for
 * consignments under €150. Those are different modes, and a system that assumed
 * one rule for all destinations would misprice most of them.
 *
 * When the mode is CARRIER_QUOTE_REQUIRED or MANUAL_REVIEW, no duty figure is
 * invented — the item goes to a human instead.
 */
export const customsRules = pgTable(
  'customs_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    countryCode: text('country_code').notNull(),
    mode: customsModeEnum('mode').notNull(),

    /** Price band this rule applies to, in the marketplace currency. */
    itemValueFrom: numeric('item_value_from', { precision: 20, scale: 6 }).notNull().default('0'),
    itemValueTo: numeric('item_value_to', { precision: 20, scale: 6 }),

    /** Duty rate, when known. NULL under CARRIER_QUOTE_REQUIRED. */
    dutyRatePercent: numeric('duty_rate_percent', { precision: 8, scale: 5 }),
    /** Import VAT/GST rate. */
    importTaxRatePercent: numeric('import_tax_rate_percent', { precision: 8, scale: 5 }),
    /** Below this declared value, no duty applies. NULL where none exists. */
    deMinimisThreshold: numeric('de_minimis_threshold', { precision: 20, scale: 6 }),
    customsBrokerageFee: numeric('customs_brokerage_fee', { precision: 20, scale: 6 })
      .notNull()
      .default('0'),
    feeCurrency: text('fee_currency').notNull().default('JPY'),

    /** HS code used on the declaration for this class of goods. */
    hsCode: text('hs_code'),
    isActive: boolean('is_active').notNull().default(true),
    /** Where this rate came from and when it was last checked. */
    sourceNote: text('source_note'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
  },
  (t) => [index('customs_rules_lookup_idx').on(t.countryCode, t.isActive)],
);

/**
 * A computed profit result.
 *
 * Three scenarios per product per marketplace. The eligibility engine requires
 * the PESSIMISTIC one to stay positive — a listing that only makes money if the
 * yen cooperates and nothing gets returned is not a listing worth making.
 */
export const profitCalculations = pgTable(
  'profit_calculations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    catalogProductId: uuid('catalog_product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'cascade' }),
    marketplaceId: uuid('marketplace_id')
      .notNull()
      .references(() => marketplaces.id),
    /** Which shop this calculation assumes we buy from. */
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    scenario: profitScenarioEnum('scenario').notNull(),

    // Inputs
    purchasePriceJpy: numeric('purchase_price_jpy', { precision: 20, scale: 6 }).notNull(),
    domesticShippingJpy: numeric('domestic_shipping_jpy', { precision: 20, scale: 6 }).notNull(),
    supplierHandlingJpy: numeric('supplier_handling_jpy', { precision: 20, scale: 6 }).notNull(),
    sellingPrice: numeric('selling_price', { precision: 20, scale: 6 }).notNull(),
    sellingCurrency: text('selling_currency').notNull(),
    shippingChargedToBuyer: numeric('shipping_charged_to_buyer', { precision: 20, scale: 6 })
      .notNull()
      .default('0'),
    fxRate: numeric('fx_rate', { precision: 20, scale: 10 }).notNull(),

    // Cost components, each stored so the admin UI can show a full breakdown
    internationalShippingCost: numeric('international_shipping_cost', {
      precision: 20,
      scale: 6,
    }).notNull(),
    packagingCost: numeric('packaging_cost', { precision: 20, scale: 6 }).notNull(),
    categoryFee: numeric('category_fee', { precision: 20, scale: 6 }).notNull(),
    fixedFee: numeric('fixed_fee', { precision: 20, scale: 6 }).notNull(),
    internationalFee: numeric('international_fee', { precision: 20, scale: 6 }).notNull(),
    adFee: numeric('ad_fee', { precision: 20, scale: 6 }).notNull(),
    fxCost: numeric('fx_cost', { precision: 20, scale: 6 }).notNull(),
    fxBuffer: numeric('fx_buffer', { precision: 20, scale: 6 }).notNull(),
    returnReserve: numeric('return_reserve', { precision: 20, scale: 6 }).notNull(),
    insuranceCost: numeric('insurance_cost', { precision: 20, scale: 6 }).notNull(),
    signatureCost: numeric('signature_cost', { precision: 20, scale: 6 }).notNull(),
    dutyCost: numeric('duty_cost', { precision: 20, scale: 6 }).notNull(),
    importTaxCost: numeric('import_tax_cost', { precision: 20, scale: 6 }).notNull(),
    customsBrokerageFee: numeric('customs_brokerage_fee', { precision: 20, scale: 6 }).notNull(),
    carrierSurcharge: numeric('carrier_surcharge', { precision: 20, scale: 6 }).notNull(),
    otherCost: numeric('other_cost', { precision: 20, scale: 6 }).notNull(),

    // Results
    totalCost: numeric('total_cost', { precision: 20, scale: 6 }).notNull(),
    totalRevenue: numeric('total_revenue', { precision: 20, scale: 6 }).notNull(),
    profit: numeric('profit', { precision: 20, scale: 6 }).notNull(),
    profitJpy: numeric('profit_jpy', { precision: 20, scale: 6 }).notNull(),
    marginPercent: numeric('margin_percent', { precision: 8, scale: 5 }).notNull(),
    customsMode: customsModeEnum('customs_mode').notNull(),

    /**
     * Every setting that fed this number, frozen. Without it, a calculation from
     * last month cannot be explained after someone edits a fee rate.
     */
    settingsSnapshot: jsonb('settings_snapshot')
      .notNull()
      .default(sql`'{}'::jsonb`),
    warnings: jsonb('warnings')
      .notNull()
      .default(sql`'[]'::jsonb`),
    calculatedAt: timestamp('calculated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('profit_calculations_product_idx').on(t.catalogProductId, t.calculatedAt),
    index('profit_calculations_scenario_idx').on(t.scenario),
  ],
);
