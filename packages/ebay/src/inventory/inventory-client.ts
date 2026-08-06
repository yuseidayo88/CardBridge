import { randomUUID } from 'node:crypto';
import type {
  DryRunGuard,
  EbayOperationKind,
  GuardOutcome,
  PublishAuthorization,
} from '../guard/dry-run-guard';
import type { ConditionDescriptorPayload } from './condition-descriptors';

/**
 * eBay Sell Inventory API.
 *
 * Every mutating method here goes through DryRunGuard.execute(). That is not a
 * convention — the API call closures are private, so there is no way to reach
 * eBay's mutation endpoints from outside this class except via the guard. A
 * future method added by someone who has never read the safety documentation
 * still cannot publish without an authorization, because it has no other route
 * to the network.
 *
 * Rate limits are not hard-coded. eBay's per-application limits vary and can be
 * raised; the real numbers come from the Developer Analytics API, and this
 * client simply paces itself and backs off on 429.
 */

export interface InventoryClientConfig {
  apiBaseUrl: string;
  /** Called per request so a refresh mid-batch is picked up. */
  getAccessToken: () => Promise<string>;
  marketplaceId: string;
  /** eBay wants a locale for content negotiation. */
  contentLanguage?: string;
  guard: DryRunGuard;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
}

export interface InventoryItemPayload {
  sku: string;
  condition: string;
  conditionDescriptors: ConditionDescriptorPayload[];
  availability: {
    shipToLocationAvailability: { quantity: number };
  };
  product: {
    title: string;
    description: string;
    aspects: Record<string, string[]>;
    imageUrls: string[];
  };
}

export interface OfferPayload {
  sku: string;
  marketplaceId: string;
  format: 'FIXED_PRICE';
  availableQuantity: number;
  categoryId: string;
  listingDescription: string;
  listingPolicies: {
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
  };
  pricingSummary: { price: { value: string; currency: string } };
  merchantLocationKey: string;
}

export class EbayApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'EbayApiError';
  }
}

/** 5xx and 429 are transient; 4xx means the request itself is wrong. */
function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

