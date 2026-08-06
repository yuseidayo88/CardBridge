import { eq, sql } from 'drizzle-orm';
import {
  getDb,
  priceHistory,
  stockHistory,
  supplierProducts,
  supplierSettings,
  suppliers,
} from '@cardbridge/db';
import { detectPsa10, parseTitle } from '@cardbridge/core';
import { GenericCartAdapter, isConfigured, parseSupplierConfig } from '@cardbridge/adapters';
import type { ClaimedJob, JobQueue } from '../queue';

/**
 * Fetch a supplier's catalogue and persist it.
 *
 * The shape of this job is dictated by two constraints that pull in opposite
 * directions: be gentle with a partner's shop, and keep our data fresh. The
 * resolution is that a full sync reads listing pages only — never a detail page
 * per product — and writes are diffed so that an unchanged product costs one
 * comparison rather than a row update and two history entries.
 */

export interface SyncStats extends Record<string, unknown> {
  supplierCode: string;
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  priceChanges: number;
  stockChanges: number;
  skipped: number;
  psaConfirmed: number;
  psaReview: number;
  psaRejected: number;
}

export async function runSupplierSync(job: ClaimedJob, queue: JobQueue): Promise<SyncStats> {
  const db = getDb();

  if (!job.supplierId) {
    throw new Error('a supplier sync job must name a supplier');
  }

  const [supplier] = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, job.supplierId))
    .limit(1);
  if (!supplier) throw new Error(`supplier ${job.supplierId} does not exist`);
  if (!supplier.isEnabled) throw new Error(`supplier ${supplier.code} is disabled`);

  const [settings] = await db
    .select()
    .from(supplierSettings)
    .where(eq(supplierSettings.supplierId, supplier.id))
    .limit(1);
  if (!settings) throw new Error(`supplier ${supplier.code} has no settings row`);

  // Selectors ship empty on purpose: the partner sites were unreachable when
  // this was built, and guessing them would produce an adapter that fails in a
  // confusing way rather than an obvious one.
  if (!isConfigured(settings.selectors)) {
    throw new Error(
      `supplier ${supplier.code} has no selectors configured. Run "pnpm research:snapshot" and "pnpm research:analyze" against the live site, then fill in supplier_settings.selectors.`,
    );
  }

  const config = parseSupplierConfig(supplier.code, {
    supplierCode: supplier.code,
    baseUrl: supplier.baseUrl,
    allowedHosts: [new URL(supplier.baseUrl).hostname.replace(/^www\./, '')],
    categoryUrls: settings.categoryUrls,
    stockRules: settings.stockRules,
    capabilities: {
      maxConcurrency: settings.maxConcurrency,
      minRequestIntervalMs: settings.minRequestIntervalMs,
    },
    ...(settings.selectors as Record<string, unknown>),
  });

  const adapter = new GenericCartAdapter(config, {
    userAgent: process.env.SCRAPER_USER_AGENT ?? 'CardBridgeBot/1.0',
  });

  const stats: SyncStats = {
    supplierCode: supplier.code,
    seen: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    priceChanges: 0,
    stockChanges: 0,
    skipped: 0,
    psaConfirmed: 0,
    psaReview: 0,
    psaRejected: 0,
  };

  // Existing products, keyed by the shop's own ID, so the diff below is a
  // lookup rather than a query per product.
  const existing = new Map(
    (
      await db
        .select({
          id: supplierProducts.id,
          sourceProductId: supplierProducts.sourceProductId,
          contentHash: supplierProducts.contentHash,
          priceInclTaxJpy: supplierProducts.priceInclTaxJpy,
          stockQty: supplierProducts.stockQty,
          stockStatus: supplierProducts.stockStatus,
        })
        .from(supplierProducts)
        .where(eq(supplierProducts.supplierId, supplier.id))
    ).map((row) => [row.sourceProductId, row]),
  );

  const seenIds = new Set<string>();

  for await (const raw of adapter.fetchProductList({ maxPages: settings.maxPagesPerRun })) {
    stats.seen += 1;
    seenIds.add(raw.sourceProductId);

    const psa = detectPsa10({
      title: raw.rawTitle,
      sourceCategoryUrl: raw.rawPayload.categoryUrl as string | undefined,
    });

    if (psa.verdict === 'CONFIRMED') stats.psaConfirmed += 1;
    else if (psa.verdict === 'REVIEW') stats.psaReview += 1;
    else stats.psaRejected += 1;

    // Rejected items are not persisted at all: they are other games, boxes and
    // lower grades, and keeping them would just make every downstream query
    // filter them out again.
    if (psa.verdict === 'REJECTED') {
      stats.skipped += 1;
      continue;
    }

    const parsed = parseTitle({ title: raw.rawTitle });
    const previous = existing.get(raw.sourceProductId);

    if (previous && previous.contentHash === raw.contentHash) {
      stats.unchanged += 1;
      await db
        .update(supplierProducts)
        .set({ lastCheckedAt: new Date() })
        .where(eq(supplierProducts.id, previous.id));
      continue;
    }

    const values = {
      supplierId: supplier.id,
      sourceProductId: raw.sourceProductId,
      canonicalUrl: raw.canonicalUrl,
      rawTitle: raw.rawTitle,
      priceInclTaxJpy: raw.priceInclTax,
      stockQty: raw.stockQty,
      stockStatus: raw.stockStatus,
      psaVerdict: psa.verdict,
      psaEvidence: psa.evidence,
      rawPayload: raw.rawPayload,
      parseWarnings: parsed.warnings,
      parseConfidence: String(parsed.overallConfidence),
      contentHash: raw.contentHash,
      lastCheckedAt: new Date(),
      disappearedAt: null,
    };

    const [row] = await db
      .insert(supplierProducts)
      .values(values)
      .onConflictDoUpdate({
        target: [supplierProducts.supplierId, supplierProducts.sourceProductId],
        set: values,
      })
      .returning({ id: supplierProducts.id });

    if (previous) stats.updated += 1;
    else stats.created += 1;

    // History is append-only, and only appended when something actually moved.
    // A row per sync would bury the real changes in noise.
    if (!previous || previous.priceInclTaxJpy !== raw.priceInclTax) {
      stats.priceChanges += 1;
      await db.insert(priceHistory).values({
        supplierProductId: row!.id,
        priceInclTaxJpy: raw.priceInclTax,
      });
    }
    if (
      !previous ||
      previous.stockStatus !== raw.stockStatus ||
      previous.stockQty !== raw.stockQty
    ) {
      stats.stockChanges += 1;
      await db.insert(stockHistory).values({
        supplierProductId: row!.id,
        stockQty: raw.stockQty,
        stockStatus: raw.stockStatus,
      });
    }
  }

  // Products that were not in the listing this time have gone from the shop.
  // Marked, never deleted: their price history is still the record of what that
  // card used to cost, and a returning product should reuse its own row.
  if (stats.seen > 0) {
    const vanished = [...existing.keys()].filter((id) => !seenIds.has(id));
    if (vanished.length > 0) {
      await db.execute(sql`
        UPDATE supplier_products
        SET disappeared_at = now(), stock_status = 'OUT_OF_STOCK'
        WHERE supplier_id = ${supplier.id}
          AND source_product_id = ANY(${vanished})
          AND disappeared_at IS NULL
      `);
      await queue.log(job.id, 'INFO', `${vanished.length} product(s) are no longer listed`);
    }
  }

  await db
    .update(supplierSettings)
    .set({ lastSyncedAt: new Date(), lastSyncError: null })
    .where(eq(supplierSettings.supplierId, supplier.id));

  await queue.log(job.id, 'INFO', 'sync finished', stats as unknown as Record<string, unknown>);
  return stats;
}
