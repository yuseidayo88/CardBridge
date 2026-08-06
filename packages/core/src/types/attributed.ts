import { z } from 'zod';

/**
 * Attributed values — how this system refuses to guess.
 *
 * Every field parsed out of a supplier page carries where it came from and how
 * much we trust it. The alternative (a bare `cardNumber: string | null`) loses
 * the distinction between "the shop's JSON-LD says 006/165" and "an LLM thought
 * it looked like 006/165", and once that distinction is gone there is no honest
 * way to decide whether a listing is safe to publish.
 *
 * The ordering of AttributeSource is deliberate: it is a trust ranking, and
 * `preferHigherTrust` uses it to resolve conflicts without ever letting a
 * lower-trust source overwrite a higher-trust one.
 */

export const ATTRIBUTE_SOURCES = [
  /** Explicitly present in machine-readable markup (JSON-LD, microdata). */
  'structured_data',
  /** A deterministic parser matched a documented, shop-specific pattern. */
  'supplier_rule',
  /** A deterministic parser matched a general pattern (regex/lookup table). */
  'title_parser',
  /** Matched against our own curated card master data. */
  'catalog_lookup',
  /** A human typed it in the admin UI. Beats every automated source. */
  'manual',
  /** An LLM extracted it from text that was actually present in the source. */
  'ai_extraction',
  /** An LLM produced it without direct textual support. Never auto-publishable. */
  'ai_inference',
  /** Not determined. `value` MUST be null. */
  'unknown',
] as const;

export type AttributeSource = (typeof ATTRIBUTE_SOURCES)[number];

/**
 * Trust ranking. Higher wins. `manual` is top because an admin who has looked
 * at the card is the most reliable source we have; `ai_inference` sits at the
 * bottom because it is, by definition, a guess.
 */
const SOURCE_TRUST: Record<AttributeSource, number> = {
  manual: 100,
  structured_data: 90,
  supplier_rule: 80,
  catalog_lookup: 70,
  title_parser: 60,
  ai_extraction: 40,
  ai_inference: 10,
  unknown: 0,
};

/** Sources whose values may never, on their own, gate a production listing. */
const SPECULATIVE_SOURCES: ReadonlySet<AttributeSource> = new Set(['ai_inference', 'unknown']);

export interface Attributed<T> {
  value: T | null;
  source: AttributeSource;
  confidence: number;
  /** Optional free-text note, e.g. the regex that matched or the AI's reason. */
  note?: string;
}

export const attributedSchema = <T extends z.ZodTypeAny>(inner: T) =>
  z
    .object({
      value: inner.nullable(),
      source: z.enum(ATTRIBUTE_SOURCES),
      confidence: z.number().min(0).max(1),
      note: z.string().max(500).optional(),
    })
    .superRefine((val, ctx) => {
      // These two invariants are what make the structure trustworthy. Without
      // them you get `{value: "Charizard", source: "unknown", confidence: 0}`
      // rows that downstream code has to second-guess.
      if (val.source === 'unknown' && val.value !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'source "unknown" requires value to be null',
          path: ['value'],
        });
      }
      if (val.value === null && val.confidence !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a null value must have confidence 0',
          path: ['confidence'],
        });
      }
    });

export function attributed<T>(
  value: T | null,
  source: AttributeSource,
  confidence: number,
  note?: string,
): Attributed<T> {
  if (value === null) {
    return { value: null, source: 'unknown', confidence: 0, ...(note ? { note } : {}) };
  }
  if (confidence < 0 || confidence > 1) {
    throw new Error(`confidence must be within 0..1, got ${confidence}`);
  }
  return { value, source, confidence, ...(note ? { note } : {}) };
}

export function unknownAttribute<T>(note?: string): Attributed<T> {
  return { value: null, source: 'unknown', confidence: 0, ...(note ? { note } : {}) };
}

export function isKnown<T>(a: Attributed<T>): a is Attributed<T> & { value: T } {
  return a.value !== null && a.source !== 'unknown';
}

/** True when the value is present but only because something guessed it. */
export function isSpeculative<T>(a: Attributed<T>): boolean {
  return a.value !== null && SPECULATIVE_SOURCES.has(a.source);
}

/**
 * Confident enough to act on automatically: present, from a non-speculative
 * source, and above the threshold.
 */
export function isReliable<T>(a: Attributed<T>, minConfidence = 0.85): boolean {
  return isKnown(a) && !isSpeculative(a) && a.confidence >= minConfidence;
}

/**
 * Merge two readings of the same field.
 *
 * Trust rank decides first, confidence breaks ties within a rank. A known value
 * always beats an unknown one. This is the function that implements "do not let
 * the AI overwrite what the parser already established".
 */
export function preferHigherTrust<T>(
  current: Attributed<T>,
  incoming: Attributed<T>,
): Attributed<T> {
  if (!isKnown(incoming)) return current;
  if (!isKnown(current)) return incoming;

  const currentTrust = SOURCE_TRUST[current.source];
  const incomingTrust = SOURCE_TRUST[incoming.source];
  if (incomingTrust > currentTrust) return incoming;
  if (incomingTrust < currentTrust) return current;
  return incoming.confidence > current.confidence ? incoming : current;
}

/** Lowest confidence across a set of fields — the strength of the weakest link. */
export function aggregateConfidence(attrs: readonly Attributed<unknown>[]): number {
  if (attrs.length === 0) return 0;
  return attrs.reduce((min, a) => Math.min(min, a.confidence), 1);
}
