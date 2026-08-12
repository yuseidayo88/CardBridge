import { sql } from 'drizzle-orm';
import { getDb } from '@cardbridge/db';
import {
  EbayMetadataClient,
  EbayOAuthClient,
  resolveConditionDescriptors,
  type EbayEnvironment,
} from '@cardbridge/ebay';
import type { ClaimedJob, JobQueue } from '../queue';

/**
 * Refresh the eBay metadata this system refuses to hard-code.
 *
 * Condition IDs, condition descriptor IDs and their permitted values, and the
 * Item Specifics a category accepts all change without notice. Caching them
 * here means a listing is built from what eBay says today, and a change shows
 * up as a diff in one table rather than as a rejected publish nobody can
 * explain.
 *
 * Uses an *application* token: no seller consent is involved, so this job
 * cannot be broken by an expired user session. It runs before any seller has
 * connected.
 */

/** Trading-card categories this system lists into. */
const CATEGORY_IDS = ['183050', '183454', '261328'] as const;

// Extends Record so the queue can persist it as the job result JSON
// without a cast at the call site.
export interface MetadataStats extends Record<string, unknown> {
  categoriesRefreshed: number;
  aspectsStored: number;
  descriptorsResolved: number;
  failures: string[];
}

function environment(): EbayEnvironment {
  return process.env.EBAY_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';
}

export async function runEbayMetadataRefresh(
  job: ClaimedJob,
  queue: JobQueue,
): Promise<MetadataStats> {
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;

  if (!appId || !certId) {
    // Named explicitly rather than "not configured": the operator should not
    // have to guess which of several variables is the missing one.
    throw new Error(
      `cannot refresh eBay metadata: ${[!appId && 'EBAY_APP_ID', !certId && 'EBAY_CERT_ID']
        .filter(Boolean)
        .join(' and ')} is not set`,
    );
  }

  const marketplaceId = process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US';
  const env = environment();
  const oauth = new EbayOAuthClient({
    environment: env,
    appId,
    certId,
    redirectUri: process.env.EBAY_REDIRECT_URI ?? 'unset',
  });

  // Fetched once and reused across every call in this run. Requesting a fresh
  // application token per category would burn rate limit for nothing.
  const tokens = await oauth.getApplicationToken();

  const client = new EbayMetadataClient({
    apiBaseUrl: oauth.apiBaseUrl,
    getAccessToken: async () => tokens.accessToken,
    marketplaceId,
  });

  const stats: MetadataStats = {
    categoriesRefreshed: 0,
    aspectsStored: 0,
    descriptorsResolved: 0,
    failures: [],
  };

  const db = getDb();

  // --- condition policies -------------------------------------------------

  const policies = await client.getItemConditionPolicies(CATEGORY_IDS);

  // Stored per environment as well as per category: sandbox and production
  // policies differ, and a sandbox payload used to build a production listing
  // is a rejection nobody would think to look for here.
  await db.execute(sql`
    INSERT INTO ebay_condition_policies (marketplace_code, category_id, environment, payload, fetched_at)
    VALUES (${marketplaceId}, ${'ALL'}, ${env}, ${JSON.stringify(policies)}::jsonb, now())
    ON CONFLICT (marketplace_code, category_id, environment)
    DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()
  `);

  // Resolve immediately rather than at publish time. A category whose policy
  // stopped carrying the grade descriptor is something to discover during a
  // scheduled refresh, not during a publish an admin is watching.
  for (const categoryId of CATEGORY_IDS) {
    try {
      resolveConditionDescriptors(policies, categoryId, 'PSA', 10);
      stats.descriptorsResolved += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.failures.push(`condition descriptors for ${categoryId}: ${message}`);
      await queue.log(job.id, 'WARN', `descriptor resolution failed for ${categoryId}`, {
        message,
      });
    }
  }

  // --- category aspects ---------------------------------------------------

  const treeId = await client.getDefaultCategoryTreeId();
  await queue.log(job.id, 'INFO', `category tree ${treeId} for ${marketplaceId}`);

  for (const categoryId of CATEGORY_IDS) {
    try {
      const aspects = await client.getCategoryAspects(categoryId);

      await db.execute(sql`
        INSERT INTO ebay_aspect_policies (marketplace_code, category_id, environment, payload, fetched_at)
        VALUES (${marketplaceId}, ${categoryId}, ${env}, ${JSON.stringify(aspects)}::jsonb, now())
        ON CONFLICT (marketplace_code, category_id, environment)
        DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()
      `);

      stats.categoriesRefreshed += 1;
      stats.aspectsStored += aspects.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // One bad category should not abandon the rest: partial metadata is more
      // useful than none, and the failure is recorded either way.
      stats.failures.push(`aspects for ${categoryId}: ${message}`);
      await queue.log(job.id, 'WARN', `aspect fetch failed for ${categoryId}`, { message });
    }
  }

  if (stats.categoriesRefreshed === 0) {
    throw new Error(
      `no category metadata could be refreshed: ${stats.failures.join('; ') || 'unknown reason'}`,
    );
  }

  return stats;
}
