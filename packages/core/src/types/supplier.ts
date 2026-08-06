import { z } from 'zod';
import { attributedSchema } from './attributed';

/**
 * The common shape every supplier is normalised into.
 *
 * Shop-specific knowledge stops here: nothing downstream of this file knows
 * that magi and CardRush exist. Adding a third shop means writing an adapter
 * that produces these types, and changing nothing else.
 */

export const stockStatusSchema = z.enum([
  'IN_STOCK',
  'OUT_OF_STOCK',
  /** The page rendered, but we could not tell. Never treated as sellable. */
  'UNKNOWN',
]);
export type StockStatus = z.infer<typeof stockStatusSchema>;

export const gradingCompanySchema = z.enum(['PSA', 'BGS', 'CGC', 'SGC', 'ARS', 'OTHER']);
export type GradingCompany = z.infer<typeof gradingCompanySchema>;

export const cardLanguageSchema = z.enum(['JAPANESE', 'ENGLISH', 'CHINESE', 'KOREAN', 'OTHER']);
export type CardLanguage = z.infer<typeof cardLanguageSchema>;

/**
 * Parsed card attributes. Every field is Attributed — there is no way to store
 * "the card number is 006/165" without also recording how we know that.
 */
export const parsedCardAttributesSchema = z.object({
  cardNameJa: attributedSchema(z.string().min(1).max(200)),
  cardNameEn: attributedSchema(z.string().min(1).max(200)),
  cardNumber: attributedSchema(z.string().min(1).max(32)),
  setCode: attributedSchema(z.string().min(1).max(32)),
  setName: attributedSchema(z.string().min(1).max(200)),
  rarity: attributedSchema(z.string().min(1).max(64)),
  releaseYear: attributedSchema(z.number().int().min(1996).max(2100)),
  language: attributedSchema(cardLanguageSchema),
  gradingCompany: attributedSchema(gradingCompanySchema),
  grade: attributedSchema(z.number().min(1).max(10)),
  conditionNote: attributedSchema(z.string().max(2000)),
});
export type ParsedCardAttributes = z.infer<typeof parsedCardAttributesSchema>;

export const parseWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(['INFO', 'WARN', 'ERROR']),
  field: z.string().optional(),
});
export type ParseWarning = z.infer<typeof parseWarningSchema>;

/** Raw scrape output, before parsing. Deliberately close to the page. */
export const supplierProductRawSchema = z.object({
  supplierCode: z.string(),
  /** Stable identifier from the shop's own system — never a slug or a title. */
  sourceProductId: z.string().min(1),
  canonicalUrl: z.string().url(),
  rawTitle: z.string().min(1),
  /** Tax-inclusive price as a decimal string. Never a JS number. */
  priceInclTax: z.string().regex(/^\d+(\.\d+)?$/),
  currency: z.literal('JPY'),
  stockQty: z.number().int().min(0).nullable(),
  stockStatus: stockStatusSchema,
  imageUrls: z.array(z.string().url()),
  /** Whole extracted payload, kept verbatim so re-parsing needs no refetch. */
  rawPayload: z.record(z.unknown()),
  /** Hash of the meaningful content, for cheap change detection. */
  contentHash: z.string(),
  fetchedAt: z.string().datetime(),
});
export type SupplierProductRaw = z.infer<typeof supplierProductRawSchema>;

export const supplierProductDetailRawSchema = supplierProductRawSchema.extend({
  descriptionHtml: z.string().nullable(),
  breadcrumbs: z.array(z.string()),
  structuredData: z.record(z.unknown()).nullable(),
});
export type SupplierProductDetailRaw = z.infer<typeof supplierProductDetailRawSchema>;

/** Raw + parsed + verdicts. This is what gets persisted. */
export const normalizedSupplierProductSchema = supplierProductDetailRawSchema.extend({
  attributes: parsedCardAttributesSchema,
  parseWarnings: z.array(parseWarningSchema),
  parseConfidence: z.number().min(0).max(1),
});
export type NormalizedSupplierProduct = z.infer<typeof normalizedSupplierProductSchema>;

export interface SupplierStockResult {
  sourceProductId: string;
  stockQty: number | null;
  stockStatus: StockStatus;
  checkedAt: string;
}

export interface SupplierPriceResult {
  sourceProductId: string;
  priceInclTax: string;
  currency: 'JPY';
  checkedAt: string;
}

/**
 * What an adapter can actually do.
 *
 * This is not documentation — the domain layer reads it and changes behaviour.
 * `hasExactStockCount: false` is what stops a shop that only says "in stock"
 * from ever producing an eBay quantity above 1.
 */
export interface SupplierCapabilities {
  hasExactStockCount: boolean;
  hasStructuredData: boolean;
  supportsConditionalGet: boolean;
  requiresJsRendering: boolean;
  maxConcurrency: number;
  minRequestIntervalMs: number;
}

export interface FetchOptions {
  maxPages?: number;
  /** Skip items whose contentHash is unchanged since this timestamp. */
  since?: string;
  signal?: AbortSignal;
}

export interface AdapterHealth {
  healthy: boolean;
  checkedAt: string;
  /** Per-selector hit counts, so a silent HTML change shows up as zeros. */
  selectorHits: Record<string, number>;
  sampleSize: number;
  errors: string[];
}

/**
 * The contract every supplier implements.
 *
 * fetchProductList is an AsyncIterable rather than a Promise<Array> so a sync
 * job can stream page by page, respect rate limits between pages, persist
 * incrementally and be cancelled mid-run without losing what it already read.
 *
 * checkStock/checkPrice take arrays because one HTTP request per product is not
 * an acceptable load to put on a partner's shop.
 */
export interface SupplierAdapter {
  readonly supplierCode: string;
  readonly capabilities: SupplierCapabilities;

  fetchProductList(options?: FetchOptions): AsyncIterable<SupplierProductRaw>;
  fetchProductDetail(sourceProductId: string): Promise<SupplierProductDetailRaw>;
  checkStock(sourceProductIds: string[]): Promise<SupplierStockResult[]>;
  checkPrice(sourceProductIds: string[]): Promise<SupplierPriceResult[]>;

  normalizeUrl(url: string): string;
  extractSourceProductId(url: string, html?: string): string | null;
  healthCheck(): Promise<AdapterHealth>;
}
