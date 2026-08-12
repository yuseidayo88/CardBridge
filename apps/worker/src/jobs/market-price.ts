import { sql } from 'drizzle-orm';
import { getDb } from '@cardbridge/db';
import { EbayBrowseClient, EbayOAuthClient, type EbayEnvironment } from '@cardbridge/ebay';
import type { ClaimedJob, JobQueue } from '../queue';

/**
 * Record what comparable cards are currently listed for.
 *
 * Read the Browse client's header before relying on any of this: these are
 * asking prices, not sale prices, and `isSufficient` is false by construction.
 * The eligibility engine will not auto-list against this data alone. What the
 * job buys us is a visible reference point next to a manually entered sold
 * median, and a record of how the asks moved over time.
 */

/** Graded, in the trading-card categories this system lists into. */
const GRADED_CONDITION_ID = '2750';
const CATEGORY_IDS = ['183050', '183454', '261328'];

// Extends Record so the queue can persist it as the job result JSON
// without a cast at the call site.
export interface MarketPriceStats extends Record<string, unknown> {
  productsQueried: number;
  observationsStored: number;
  skippedWithoutEnglishName: number;
  failures: string[];
}

interface ProductRow extends Record<string, unknown> {
  id: string;
  card_name_en: string | null;
  card_number: string | null;
  set_name: string | null;
  grading_company: string;
  grade: string;
  marketplace_id: string;
}

function environment(): EbayEnvironment {
  return process.env.EBAY_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';
}

/**
 * The search string.
 *
 * Built from structured fields rather than the listing title, because the
 * listing title has already been trimmed to eBay's 80 characters and may have
 * dropped exactly the term that identifies the card.
 */
export function buildSearchQuery(product: {
  card_name_en: string | null;
  card_number: string | null;
  grading_company: string;
  grade: string;
}): string | null {
  if (!product.card_name_en) return null;

  const parts = [product.card_name_en];
  if (product.card_number) parts.push(product.card_number);
  // Grade belongs in the query: a PSA 10 and a PSA 8 of the same card are
  // different markets, and averaging them produces a number that describes
  // neither.
  parts.push(`${product.grading_company} ${stripTrailingZeros(product.grade)}`);

  return parts.join(' ');
}

/** "10.0" from a numeric column should search as "10". */
function stripTrailingZeros(grade: string): string {
  return grade.includes('.') ? grade.replace(/\.?0+$/, '') : grade;
}

export async function runMarketPriceRefresh(
  job: ClaimedJob,
  queue: JobQueue,
): Promise<MarketPriceStats> {
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;

  if (!appId || !certId) {
    throw new Error(
      `cannot refresh market prices: ${[!appId && 'EBAY_APP_ID', !certId && 'EBAY_CERT_ID']
        .filter(Boolean)
        .join(' and ')} is not set`,
    );
  }

  const db = getDb();
  const marketplaceId = process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US';

  const oauth = new EbayOAuthClient({
    environment: environment(),
    appId,
    certId,
    redirectUri: process.env.EBAY_REDIRECT_URI ?? 'unset',
  });
  const tokens = await oauth.getApplicationToken();

  const client = new EbayBrowseClient({
    apiBaseUrl: oauth.apiBaseUrl,
    getAccessToken: async () => tokens.accessToken,
    marketplaceId,
    // Prices quoted to a US buyer, so they are comparable to what we would ask.
    deliveryCountry: 'US',
  });

  // Oldest observation first, so a run that is cut short still makes progress
  // on the stalest data rather than repeatedly refreshing the same head.
  const products = await db.execute<ProductRow>(sql`
    SELECT c.id, c.card_name_en, c.card_number, c.set_name,
           c.grading_company, c.grade, m.id AS marketplace_id
    FROM catalog_products c
    CROSS JOIN LATERAL (SELECT id FROM marketplaces WHERE code = ${marketplaceId} LIMIT 1) m
    LEFT JOIN LATERAL (
      SELECT max(collected_at) AS last_seen
      FROM market_prices mp
      WHERE mp.catalog_product_id = c.id
    ) last ON true
    ORDER BY last.last_seen ASC NULLS FIRST
    LIMIT 50
  `);

  const stats: MarketPriceStats = {
    productsQueried: 0,
    observationsStored: 0,
    skippedWithoutEnglishName: 0,
    failures: [],
  };

  for (const product of products) {
    const query = buildSearchQuery(product);

    if (!query) {
      // Searching on the Japanese name would return nothing on a US
      // marketplace, and storing an empty result as "no market" would be a
      // false negative that blocks a perfectly listable card.
      stats.skippedWithoutEnglishName += 1;
      continue;
    }

    try {
      const observation = await client.searchActiveListings({
        q: query,
        categoryIds: CATEGORY_IDS,
        conditionIds: [GRADED_CONDITION_ID],
        limit: 50,
      });
      stats.productsQueried += 1;

      if (observation.activeCount === 0) continue;

      await db.execute(sql`
        INSERT INTO market_prices (
          catalog_product_id, marketplace_id, source, currency,
          active_min, active_median, active_max, active_count,
          is_sufficient, notes, collected_at
        ) VALUES (
          ${product.id}, ${product.marketplace_id}, ${'BROWSE_API'}, ${observation.currency},
          ${observation.activeMin}, ${observation.activeMedian}, ${observation.activeMax},
          ${observation.activeCount},
          ${false}, ${observation.caveats.join(' ')}, now()
        )
      `);

      stats.observationsStored += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.failures.push(`${product.id}: ${message}`);
      await queue.log(job.id, 'WARN', `market lookup failed`, { productId: product.id, message });
    }
  }

  if (stats.skippedWithoutEnglishName > 0) {
    await queue.log(
      job.id,
      'INFO',
      `${stats.skippedWithoutEnglishName} product(s) have no English name yet — add them in the card name table`,
    );
  }

  return stats;
}
