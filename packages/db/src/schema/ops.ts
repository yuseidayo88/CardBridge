import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { logLevelEnum, syncJobStatusEnum, syncJobTypeEnum } from './enums';
import { suppliers } from './suppliers';

/**
 * Job queue.
 *
 * Workers claim rows with SELECT ... FOR UPDATE SKIP LOCKED, so concurrency
 * control lives in Postgres rather than in application coordination. The
 * partial unique index on lock_key (see migration 0001) is what makes
 * "one full sync per supplier at a time" a database guarantee: a second worker
 * that tries to enqueue a duplicate gets a constraint violation instead of
 * quietly doubling the request load on a partner's shop.
 */
export const syncJobs = pgTable(
  'sync_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: syncJobTypeEnum('type').notNull(),
    supplierId: uuid('supplier_id').references(() => suppliers.id, { onDelete: 'cascade' }),
    status: syncJobStatusEnum('status').notNull().default('QUEUED'),

    /** Identity of the work. Unique among non-terminal jobs. */
    lockKey: text('lock_key').notNull(),
    /** Set while a worker holds the row; a stale value means a crashed worker. */
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    /** After this, another worker may reclaim the job. */
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),

    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    /** Exponential backoff target; the worker skips rows until this passes. */
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull().defaultNow(),

    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    stats: jsonb('stats')
      .notNull()
      .default(sql`'{}'::jsonb`),
    error: text('error'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sync_jobs_claim_idx').on(t.status, t.nextRunAt),
    index('sync_jobs_supplier_idx').on(t.supplierId),
  ],
);

export const syncLogs = pgTable(
  'sync_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').references(() => syncJobs.id, { onDelete: 'cascade' }),
    level: logLevelEnum('level').notNull().default('INFO'),
    message: text('message').notNull(),
    context: jsonb('context'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sync_logs_job_idx').on(t.jobId, t.createdAt)],
);

/**
 * Every AI call, with its input, output and verdict.
 *
 * Retained in full because "why did it title this card that way?" is a question
 * that gets asked after a listing goes wrong, and because prompt_hash lets a
 * repeated call be served from here instead of paying for it twice.
 */
export const aiGenerations = pgTable(
  'ai_generations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    purpose: text('purpose').notNull(),

    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptHash: text('prompt_hash').notNull(),
    input: jsonb('input').notNull(),
    output: jsonb('output'),

    /** Did the response satisfy the Zod schema? Failures are kept, not dropped. */
    schemaValid: jsonb('schema_valid'),
    confidence: numeric('confidence', { precision: 5, scale: 4 }),
    warnings: jsonb('warnings')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Fields where the model produced a value with no support in the input. */
    hallucinationFlags: jsonb('hallucination_flags')
      .notNull()
      .default(sql`'[]'::jsonb`),

    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_generations_target_idx').on(t.targetType, t.targetId),
    index('ai_generations_prompt_hash_idx').on(t.promptHash),
  ],
);

/** Key/value application settings, editable from the admin UI. */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  description: text('description'),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Audit trail.
 *
 * Records who approved what. `before`/`after` hold the changed fields only —
 * never buyer names, addresses or payment details, which have no reason to
 * enter this system at all.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    /** Truncated to /24 before storage; full addresses are not retained. */
    ipPrefix: text('ip_prefix'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_target_idx').on(t.targetType, t.targetId),
    index('audit_logs_actor_idx').on(t.actor, t.createdAt),
  ],
);

/** Users allowed into the admin UI. Referenced by RLS policies. */
export const adminUsers = pgTable(
  'admin_users',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    role: text('role').notNull().default('admin'),
    isActive: text('is_active').notNull().default('true'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('admin_users_email_uq').on(t.email)],
);
