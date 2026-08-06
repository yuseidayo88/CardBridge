import type { CompletionRequest } from './provider';

/**
 * Prompts.
 *
 * Two structural decisions, both about limiting what the model can do rather
 * than about wording:
 *
 * 1. Instructions live in `system`, card data lives in `user`. The card data is
 *    scraped from a third party's page — if a supplier's product description
 *    ever contained "ignore previous instructions", keeping it out of the
 *    instruction channel is what stops that from being an instruction.
 *
 * 2. The model is asked for a small number of specific fields, never for a
 *    finished listing. It does not write titles and does not supply years.
 *    Narrow scope is the cheapest hallucination control available.
 */

const NEVER_GUESS = `
Rules you must follow exactly:
- If you do not know a value, return null. Never guess.
- Never invent a release year. If the year is not stated in the input, the year is unknown.
- Never invent a card number or a set code.
- Only give an English name that is the official English release name of that
  exact card. If the card was never released in English, return null rather
  than transliterating the Japanese.
- Do not add promotional words such as "authentic", "rare", "genuine" or "mint".
- Report your own uncertainty honestly in "confidence" and list anything you
  were unsure about in "warnings".
`.trim();

export interface TranslationPromptInput {
  rawTitle: string;
  cardNameJa: string | null;
  cardNumber: string | null;
  setCode: string | null;
  descriptionJa?: string | null;
}

export function buildTranslationPrompt(input: TranslationPromptInput): CompletionRequest {
  const system = `
You identify Japanese Pokemon Trading Card Game cards and give their official
English names for an eBay listing.

${NEVER_GUESS}

Respond with JSON only, matching this shape:
{
  "cardNameEn": string | null,
  "setNameEn": string | null,
  "characterEn": string | null,
  "confidence": number,
  "warnings": [{ "field": string, "message": string }]
}
`.trim();

  // Only fields the parser actually established are passed through, so the
  // model cannot mistake our uncertainty for a fact.
  const known = [
    `Product title: ${input.rawTitle}`,
    input.cardNameJa ? `Parsed Japanese card name: ${input.cardNameJa}` : null,
    input.cardNumber ? `Parsed card number: ${input.cardNumber}` : null,
    input.setCode ? `Parsed set code: ${input.setCode}` : null,
    input.descriptionJa ? `Shop description: ${input.descriptionJa.slice(0, 1000)}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    system,
    user: known,
    maxTokens: 1024,
    // Deterministic: this is an identification task, not a creative one.
    temperature: 0,
  };
}

export interface CopyPromptInput {
  cardNameEn: string;
  setNameEn: string | null;
  cardNumber: string | null;
  rarity: string | null;
  releaseYear: number | null;
  gradingCompany: string;
  grade: number;
  language: string;
  /** Aspect names the category actually offers. */
  allowedAspects: readonly string[];
  /** True when the photo may not be of the exact slab shipped. */
  representativeImage: boolean;
}

export function buildCopyPrompt(input: CopyPromptInput): CompletionRequest {
  const system = `
You write the description body and item specifics for an eBay listing of a
professionally graded Pokemon trading card.

${NEVER_GUESS}

Additional rules for this task:
- The description is plain text. Do not write HTML.
- State the grading company and grade plainly. Do not editorialise about
  condition beyond what the grade itself says.
- Use ONLY these item specific names, exactly as spelled here:
${input.allowedAspects.map((a) => `  - ${a}`).join('\n')}
- Omit any item specific whose value you do not know. Do not fill it with
  "N/A", "Unknown" or a guess.
${
  input.representativeImage
    ? `- The listing photo may not be the exact slab being shipped. State clearly
  that the buyer receives the same card, language, grading company and grade,
  and that the certification number may differ from the photo.`
    : `- The listing photo is of the exact item being shipped.`
}

Respond with JSON only, matching this shape:
{
  "descriptionEn": string,
  "itemSpecifics": { "<aspect name>": "<value>" },
  "confidence": number,
  "warnings": [{ "field": string, "message": string }]
}
`.trim();

  const facts = [
    `Card name (English): ${input.cardNameEn}`,
    input.setNameEn ? `Set (English): ${input.setNameEn}` : 'Set: unknown',
    input.cardNumber ? `Card number: ${input.cardNumber}` : 'Card number: unknown',
    input.rarity ? `Rarity: ${input.rarity}` : 'Rarity: unknown',
    input.releaseYear ? `Year: ${input.releaseYear}` : 'Year: unknown',
    `Language: ${input.language}`,
    `Graded by: ${input.gradingCompany}`,
    `Grade: ${input.grade}`,
  ].join('\n');

  return { system, user: facts, maxTokens: 2048, temperature: 0.2 };
}

/**
 * The representative-image disclosure, as fixed text.
 *
 * Deliberately not generated. The wording is a compliance statement, and a
 * model paraphrasing it differently on every listing is exactly what you do not
 * want from a compliance statement. Note that including it does not by itself
 * make representative images acceptable — the eligibility engine still routes
 * them to a human.
 */
export const REPRESENTATIVE_IMAGE_DISCLOSURE = `
The listing image may be a representative image.

You will receive the same card, language, grading company and grade.

The PSA certification number may differ from the image.
`.trim();
