import { z } from 'zod';

/**
 * The schema for everything shop-specific.
 *
 * This is the file that decides whether adding a third supplier is a code
 * change or a database row. Selectors, pagination style, stock vocabulary and
 * ID extraction all live in a validated JSON document stored in
 * supplier_settings — so when a partner reskins their storefront, the fix is an
 * edit in the admin UI, not a release.
 *
 * It is validated with Zod on load rather than trusted, because a malformed
 * selector config would otherwise fail deep inside a crawl with an unhelpful
 * error, halfway through a run.
 */

export const paginationConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('query'),
    /** e.g. "page" for ?page=2 */
    param: z.string(),
    start: z.number().int().default(1),
    step: z.number().int().default(1),
  }),
  z.object({
    type: z.literal('path'),
    /** e.g. "/product-group/14/page/{n}" */
    template: z.string().includes('{n}'),
    start: z.number().int().default(1),
    step: z.number().int().default(1),
  }),
  z.object({
    type: z.literal('link'),
    /** Selector for the "next page" anchor. */
    nextSelector: z.string(),
  }),
  z.object({ type: z.literal('none') }),
]);
export type PaginationConfig = z.infer<typeof paginationConfigSchema>;

/**
 * How to read a value out of the page.
 *
 * `attr` and `regex` exist because the useful value is often not the element's
 * text: a product ID may live in data-product-id, and a price may be embedded
 * in "税込 12,800円".
 */
export const fieldSelectorSchema = z.object({
  selector: z.string(),
  /** Read this attribute instead of the text content. */
  attr: z.string().optional(),
  /** First capture group becomes the value. */
  regex: z.string().optional(),
  /** Non-fatal when absent. Fatal when required and missing. */
  required: z.boolean().default(false),
});
export type FieldSelector = z.infer<typeof fieldSelectorSchema>;

export const stockRuleSchema = z.object({
  /** Matched against the stock element's text. */
  pattern: z.string(),
  status: z.enum(['IN_STOCK', 'OUT_OF_STOCK', 'UNKNOWN']),
  /**
   * Capture group holding an explicit quantity, if the shop shows one.
   * Absent means "in stock, count unknown" — which caps eBay quantity at 1.
   */
  qtyGroup: z.number().int().min(1).optional(),
});
export type StockRule = z.infer<typeof stockRuleSchema>;

/**
 * How to derive the shop's own product ID.
 *
 * Ordered strategies, first hit wins. Titles are deliberately not an option:
 * a shop that renames a product must not orphan its price history.
 */
export const productIdStrategySchema = z.discriminatedUnion('from', [
  z.object({
    from: z.literal('url_path'),
    /** e.g. "/product/(\\d+)" — capture group 1 is the ID. */
    regex: z.string(),
  }),
  z.object({ from: z.literal('url_query'), param: z.string() }),
  z.object({ from: z.literal('attribute'), selector: z.string(), attr: z.string() }),
  z.object({ from: z.literal('json_ld'), path: z.string() }),
]);
export type ProductIdStrategy = z.infer<typeof productIdStrategySchema>;

export const supplierConfigSchema = z.object({
  supplierCode: z.string().min(1),
  baseUrl: z.string().url(),
  /** Hosts this adapter may contact. Enforced by the HTTP client. */
  allowedHosts: z.array(z.string().min(1)).min(1),

  categoryUrls: z.array(z.string().url()).default([]),
  pagination: paginationConfigSchema.default({ type: 'none' }),

  /** Query params that are part of a product's identity, not tracking noise. */
  canonicalKeepParams: z.array(z.string()).default([]),
  forceHost: z.string().optional(),

  list: z.object({
    /** Repeating element, one per product. */
    productCard: z.string(),
    name: fieldSelectorSchema,
    price: fieldSelectorSchema,
    link: fieldSelectorSchema,
    image: fieldSelectorSchema.optional(),
    stock: fieldSelectorSchema.optional(),
  }),

  detail: z
    .object({
      name: fieldSelectorSchema.optional(),
      price: fieldSelectorSchema.optional(),
      stock: fieldSelectorSchema.optional(),
      description: fieldSelectorSchema.optional(),
      images: fieldSelectorSchema.optional(),
      breadcrumbs: fieldSelectorSchema.optional(),
    })
    .default({}),

  productId: z.array(productIdStrategySchema).min(1),
  stockRules: z.array(stockRuleSchema).default([]),

  capabilities: z
    .object({
      hasExactStockCount: z.boolean().default(false),
      hasStructuredData: z.boolean().default(false),
      supportsConditionalGet: z.boolean().default(false),
      requiresJsRendering: z.boolean().default(false),
      maxConcurrency: z.number().int().min(1).max(4).default(1),
      minRequestIntervalMs: z.number().int().min(500).default(3000),
    })
    .default({}),
});
export type SupplierConfig = z.infer<typeof supplierConfigSchema>;

export class SupplierConfigError extends Error {
  constructor(
    readonly supplierCode: string,
    readonly issues: z.ZodIssue[],
  ) {
    super(
      `Invalid configuration for supplier "${supplierCode}":\n` +
        issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
    this.name = 'SupplierConfigError';
  }
}

export function parseSupplierConfig(code: string, raw: unknown): SupplierConfig {
  const result = supplierConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new SupplierConfigError(code, result.error.issues);
  }
  return result.data;
}

/**
 * True when a config has not been filled in yet.
 *
 * The magi and CardRush configs ship empty on purpose: their real selectors are
 * unknown until the sites can actually be fetched and inspected, and inventing
 * plausible-looking ones would produce an adapter that fails in a confusing way
 * rather than an obvious one. The sync job checks this and reports "selectors
 * not configured" instead of crawling blind.
 */
export function isConfigured(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false;
  return Object.keys(raw as Record<string, unknown>).length > 0;
}
