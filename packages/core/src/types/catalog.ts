import { z } from 'zod';
import { cardLanguageSchema, gradingCompanySchema } from './supplier';

/**
 * Catalog types — the identity of a physical card, separate from any shop's
 * offer of it.
 *
 * The split matters: a catalog_product has no price and no stock, and a
 * supplier_product has no eBay listing. Collapsing them into one "products"
 * table is what makes multi-supplier systems impossible to reason about once
 * the same card appears in two shops at different prices.
 */

export const catalogProductSchema = z.object({
  id: z.string().uuid(),
  cardNameJa: z.string().min(1).max(200),
  cardNameEn: z.string().min(1).max(200).nullable(),
  cardNumber: z.string().min(1).max(32).nullable(),
  setCode: z.string().min(1).max(32).nullable(),
  setName: z.string().min(1).max(200).nullable(),
  rarity: z.string().max(64).nullable(),
  releaseYear: z.number().int().min(1996).max(2100).nullable(),
  language: cardLanguageSchema,
  gradingCompany: gradingCompanySchema,
  grade: z.number().min(1).max(10),
  /** Deterministic identity string; see matching/match-key.ts. */
  matchKey: z.string(),
  /** An admin has confirmed this identity. Required for high-value listings. */
  isVerified: z.boolean(),
});
export type CatalogProduct = z.infer<typeof catalogProductSchema>;

export const matchMethodSchema = z.enum(['AUTO', 'MANUAL']);
export type MatchMethod = z.infer<typeof matchMethodSchema>;

export const matchDecisionSchema = z.enum([
  /** Confident enough to link without a human. */
  'AUTO_MERGE',
  /** Plausible, but a human decides. Shown as a suggestion in the UI. */
  'REVIEW',
  /** Not the same card. */
  'REJECT',
]);
export type MatchDecision = z.infer<typeof matchDecisionSchema>;

export interface MatchCandidate {
  catalogProductId: string;
  score: number;
  decision: MatchDecision;
  /** Per-signal breakdown, so a reviewer can see *why* it scored what it did. */
  signals: Record<string, { matched: boolean; weight: number; note?: string }>;
  blockers: string[];
}

/**
 * PSA10 verdicts.
 *
 * REVIEW exists because the requirement is explicit that ambiguous items are
 * surfaced rather than silently dropped. A product that says "PSA10" in its
 * title but has no corroborating category or description evidence lands here,
 * not in CONFIRMED and not in REJECTED.
 */
export const psaVerdictSchema = z.enum(['CONFIRMED', 'REVIEW', 'REJECTED']);
export type PsaVerdict = z.infer<typeof psaVerdictSchema>;

export interface PsaEvaluation {
  verdict: PsaVerdict;
  confidence: number;
  /** Every signal considered, including the ones that did not fire. */
  evidence: Array<{
    signal: string;
    found: boolean;
    weight: number;
    detail: string;
  }>;
  reasons: string[];
}
