/**
 * The dry-run guard.
 *
 * The requirement is that no listing reaches production eBay without explicit
 * admin approval. A boolean checked at the call site is not enough for that —
 * someone adds a new eBay call six months from now, forgets the check, and the
 * guarantee is gone with no test failing.
 *
 * So this module makes the *type system* carry the guarantee: mutating eBay
 * operations are only reachable through `execute()`, which demands a
 * PublishAuthorization that only `authorizePublish()` can mint, and which
 * cannot be constructed by callers because its brand field is a unique symbol
 * that is not exported.
 *
 * Four independent conditions must hold for a production write:
 *   1. DRY_RUN is explicitly "false"
 *   2. ALLOW_PRODUCTION_PUBLISH is explicitly "true"
 *   3. an admin approved this specific catalog product
 *   4. the run is under its publish cap
 *
 * Anything less and the call is simulated and recorded, never sent.
 */

import { readSafetyInterlocksFromEnv } from '@cardbridge/core';

const AUTHORIZATION_BRAND = Symbol('PublishAuthorization');

export type EbayEnvironment = 'SANDBOX' | 'PRODUCTION';

/** Read-only operations are always allowed; only mutations are gated. */
export type EbayOperationKind =
  | 'READ'
  | 'CREATE_INVENTORY_ITEM'
  | 'CREATE_OFFER'
  | 'PUBLISH_OFFER'
  | 'UPDATE_PRICE'
  | 'UPDATE_QUANTITY'
  | 'WITHDRAW_OFFER'
  | 'DELETE_INVENTORY_ITEM';

const MUTATING_OPERATIONS: ReadonlySet<EbayOperationKind> = new Set<EbayOperationKind>([
  'CREATE_INVENTORY_ITEM',
  'CREATE_OFFER',
  'PUBLISH_OFFER',
  'UPDATE_PRICE',
  'UPDATE_QUANTITY',
  'WITHDRAW_OFFER',
  'DELETE_INVENTORY_ITEM',
]);

export interface AdminApproval {
  catalogProductId: string;
  approvedBy: string;
  approvedAt: string;
  /** Which environment the admin was looking at when they approved. */
  environment: EbayEnvironment;
  /** Hash of the exact payload shown in the preview. */
  payloadHash: string;
}

/**
 * Proof that a specific operation on a specific product passed every check.
 * Unforgeable outside this module: the brand symbol is module-private.
 */
export interface PublishAuthorization {
  readonly [AUTHORIZATION_BRAND]: true;
  readonly catalogProductId: string;
  readonly operation: EbayOperationKind;
  readonly environment: EbayEnvironment;
  readonly approvedBy: string;
  readonly issuedAt: string;
}

export interface GuardConfig {
  environment: EbayEnvironment;
  dryRun: boolean;
  allowProductionPublish: boolean;
  maxPublishPerRun: number;
}

export type GuardOutcome<T> =
  | { executed: true; result: T; simulated: false }
  | { executed: false; simulated: true; reason: string; payload: unknown };

export class PublishBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`eBay publish blocked: ${reason}`);
    this.name = 'PublishBlockedError';
  }
}

export function loadGuardConfig(env: NodeJS.ProcessEnv = process.env): GuardConfig {
  const interlocks = readSafetyInterlocksFromEnv(env);
  const rawEnvironment = env.EBAY_ENV ?? 'SANDBOX';
  return {
    // Unrecognised values fall back to SANDBOX rather than throwing, so a typo
    // degrades safely instead of taking the whole worker down.
    environment: rawEnvironment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
    ...interlocks,
  };
}

export class DryRunGuard {
  private publishCount = 0;
  private readonly simulatedCalls: Array<{
    operation: EbayOperationKind;
    catalogProductId: string;
    reason: string;
    payload: unknown;
    at: string;
  }> = [];

  constructor(private readonly config: GuardConfig) {}

  get environment(): EbayEnvironment {
    return this.config.environment;
  }

  get isDryRun(): boolean {
    return this.config.dryRun;
  }

  /** Everything that would have been sent. Feeds the listing preview UI. */
  getSimulatedCalls(): ReadonlyArray<{
    operation: EbayOperationKind;
    catalogProductId: string;
    reason: string;
    payload: unknown;
    at: string;
  }> {
    return [...this.simulatedCalls];
  }

