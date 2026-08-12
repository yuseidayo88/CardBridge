import { getDb } from '@cardbridge/db';
import { loadGuardConfig } from '@cardbridge/ebay';
import { JobQueue, type ClaimedJob } from './queue';
import { runSupplierSync } from './jobs/supplier-sync';
import { runEbayMetadataRefresh } from './jobs/ebay-metadata';
import { runMarketPriceRefresh } from './jobs/market-price';
import { runAiGeneration } from './jobs/ai-generation';

/**
 * Worker entry point.
 *
 * Runs as a long-lived process rather than a serverless function: a full
 * category crawl takes minutes at the pacing this system uses, and sharp needs
 * more memory than an edge runtime provides. The scheduler (Supabase pg_cron)
 * only enqueues; everything that takes time happens here.
 *
 * The loop is deliberately dull. It claims one job, runs it, records the
 * outcome, and repeats. Concurrency comes from running more workers, which
 * Postgres already handles via SKIP LOCKED.
 */

const POLL_INTERVAL_MS = 5000;
const RECLAIM_INTERVAL_MS = 60_000;

const workerId = `${process.env.HOSTNAME ?? 'worker'}-${process.pid}`;

let shuttingDown = false;

async function handle(job: ClaimedJob, queue: JobQueue): Promise<void> {
  await queue.log(job.id, 'INFO', `starting ${job.type}`, { workerId, attempt: job.attempts });

  switch (job.type) {
    case 'SUPPLIER_FULL_SYNC':
    case 'SUPPLIER_STOCK_CHECK':
    case 'SUPPLIER_PRICE_CHECK': {
      const stats = await runSupplierSync(job, queue);
      await queue.complete(job.id, stats);
      return;
    }

    // Both of these run on an application token, so neither needs a seller to
    // have connected. They throw with the name of the missing variable rather
    // than silently doing nothing when the keys are absent.
    case 'EBAY_METADATA_REFRESH': {
      const stats = await runEbayMetadataRefresh(job, queue);
      await queue.complete(job.id, stats);
      return;
    }

    case 'MARKET_PRICE_REFRESH': {
      const stats = await runMarketPriceRefresh(job, queue);
      await queue.complete(job.id, stats);
      return;
    }

    case 'AI_GENERATION': {
      const stats = await runAiGeneration(job, queue);
      await queue.complete(job.id, stats);
      return;
    }

    // Still unimplemented. Failing explicitly is better than a silent no-op
    // that looks like success in the dashboard.
    case 'IMAGE_PROCESSING':
    case 'EBAY_LISTING_SYNC':
      throw new Error(
        `${job.type} is not wired up yet — it needs credentials or network access that this deployment does not have`,
      );

    default:
      throw new Error(`unknown job type: ${String(job.type)}`);
  }
}

async function loop(): Promise<void> {
  const db = getDb();
  const queue = new JobQueue(db, workerId);
  const guard = loadGuardConfig();

  console.warn(
    `worker ${workerId} starting — eBay ${guard.environment}, dry run ${guard.dryRun ? 'ON' : 'OFF'}`,
  );

  let lastReclaim = 0;

  while (!shuttingDown) {
    try {
      // Periodically pick up work stranded by a crashed worker. Without this a
      // container restart mid-job blocks that work forever, and the symptom is
      // a sync that quietly stops running.
      if (Date.now() - lastReclaim > RECLAIM_INTERVAL_MS) {
        const reclaimed = await queue.reclaimExpired();
        if (reclaimed > 0) console.warn(`reclaimed ${reclaimed} job(s) from expired leases`);
        lastReclaim = Date.now();
      }

      const job = await queue.claim();
      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      try {
        await handle(job, queue);
      } catch (error) {
        const err = error as Error;
        await queue.log(job.id, 'ERROR', err.message, { stack: err.stack?.slice(0, 2000) });
        await queue.fail(job.id, err, job.attempts, job.maxAttempts);
      }
    } catch (error) {
      // A failure in the loop itself (database unreachable, say) must not kill
      // the worker — it should back off and try again.
      console.error('worker loop error:', (error as Error).message);
      await sleep(POLL_INTERVAL_MS * 4);
    }
  }

  console.warn(`worker ${workerId} stopped`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Finish the job in hand before exiting, so a deploy does not abandon a crawl
// halfway through and leave a partner's shop with a half-read session.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    console.warn(`${signal} received — finishing the current job then exiting`);
    shuttingDown = true;
  });
}

await loop();
