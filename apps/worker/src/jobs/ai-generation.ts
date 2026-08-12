import { sql } from 'drizzle-orm';
import { getDb } from '@cardbridge/db';
import { CardNameCatalog, type CardNameEntry } from '@cardbridge/core';
import {
  buildCopyPrompt,
  createProviderFromEnv,
  describeProviderConfig,
  generateValidated,
  listingCopySchema,
} from '@cardbridge/ai';
import type { ClaimedJob, JobQueue } from '../queue';

/**
 * Generate the English copy for listable products.
 *
 * The narrow scope is the point. The model writes a description body and maps
 * Item Specifics; it does not write titles (title-builder assembles those
 * deterministically from structured fields), and it is never asked for a card's
 * English name — that comes from the card_names table, because a model that
 * does not know a card produces a plausible name anyway and a plausible wrong
 * name looks correct to the reviewer approving it.
 *
 * Every attempt is recorded, including failures. A recurring schema violation
 * should be visible as a pattern rather than as retries nobody sees.
 */

export interface AiGenerationStats extends Record<string, unknown> {
  considered: number;
  generated: number;
  needsReview: number;
  skippedWithoutEnglishName: number;
  failures: string[];
}

interface ProductRow extends Record<string, unknown> {
  id: string;
  card_name_ja: string;
  card_name_en: string | null;
  set_name: string | null;
  set_code: string | null;
  card_number: string | null;
  rarity: string | null;
  release_year: string | null;
  grading_company: string;
  grade: string;
  language: string;
  category_id: string | null;
  aspects: unknown;
}

interface CardNameRow extends Record<string, unknown> {
  name_ja: string;
  name_en: string;
  set_code: string | null;
  card_number: string | null;
  source: string;
  is_verified: boolean;
}

/** Aspect names the category offers, from the cached metadata payload. */
function allowedAspectNames(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((a) => (a as { name?: unknown }).name)
    .filter((n): n is string => typeof n === 'string');
}

export async function runAiGeneration(
  job: ClaimedJob,
  queue: JobQueue,
): Promise<AiGenerationStats> {
  const described = describeProviderConfig();
  if (!described.configured) {
    // Names the variable rather than reporting a generic misconfiguration: the
    // operator should not have to guess which of several keys is absent.
    throw new Error(`cannot generate listing copy: ${described.missing.join(', ')} is not set`);
  }

  const db = getDb();
  const provider = createProviderFromEnv();

  const marketplaceCode = process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US';
  // The category the aspect list is read from. eBay files graded Pokemon
  // singles under 183050 by default; a deployment listing elsewhere overrides
  // it rather than having the value assumed for them. If no policy has been
  // cached for it yet, allowedAspects comes back empty and the AI layer drops
  // every aspect the model proposes — which is the safe direction, since an
  // aspect the category does not offer is rejected at publish.
  const categoryId = process.env.EBAY_PRIMARY_CATEGORY_ID ?? '183050';
  const minConfidence = Number(process.env.AI_MIN_CONFIDENCE ?? '0.85');

  // The name table is loaded once and indexed, rather than queried per product.
  // A per-product round trip is fine at a hundred cards and quietly terrible at
  // the size this table reaches once a full set list is imported.
  const nameRows = await db.execute<CardNameRow>(sql`
    SELECT name_ja, name_en, set_code, card_number, source, is_verified FROM card_names
  `);
  const catalog = new CardNameCatalog(
    nameRows.map((r): CardNameEntry => ({
      nameJa: r.name_ja,
      nameEn: r.name_en,
      setCode: r.set_code,
      cardNumber: r.card_number,
      source: r.source,
      verified: r.is_verified,
    })),
  );

  const products = await db.execute<ProductRow>(sql`
    SELECT c.id, c.card_name_ja, c.card_name_en, c.set_name, c.set_code, c.card_number,
           c.rarity, c.release_year, c.grading_company, c.grade, c.language,
           ${categoryId} AS category_id, ap.payload AS aspects
    FROM catalog_products c
    LEFT JOIN ebay_aspect_policies ap
      ON ap.category_id = ${categoryId}
     AND ap.marketplace_code = ${marketplaceCode}
    WHERE NOT EXISTS (
      SELECT 1 FROM ai_generations g
      WHERE g.target_id = c.id AND g.purpose = 'LISTING_COPY' AND g.output IS NOT NULL
    )
    ORDER BY c.updated_at DESC
    LIMIT 25
  `);

  const stats: AiGenerationStats = {
    considered: products.length,
    generated: 0,
    needsReview: 0,
    skippedWithoutEnglishName: 0,
    failures: [],
  };

  for (const product of products) {
    // Prefer whatever is already on the product; fall back to the lookup. The
    // model is never asked to supply this.
    const resolved =
      product.card_name_en ??
      catalog.lookup({
        nameJa: product.card_name_ja,
        setCode: product.set_code,
        cardNumber: product.card_number,
      }).nameEn.value;

    if (!resolved) {
      stats.skippedWithoutEnglishName += 1;
      continue;
    }

    const request = buildCopyPrompt({
      cardNameEn: resolved,
      setNameEn: product.set_name,
      cardNumber: product.card_number,
      rarity: product.rarity,
      // Never coerced from a missing value: a wrong year is worse than none,
      // because it looks right to a reviewer and breaks eBay search.
      releaseYear: product.release_year === null ? null : Number(product.release_year),
      gradingCompany: product.grading_company,
      grade: Number(product.grade),
      language: product.language,
      allowedAspects: allowedAspectNames(product.aspects),
      representativeImage: false,
    });

    const result = await generateValidated({
      provider,
      request,
      schema: listingCopySchema,
      // The guard checks the output against exactly what went in, so anything
      // the model adds that is not traceable here is flagged.
      sourceText: `${product.card_name_ja} ${resolved} ${product.set_name ?? ''} ${
        product.card_number ?? ''
      } ${product.rarity ?? ''} ${product.release_year ?? ''}`,
      minConfidence,
      generativeFields: ['descriptionEn', 'warnings', 'confidence'],
    });

    await db.execute(sql`
      INSERT INTO ai_generations (
        target_type, target_id, purpose, provider, model, prompt_hash,
        input, output, schema_valid, confidence, warnings, hallucination_flags,
        input_tokens, output_tokens
      ) VALUES (
        ${'catalog_product'}, ${product.id}, ${'LISTING_COPY'},
        ${provider.name}, ${result.model}, ${result.promptHash},
        ${JSON.stringify({ cardNameEn: resolved })}::jsonb,
        ${result.value === null ? null : JSON.stringify(result.value)}::jsonb,
        ${JSON.stringify(result.ok)}::jsonb,
        ${result.value?.confidence ?? null},
        ${JSON.stringify(result.schemaIssues)}::jsonb,
        ${JSON.stringify(result.hallucinationFlags)}::jsonb,
        ${result.inputTokens}, ${result.outputTokens}
      )
    `);

    if (!result.ok) {
      // Recorded above and counted here, but not thrown: one card the model
      // mangled should not stop the batch.
      stats.failures.push(`${product.id}: ${result.schemaIssues.join('; ')}`);
      continue;
    }

    stats.generated += 1;
    if (result.requiresReview) stats.needsReview += 1;
  }

  if (stats.skippedWithoutEnglishName > 0) {
    await queue.log(
      job.id,
      'INFO',
      `${stats.skippedWithoutEnglishName} product(s) have no English name — add them at /settings/card-names`,
    );
  }

  return stats;
}
