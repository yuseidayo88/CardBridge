import { z } from 'zod';

/**
 * Application settings.
 *
 * Nothing in here is hard-coded at a call site. eBay's fee rates change, the
 * shipping origin can move, and the profit floor is a business decision that
 * belongs to whoever is running the shop — not to whoever last edited the
 * pricing module. Every value is editable from the admin UI and every profit
 * calculation stores the snapshot it used.
 */

export const appSettingsSchema = z.object({
  // --- safety interlocks ----------------------------------------------------
  /** Master switch. When true, no mutating eBay call is ever issued. */
  dryRun: z.boolean().default(true),
  /** Second interlock. Both must be off for production writes to happen. */
  allowProductionPublish: z.boolean().default(false),
  maxPublishPerRun: z.number().int().min(1).max(100).default(5),

  // --- listing eligibility thresholds --------------------------------------
  /**
   * Above this eBay price, a listing always goes to manual review.
   * Default 200 USD mirrors eBay's Authenticity Guarantee threshold: Japan-based
   * sellers are outside that programme, but it is still the price point where
   * buyer scrutiny and SNAD exposure step up.
   */
  highValueThresholdUsd: z.string().default('200'),
  /** Absolute profit floor per unit, in JPY. */
  minProfitJpy: z.string().default('1500'),
  /** Profit margin floor, as a percentage of the eBay sale price. */
  minProfitMarginPercent: z.string().default('15'),
  /** Parse confidence below this never auto-lists. */
  minParseConfidence: z.number().min(0).max(1).default(0.85),
  /** AI output confidence below this never auto-lists. */
  minAiConfidence: z.number().min(0).max(1).default(0.85),
  /** Image processing confidence below this goes to manual review. */
  minImageProcessingConfidence: z.number().min(0).max(1).default(0.9),
  /** Auto-merge two supplier products into one catalog product at/above this. */
  autoMergeScoreThreshold: z.number().min(0).max(1).default(0.95),
  /** Below this, do not even suggest a match. */
  reviewMatchScoreThreshold: z.number().min(0).max(1).default(0.75),

  // --- inventory ------------------------------------------------------------
  /** Hard cap on eBay quantity regardless of stock. Deliberately 1 for MVP. */
  maxEbayQuantity: z.number().int().min(1).max(10).default(1),

  // --- images ---------------------------------------------------------------
  /**
   * Default image handling for production listings.
   *
   * ORIGINAL is the default on purpose. eBay's picture policy forbids overlays
   * that obscure the item and requires graded-card photos to show the grading
   * company's mark; a black box over the cert number sits in the untested gap
   * between those rules. Until that is confirmed in writing, redaction is
   * opt-in and per-item approved. See docs/design/00-proposal.md §4.
   */
  defaultImageProcessingMethod: z
    .enum(['ORIGINAL', 'SOURCE_REDACTED', 'BLACK_MASK', 'BLUR', 'CROP', 'MANUAL_REVIEW'])
    .default('ORIGINAL'),
  /** Redaction methods usable in production. Empty = none, review only. */
  productionAllowedImageMethods: z
    .array(z.enum(['ORIGINAL', 'SOURCE_REDACTED', 'BLACK_MASK', 'BLUR', 'CROP']))
    .default(['ORIGINAL', 'SOURCE_REDACTED']),
  /**
   * Representative images: one photo standing in for any of several identical
   * graded copies. Off by default — graded singles are one-of-a-kind items and
   * eBay allows stock imagery only for new goods.
   */
  allowRepresentativeImages: z.boolean().default(false),
  /** A mask covering more of the frame than this is treated as a failure. */
  maxMaskAreaPercent: z.number().min(0).max(100).default(8),

  // --- shipping origin ------------------------------------------------------
  /** Domestic shipping and lead times are computed from here. */
  shippingOriginPrefecture: z.string().default('東京都'),
  shippingOriginCountry: z.string().default('JP'),

  // --- market data ----------------------------------------------------------
  /** Minimum comparable sales before a price is considered evidence-based. */
  minSoldComparables: z.number().int().min(0).default(3),
  /** How old sold data may be before it stops counting. */
  marketDataMaxAgeDays: z.number().int().min(1).default(90),

  // --- fetching -------------------------------------------------------------
  supplierFetchIntervalMinutes: z.number().int().min(5).default(360),
  stockCheckIntervalMinutes: z.number().int().min(5).default(60),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = appSettingsSchema.parse({});

/**
 * Environment overrides for the safety interlocks only.
 *
 * Thresholds live in the database so an admin can tune them; the interlocks
 * additionally read the environment, so a misconfigured database row can never
 * be the only thing standing between a test run and production.
 */
export function readSafetyInterlocksFromEnv(env: NodeJS.ProcessEnv = process.env): {
  dryRun: boolean;
  allowProductionPublish: boolean;
  maxPublishPerRun: number;
} {
  return {
    // Anything other than an explicit "false" leaves dry run on.
    dryRun: env.DRY_RUN !== 'false',
    allowProductionPublish: env.ALLOW_PRODUCTION_PUBLISH === 'true',
    maxPublishPerRun: Number(env.MAX_PUBLISH_PER_RUN ?? '5'),
  };
}
