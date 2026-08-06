import { z } from 'zod';

/**
 * Schemas for AI output.
 *
 * The model is never trusted to return well-formed data. Everything it
 * produces is parsed through these before it can touch a listing, and a parse
 * failure is recorded rather than retried into submission.
 *
 * The scope given to the model is deliberately narrow. It does not write
 * titles (title-builder assembles those from structured fields) and it does not
 * supply years, card numbers or set names (those come from parsing or catalog
 * lookup, or stay unknown). It translates a card name, writes a description,
 * and maps values onto eBay item specifics — three jobs where natural language
 * is genuinely the right tool.
 */

/** Fields the model may declare it was unsure about. */
export const aiWarningSchema = z.object({
  field: z.string(),
  message: z.string().max(500),
});
export type AiWarning = z.infer<typeof aiWarningSchema>;

export const cardTranslationSchema = z.object({
  /**
   * Official English name of the card, as printed on the English release.
   * Null when the model does not know it — which is the correct answer for a
   * Japan-only card, and far better than a transliteration that matches
   * nothing a buyer would search for.
   */
  cardNameEn: z.string().min(1).max(120).nullable(),
  /** Official English set name, or null. Never transliterated. */
  setNameEn: z.string().min(1).max(120).nullable(),
  /** Pokémon character name in English, used for the Character item specific. */
  characterEn: z.string().min(1).max(80).nullable(),
  /** 0..1 self-assessment. Checked against the configured floor. */
  confidence: z.number().min(0).max(1),
  warnings: z.array(aiWarningSchema).default([]),
});
export type CardTranslation = z.infer<typeof cardTranslationSchema>;

export const listingCopySchema = z.object({
  /** Plain-text description body. HTML is assembled by us, not the model. */
  descriptionEn: z.string().min(20).max(4000),
  /**
   * eBay item specifics as name/value pairs. Validated against the category's
   * real aspect list before use; anything not offered is dropped.
   */
  itemSpecifics: z.record(z.string().max(65), z.string().max(65)),
  confidence: z.number().min(0).max(1),
  warnings: z.array(aiWarningSchema).default([]),
});
export type ListingCopy = z.infer<typeof listingCopySchema>;

/** A parse attempt that may have failed. Failures are kept, not discarded. */
export type AiParseResult<T> =
  { ok: true; value: T; raw: unknown } | { ok: false; issues: string[]; raw: unknown };

export function parseAiOutput<T>(schema: z.ZodType<T>, raw: unknown): AiParseResult<T> {
  const result = schema.safeParse(raw);
  if (result.success) {
    return { ok: true, value: result.data, raw };
  }
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    raw,
  };
}
