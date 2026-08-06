import { sql } from 'drizzle-orm';
import type { Database } from '@cardbridge/db';

/**
 * Job queue.
 *
 * Postgres is the queue. That is a deliberate choice over Redis or a hosted
 * broker: the jobs already need transactional consistency with the rows they
 * operate on, and `SELECT ... FOR UPDATE SKIP LOCKED` gives exactly-one-worker
 * semantics without a second piece of infrastructure to run, monitor and lose
 * data in.
 *
 * Two properties matter and both are enforced by the database rather than here:
 *
 *   - A unit of work is never enqueued twice. The partial unique index on
 *     lock_key (0001_rls.sql) covers QUEUED and RUNNING rows, so a scheduler
 *     hiccup produces a constraint violation rather than two concurrent crawls
 *     of a partner's shop.
 *
 *   - A crashed worker does not strand its job. Claims carry a lease; an
 *     expired lease is reclaimable.
 */

export type JobType =
  | 'SUPPLIER_FULL_SYNC'
  | 'SUPPLIER_STOCK_CHECK'
  | 'SUPPLIER_PRICE_CHECK'
  | 'IMAGE_PROCESSING'
  | 'AI_GENERATION'
  | 'MARKET_PRICE_REFRESH'
  | 'EBAY_LISTING_SYNC'
  | 'EBAY_METADATA_REFRESH';

export interface ClaimedJob extends Record<string, unknown> {
  id: string;
  type: JobType;
  supplierId: string | null;
  lockKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueOptions {
  type: JobType;
  /** Identity of the work, not of the request. See the class comment. */
  lockKey: string;
  supplierId?: string | null;
  payload?: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
}

/** How long a worker may hold a job before another may reclaim it. */
const LEASE_DURATION_MS = 15 * 60 * 1000;

export class JobQueue {
  constructor(
    private readonly db: Database,
    private readonly workerId: string,
  ) {}

  /**
   * Enqueue, unless the same work is already queued or running.
   *
   * Returns null on a duplicate rather than throwing: a scheduler firing twice
   * is an ordinary event, not an error worth waking anyone for.
   */
  async enqueue(options: EnqueueOptions): Promise<string | null> {
    try {
      const rows = await this.db.execute<{ id: string }>(sql`
        INSERT INTO sync_jobs (type, supplier_id, lock_key, payload, next_run_at, max_attempts)
        VALUES (
          ${options.type}::sync_job_type,
          ${options.supplierId ?? null},
          ${options.lockKey},
          ${JSON.stringify(options.payload ?? {})}::jsonb,
          ${(options.runAt ?? new Date()).toISOString()},
          ${options.maxAttempts ?? 3}
        )
        RETURNING id
      `);
      return rows[0]?.id ?? null;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /**
   * Claim one ready job.
   *
   * SKIP LOCKED is what makes this safe to run from several workers at once:
   * each transaction takes a row nobody else holds, with no coordination and no
   * lock contention.
   */
  async claim(types?: readonly JobType[]): Promise<ClaimedJob | null> {
    const leaseExpiry = new Date(Date.now() + LEASE_DURATION_MS).toISOString();
    const typeFilter = types?.length
      ? sql`AND type = ANY(${sql.raw(`ARRAY[${types.map((t) => `'${t}'`).join(',')}]::sync_job_type[]`)})`
      : sql``;

    const rows = await this.db.execute<ClaimedJob & { payload: Record<string, unknown> }>(sql`
      WITH claimed AS (
        SELECT id FROM sync_jobs
        WHERE status = 'QUEUED'
          AND next_run_at <= now()
          ${typeFilter}
        ORDER BY next_run_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE sync_jobs j
      SET status = 'RUNNING',
          locked_by = ${this.workerId},
          locked_at = now(),
          lease_expires_at = ${leaseExpiry},
          started_at = COALESCE(j.started_at, now()),
          attempts = j.attempts + 1
      FROM claimed
      WHERE j.id = claimed.id
      RETURNING j.id, j.type, j.supplier_id AS "supplierId", j.lock_key AS "lockKey",
                j.payload, j.attempts, j.max_attempts AS "maxAttempts"
    `);

    return rows[0] ?? null;
  }

  /** Extend the lease on a long-running job so it is not reclaimed mid-flight. */
  async heartbeat(jobId: string): Promise<void> {
    const leaseExpiry = new Date(Date.now() + LEASE_DURATION_MS).toISOString();
    await this.db.execute(sql`
      UPDATE sync_jobs
      SET lease_expires_at = ${leaseExpiry}
      WHERE id = ${jobId} AND locked_by = ${this.workerId}
    `);
  }

  async complete(jobId: string, stats: Record<string, unknown> = {}): Promise<void> {
    await this.db.execute(sql`
      UPDATE sync_jobs
      SET status = 'SUCCEEDED',
          finished_at = now(),
          locked_by = NULL,
          lease_expires_at = NULL,
          stats = ${JSON.stringify(stats)}::jsonb,
          error = NULL
      WHERE id = ${jobId}
    `);
  }

  /**
   * Record a failure and decide whether to retry.
   *
   * Backoff is exponential with jitter. Without jitter, several jobs that
   * failed together retry together — which is precisely the wrong thing to do
   * to a shop that just returned 503.
   */
  async fail(jobId: string, error: Error, attempts: number, maxAttempts: number): Promise<void> {
    const exhausted = attempts >= maxAttempts;
    const backoffMs = Math.min(3_600_000, 60_000 * 2 ** (attempts - 1));
    const nextRun = new Date(Date.now() + backoffMs * (0.5 + Math.random() / 2));

    await this.db.execute(sql`
      UPDATE sync_jobs
      SET status = ${exhausted ? 'FAILED' : 'QUEUED'}::sync_job_status,
          error = ${error.message.slice(0, 2000)},
          locked_by = NULL,
          lease_expires_at = NULL,
          next_run_at = ${nextRun.toISOString()},
          finished_at = ${exhausted ? sql`now()` : sql`NULL`}
      WHERE id = ${jobId}
    `);
  }

  /**
   * Return jobs whose worker died.
   *
   * Without this a container restart mid-job leaves it RUNNING forever, and —
   * because the unique index covers RUNNING — blocks that work from ever being
   * enqueued again. The symptom is a sync that silently stops happening.
   */
  async reclaimExpired(): Promise<number> {
    const rows = await this.db.execute<{ id: string }>(sql`
      UPDATE sync_jobs
      SET status = 'QUEUED',
          locked_by = NULL,
          lease_expires_at = NULL,
          error = COALESCE(error, 'reclaimed after the worker lease expired')
      WHERE status = 'RUNNING'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < now()
      RETURNING id
    `);
    return rows.length;
  }

  async log(
    jobId: string,
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
    message: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO sync_logs (job_id, level, message, context)
      VALUES (${jobId}, ${level}::log_level, ${message.slice(0, 2000)},
              ${context ? JSON.stringify(context) : null}::jsonb)
    `);
  }
}

/** Postgres unique-violation SQLSTATE. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}
