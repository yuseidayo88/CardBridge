import type { ConditionPolicyResponse } from '../inventory/condition-descriptors';

/**
 * eBay Sell Metadata API.
 *
 * This is the client that fetches what the rest of the system refuses to
 * hard-code: condition IDs, condition descriptor IDs and their permitted
 * values, and the Item Specifics a category actually accepts. Those numbers
 * change, they differ per marketplace, and a constant copied from a blog post
 * produces a listing eBay rejects for reasons that make no sense to the person
 * reading the error.
 *
 * Every call here is a read, so none of it goes through DryRunGuard. Metadata
 * is also fetched with an *application* token: no seller consent is involved,
 * which means the nightly refresh cannot be broken by an expired user session.
 */

export interface MetadataClientConfig {
  apiBaseUrl: string;
  /** Called per request, so a mid-batch refresh is picked up. */
  getAccessToken: () => Promise<string>;
  marketplaceId: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
}

export class MetadataApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(message);
    this.name = 'MetadataApiError';
  }
}

/** One aspect a category accepts, reduced to what the listing builder needs. */
export interface CategoryAspect {
  name: string;
  required: boolean;
  /** SELECTION_ONLY means free text is rejected. */
  selectionOnly: boolean;
  /** Empty when the aspect takes free text. */
  values: string[];
  maxLength: number | null;
  cardinality: 'SINGLE' | 'MULTI';
}

interface RawAspectResponse {
  aspects?: Array<{
    localizedAspectName?: string;
    aspectConstraint?: {
      aspectRequired?: boolean;
      aspectMode?: string;
      itemToAspectCardinality?: string;
      aspectMaxLength?: number;
      aspectUsage?: string;
    };
    aspectValues?: Array<{ localizedValue?: string }>;
  }>;
}

export class EbayMetadataClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: MetadataClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /**
   * Condition policies for one or more categories.
   *
   * The response feeds resolveConditionDescriptors, which throws rather than
   * partially resolving — so a category whose policy is missing a descriptor
   * fails at build time instead of producing a listing missing its grade.
   */
  async getItemConditionPolicies(categoryIds: readonly string[]): Promise<ConditionPolicyResponse> {
    if (categoryIds.length === 0) {
      throw new MetadataApiError('no category ids supplied', 0, null);
    }

    const filter = `categoryIds:{${categoryIds.join('|')}}`;
    return this.get<ConditionPolicyResponse>(
      `/sell/metadata/v1/marketplace/${encodeURIComponent(this.config.marketplaceId)}` +
        `/get_item_condition_policies?filter=${encodeURIComponent(filter)}`,
    );
  }

  /**
   * The aspects (Item Specifics) a category accepts.
   *
   * Returned normalised, because the AI layer's filterToAllowedAspects needs a
   * plain name/values shape to drop invented aspects against — and because
   * eBay's own field names change more often than ours should.
   */
  async getCategoryAspects(categoryId: string): Promise<CategoryAspect[]> {
    const raw = await this.get<RawAspectResponse>(
      `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(this.treeIdFor())}` +
        `/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`,
    );

    return (raw.aspects ?? []).flatMap((aspect) => {
      const name = aspect.localizedAspectName;
      if (!name) return [];

      const constraint = aspect.aspectConstraint ?? {};
      return [
        {
          name,
          required: constraint.aspectRequired === true,
          // FREE_TEXT and SELECTION_ONLY behave completely differently at
          // publish time: sending free text to a SELECTION_ONLY aspect is a
          // hard rejection, not a warning.
          selectionOnly: constraint.aspectMode === 'SELECTION_ONLY',
          values: (aspect.aspectValues ?? [])
            .map((v) => v.localizedValue)
            .filter((v): v is string => typeof v === 'string' && v.length > 0),
          maxLength:
            typeof constraint.aspectMaxLength === 'number' ? constraint.aspectMaxLength : null,
          cardinality: constraint.itemToAspectCardinality === 'MULTI' ? 'MULTI' : 'SINGLE',
        } satisfies CategoryAspect,
      ];
    });
  }

  /**
   * The default category tree id for this marketplace.
   *
   * eBay keys the taxonomy by tree, not by marketplace, and the mapping is not
   * one you should guess: EBAY_US is tree 0, EBAY_GB is 3, and so on. Fetching
   * it is one call and removes the guess entirely.
   */
  async getDefaultCategoryTreeId(): Promise<string> {
    const response = await this.get<{ categoryTreeId?: string }>(
      `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${encodeURIComponent(
        this.config.marketplaceId,
      )}`,
    );

    if (!response.categoryTreeId) {
      throw new MetadataApiError('eBay returned no categoryTreeId', 200, response);
    }

    this.cachedTreeId = response.categoryTreeId;
    return response.categoryTreeId;
  }

  private cachedTreeId: string | null = null;

  /**
   * The tree id to use in a taxonomy path.
   *
   * Deliberately throws rather than defaulting to "0". Silently assuming the US
   * tree would return plausible aspects for the wrong marketplace, and wrong
   * Item Specifics are far harder to notice than a missing call.
   */
  private treeIdFor(): string {
    if (!this.cachedTreeId) {
      throw new MetadataApiError(
        'call getDefaultCategoryTreeId() before requesting category aspects',
        0,
        null,
      );
    }
    return this.cachedTreeId;
  }

  /** Lets a caller restore a tree id it persisted, skipping one round trip. */
  setCategoryTreeId(treeId: string): void {
    this.cachedTreeId = treeId;
  }

  private async get<T>(path: string): Promise<T> {
    const maxAttempts = this.config.maxAttempts ?? 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const token = await this.config.getAccessToken();

      const response = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': this.config.marketplaceId,
        },
      });

      const text = await response.text();
      const payload = text ? safeJsonParse(text) : null;

      if (response.ok) return payload as T;

      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        await sleep(Math.min(20_000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2));
        continue;
      }

      lastError = new MetadataApiError(
        describeError(payload, response.status),
        response.status,
        payload,
      );
      throw lastError;
    }

    throw lastError ?? new MetadataApiError(`GET ${path} failed`, 0, null);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function describeError(payload: unknown, status: number): string {
  const errors = (payload as { errors?: Array<{ errorId?: number; message?: string }> })?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((e) => `[${e.errorId ?? '?'}] ${e.message ?? 'unknown'}`).join('; ');
  }
  return `eBay metadata returned HTTP ${status}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