export class EbayInventoryClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: InventoryClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  // --- transport ----------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const maxAttempts = this.config.maxAttempts ?? 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const token = await this.config.getAccessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': this.config.marketplaceId,
        'Content-Language': this.config.contentLanguage ?? 'en-US',
      };
      // Idempotency matters most on publish: a network timeout that actually
      // succeeded must not become a second live listing on retry.
      if (idempotencyKey) headers['X-EBAY-C-IDEMPOTENCY-KEY'] = idempotencyKey;

      const response = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      // 204 is a success with no body — common for update calls.
      if (response.status === 204) return undefined as T;

      const text = await response.text();
      const payload = text ? safeJsonParse(text) : null;

      if (response.ok) return payload as T;

      if (isRetryable(response.status) && attempt < maxAttempts) {
        await sleep(retryDelayMs(response, attempt));
        continue;
      }

      lastError = new EbayApiError(
        describeEbayError(payload, response.status),
        response.status,
        payload,
        response.headers.get('x-ebay-c-request-id') ?? undefined,
      );
      throw lastError;
    }

    throw lastError ?? new Error(`${method} ${path} failed after ${maxAttempts} attempts`);
  }

  // --- reads (never gated) -------------------------------------------------

  async getInventoryItem(sku: string): Promise<unknown> {
    const outcome = await this.config.guard.execute('READ', sku, { sku }, () =>
      this.request('GET', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`),
    );
    return outcome.executed ? outcome.result : null;
  }

  async getOffer(offerId: string): Promise<unknown> {
    const outcome = await this.config.guard.execute('READ', offerId, { offerId }, () =>
      this.request('GET', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`),
    );
    return outcome.executed ? outcome.result : null;
  }

  // --- mutations (all gated) ----------------------------------------------

  async createOrReplaceInventoryItem(
    catalogProductId: string,
    payload: InventoryItemPayload,
    authorization?: PublishAuthorization,
  ): Promise<GuardOutcome<unknown>> {
    return this.gated(
      'CREATE_INVENTORY_ITEM',
      catalogProductId,
      payload,
      () =>
        this.request(
          'PUT',
          `/sell/inventory/v1/inventory_item/${encodeURIComponent(payload.sku)}`,
          payload,
        ),
      authorization,
    );
  }

  async createOffer(
    catalogProductId: string,
    payload: OfferPayload,
    authorization?: PublishAuthorization,
  ): Promise<GuardOutcome<{ offerId: string }>> {
    return this.gated(
      'CREATE_OFFER',
      catalogProductId,
      payload,
      () =>
        this.request<{ offerId: string }>(
          'POST',
          '/sell/inventory/v1/offer',
          payload,
          // Derived from the SKU rather than random: a retry of the *same*
          // logical operation must reuse the key, or idempotency achieves
          // nothing.
          `offer-${payload.sku}`,
        ),
      authorization,
    );
  }

  async publishOffer(
    catalogProductId: string,
    offerId: string,
    authorization?: PublishAuthorization,
  ): Promise<GuardOutcome<{ listingId: string }>> {
    return this.gated(
      'PUBLISH_OFFER',
      catalogProductId,
      { offerId },
      () =>
        this.request<{ listingId: string }>(
          'POST',
          `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
          {},
          `publish-${offerId}`,
        ),
      authorization,
    );
  }

  async updatePrice(
    catalogProductId: string,
    offerId: string,
    price: { value: string; currency: string },
    authorization?: PublishAuthorization,
  ): Promise<GuardOutcome<unknown>> {
    return this.gated(
      'UPDATE_PRICE',
      catalogProductId,
      { offerId, price },
      () =>
        this.request('PUT', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, {
          pricingSummary: { price },
        }),
      authorization,
    );
  }

  async updateQuantity(
    catalogProductId: string,
    sku: string,
    quantity: number,
    authorization?: PublishAuthorization,
  ): Promise<GuardOutcome<unknown>> {
    if (quantity < 0) throw new Error('quantity cannot be negative');

    return this.gated(
      'UPDATE_QUANTITY',
      catalogProductId,
      { sku, quantity },
      () =>
        this.request('POST', '/sell/inventory/v1/bulk_update_price_quantity', {
          requests: [{ sku, shipToLocationAvailability: { quantity } }],
        }),
      authorization,
    );
  }

  /**
   * Take a listing down.
   *
   * Withdraw rather than delete: the offer survives, so relisting when stock
   * comes back reuses the same offer and its history instead of starting over.
   */
  async withdrawOffer(
    catalogProductId: string,
    offerId: string,
    authorization?: PublishAuthorization,
  ): Promise<GuardOutcome<unknown>> {
    return this.gated(
      'WITHDRAW_OFFER',
      catalogProductId,
      { offerId },
      () =>
        this.request(
          'POST',
          `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`,
          {},
        ),
      authorization,
    );
  }

  private gated<T>(
    operation: EbayOperationKind,
    catalogProductId: string,
    payload: unknown,
    call: () => Promise<T>,
    authorization?: PublishAuthorization,
  ): Promise<GuardOutcome<T>> {
    return this.config.guard.execute(operation, catalogProductId, payload, call, authorization);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

/** Turn eBay's error envelope into one readable line. */
function describeEbayError(payload: unknown, status: number): string {
  const errors = (
    payload as { errors?: Array<{ errorId?: number; message?: string; longMessage?: string }> }
  )?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors
      .map((e) => `[${e.errorId ?? '?'}] ${e.longMessage ?? e.message ?? 'unknown'}`)
      .join('; ');
  }
  return `eBay returned HTTP ${status}`;
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);
  }
  return Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Idempotency key for an operation that has no natural one. */
export function newIdempotencyKey(): string {
  return randomUUID();
}