  /**
   * Why a mutation would be blocked, or null if it would go through.
   * Exposed so the UI can explain the block before an admin clicks anything.
   */
  blockReason(operation: EbayOperationKind, approval: AdminApproval | null): string | null {
    if (!MUTATING_OPERATIONS.has(operation)) return null;

    if (this.config.dryRun) {
      return 'DRY_RUN is enabled';
    }
    if (this.config.environment === 'PRODUCTION' && !this.config.allowProductionPublish) {
      return 'ALLOW_PRODUCTION_PUBLISH is not set to true';
    }
    if (!approval) {
      return 'no admin approval recorded for this product';
    }
    if (approval.environment !== this.config.environment) {
      // An approval given while looking at Sandbox must not authorise
      // production. Approving is an act about a specific target.
      return `approval was granted for ${approval.environment}, not ${this.config.environment}`;
    }
    if (this.publishCount >= this.config.maxPublishPerRun) {
      return `run cap of ${this.config.maxPublishPerRun} publishes reached`;
    }
    return null;
  }

  /**
   * Mint an authorization, or throw. Nothing else can produce a
   * PublishAuthorization, so no eBay mutation can bypass these checks.
   */
  authorizePublish(
    operation: EbayOperationKind,
    catalogProductId: string,
    approval: AdminApproval | null,
  ): PublishAuthorization {
    const reason = this.blockReason(operation, approval);
    if (reason) {
      throw new PublishBlockedError(reason);
    }
    if (approval && approval.catalogProductId !== catalogProductId) {
      throw new PublishBlockedError(
        `approval is for product ${approval.catalogProductId}, not ${catalogProductId}`,
      );
    }
    return {
      [AUTHORIZATION_BRAND]: true,
      catalogProductId,
      operation,
      environment: this.config.environment,
      approvedBy: approval?.approvedBy ?? 'system',
      issuedAt: new Date().toISOString(),
    };
  }

  /**
   * Run an eBay operation.
   *
   * Reads pass straight through. Mutations either carry a valid authorization
   * and execute, or are recorded as simulated and never sent. The `apiCall`
   * closure is not invoked at all in the simulated path — that is what makes
   * "Dry Run does not touch the production API" a structural fact rather than
   * a promise.
   */
  async execute<T>(
    operation: EbayOperationKind,
    catalogProductId: string,
    payload: unknown,
    apiCall: () => Promise<T>,
    authorization?: PublishAuthorization,
  ): Promise<GuardOutcome<T>> {
    if (!MUTATING_OPERATIONS.has(operation)) {
      return { executed: true, result: await apiCall(), simulated: false };
    }

    if (!authorization) {
      const reason = this.blockReason(operation, null) ?? 'no authorization supplied';
      this.recordSimulated(operation, catalogProductId, reason, payload);
      return { executed: false, simulated: true, reason, payload };
    }

    if (authorization.operation !== operation) {
      const reason = `authorization is for ${authorization.operation}, not ${operation}`;
      this.recordSimulated(operation, catalogProductId, reason, payload);
      return { executed: false, simulated: true, reason, payload };
    }
    if (authorization.catalogProductId !== catalogProductId) {
      const reason = `authorization is for product ${authorization.catalogProductId}`;
      this.recordSimulated(operation, catalogProductId, reason, payload);
      return { executed: false, simulated: true, reason, payload };
    }
    if (authorization.environment !== this.config.environment) {
      const reason = `authorization targets ${authorization.environment}`;
      this.recordSimulated(operation, catalogProductId, reason, payload);
      return { executed: false, simulated: true, reason, payload };
    }

    // Re-check the interlocks at execution time. Settings can change between
    // approval and execution, and the later state is the one that governs.
    const reason = this.blockReason(operation, {
      catalogProductId,
      approvedBy: authorization.approvedBy,
      approvedAt: authorization.issuedAt,
      environment: authorization.environment,
      payloadHash: '',
    });
    if (reason) {
      this.recordSimulated(operation, catalogProductId, reason, payload);
      return { executed: false, simulated: true, reason, payload };
    }

    if (operation === 'PUBLISH_OFFER') {
      this.publishCount += 1;
    }
    return { executed: true, result: await apiCall(), simulated: false };
  }

  private recordSimulated(
    operation: EbayOperationKind,
    catalogProductId: string,
    reason: string,
    payload: unknown,
  ): void {
    this.simulatedCalls.push({
      operation,
      catalogProductId,
      reason,
      payload,
      at: new Date().toISOString(),
    });
  }
}
