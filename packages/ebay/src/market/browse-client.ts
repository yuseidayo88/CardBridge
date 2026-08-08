/**
 * Market observation via the Browse API.
 *
 * Read this before trusting anything it returns: **Browse only sees active
 * listings**. An active listing is an asking price, not a sale. Sellers ask for
 * whatever they like, and a category with three optimistic asks and no sales
 * looks identical here to a healthy market.
 *
 * The sold-price sources are not available to us:
 *   - Marketplace Insights is a Limited Release, not open to new applicants.
 *   - findCompletedItems was decommissioned in February 2025.
 *
 * So this client reports asks, labels them as asks, and sets `isSufficient`
 * false unless sold data was supplied from somewhere else. The eligibility
 * engine refuses to auto-list against asks alone. That is the honest position:
 * pricing off other sellers' hopes is how you end up with inventory nobody
 * buys.
 */

export interface BrowseClientConfig {
  apiBaseUrl: string;
  getAccessToken: () => Promise<string>;
  marketplaceId: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  /** Ships-to country, so quoted prices are comparable to ours. */
  deliveryCountry?: string;
}

export class BrowseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(message);
    this.name = 'BrowseApiError';
  }
}

export interface ActiveListingObservation {
  itemId: string;
  title: string;
  /** Decimal string. Never a float — this feeds Money. */
  price: string;
  currency: string;
  shipping: string | null;
  condition: string | null;
  itemWebUrl: string | null;
  seller: string | null;
}

export interface MarketObservation {
  /** Always ACTIVE_ASKS from this client. Named so nobody forgets. */
  source: 'ACTIVE_ASKS';
  currency: string | null;
  observations: ActiveListingObservation[];
  activeMin: string | null;
  activeMedian: string | null;
  activeMax: string | null;
  activeCount: number;
  /**
   * Always false. Sold comparables have to come from a source this client does
   * not have access to; hard-coding false stops a caller from mistaking a large
   * `activeCount` for market evidence.
   */
  isSufficient: false;
  /** Plain-language limits, surfaced in the admin UI next to the numbers. */
  caveats: string[];
}

export interface SearchQuery {
  q: string;
  categoryIds?: string[];
  /** eBay condition ids, e.g. "2750" for Graded. */
  conditionIds?: string[];
  limit?: number;
}

interface RawBrowseResponse {
  itemSummaries?: Array<{
    itemId?: string;
    title?: string;
    price?: { value?: string; currency?: string };
    shippingOptions?: Array<{ shippingCost?: { value?: string; currency?: string } }>;
    condition?: string;
    itemWebUrl?: string;
    seller?: { username?: string };
  }>;
  total?: number;
}

export class EbayBrowseClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: BrowseClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async searchActiveListings(query: SearchQuery): Promise<MarketObservation> {
    const params = new URLSearchParams({
      q: query.q,
      limit: String(Math.min(query.limit ?? 50, 200)),
    });
    if (query.categoryIds?.length) params.set('category_ids', query.categoryIds.join(','));

    const filters: string[] = [];
    if (query.conditionIds?.length) filters.push(`conditionIds:{${query.conditionIds.join('|')}}`);
    if (filters.length) params.set('filter', filters.join(','));

    const raw = await this.get<RawBrowseResponse>(
      `/buy/browse/v1/item_summary/search?${params.toString()}`,
    );

    return summarise(raw);
  }

  private async get<T>(path: string): Promise<T> {
    const maxAttempts = this.config.maxAttempts ?? 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const token = await this.config.getAccessToken();

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': this.config.marketplaceId,
      };
      if (this.config.deliveryCountry) {
        // Without this, quoted shipping is whatever eBay guesses, and a price
        // that excludes international shipping is not comparable to ours.
        headers['X-EBAY-C-ENDUSERCTX'] =
          `contextualLocation=country=${this.config.deliveryCountry}`;
      }

      const response = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
        method: 'GET',
        headers,
      });

      const text = await response.text();
      const payload = text ? safeJsonParse(text) : null;

      if (response.ok) return payload as T;

      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        await sleep(Math.min(20_000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2));
        continue;
      }

      lastError = new BrowseApiError(
        `browse returned HTTP ${response.status}`,
        response.status,
        payload,
      );
      throw lastError;
    }

    throw lastError ?? new BrowseApiError(`GET ${path} failed`, 0, null);
  }
}

/**
 * Reduce a Browse response to comparable numbers.
 *
 * Mixed currencies are dropped rather than converted. Converting here would
 * bury an FX rate inside a market observation, where nobody would think to look
 * for it when the margin comes out wrong.
 */
export function summarise(raw: RawBrowseResponse): MarketObservation {
  const caveats = [
    'Browse API returns active listings only: these are asking prices, not sale prices.',
    'Sold comparables are unavailable (Marketplace Insights is Limited Release; findCompletedItems was decommissioned in February 2025).',
  ];

  const all = raw.itemSummaries ?? [];

  // The first listing's currency wins, and anything else is excluded. A median
  // computed across USD and GBP is not a number, it is a coincidence.
  const currency = all.find((i) => i.price?.currency)?.price?.currency ?? null;

  const observations: ActiveListingObservation[] = [];
  let dropped = 0;

  for (const item of all) {
    const value = item.price?.value;
    if (!item.itemId || !value || item.price?.currency !== currency) {
      if (item.price?.currency && item.price.currency !== currency) dropped += 1;
      continue;
    }

    observations.push({
      itemId: item.itemId,
      title: item.title ?? '',
      price: value,
      currency: currency!,
      shipping: item.shippingOptions?.[0]?.shippingCost?.value ?? null,
      condition: item.condition ?? null,
      itemWebUrl: item.itemWebUrl ?? null,
      seller: item.seller?.username ?? null,
    });
  }

  if (dropped > 0) {
    caveats.push(`${dropped} listing(s) in another currency were excluded rather than converted.`);
  }
  if (observations.length > 0 && observations.length < 3) {
    caveats.push('Fewer than three comparable listings: treat the spread as noise.');
  }

  const sorted = [...observations].sort((a, b) => compareDecimal(a.price, b.price));

  return {
    source: 'ACTIVE_ASKS',
    currency,
    observations,
    activeMin: sorted[0]?.price ?? null,
    activeMedian: medianOf(sorted.map((o) => o.price)),
    activeMax: sorted[sorted.length - 1]?.price ?? null,
    activeCount: observations.length,
    isSufficient: false,
    caveats,
  };
}

/**
 * Compare two decimal strings without going through a float.
 *
 * Sorting is the one place a float would be nearly harmless — and exactly the
 * place a stray parseFloat gets copied from into somewhere it is not.
 */
function compareDecimal(a: string, b: string): number {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');

  const intCmp = compareDigits(ai ?? '0', bi ?? '0');
  if (intCmp !== 0) return intCmp;

  const width = Math.max(af.length, bf.length);
  return compareDigits(af.padEnd(width, '0'), bf.padEnd(width, '0'));
}

function compareDigits(a: string, b: string): number {
  const stripped = [a.replace(/^0+(?=\d)/, ''), b.replace(/^0+(?=\d)/, '')];
  if (stripped[0]!.length !== stripped[1]!.length) {
    return stripped[0]!.length - stripped[1]!.length;
  }
  return stripped[0]! < stripped[1]! ? -1 : stripped[0]! > stripped[1]! ? 1 : 0;
}

/** Median of an already-sorted list. Even counts take the lower of the pair. */
function medianOf(sorted: string[]): string | null {
  if (sorted.length === 0) return null;
  // The lower of the two middles rather than their average: averaging would
  // invent a price that no listing actually carries, and every downstream
  // number here should be traceable to a real observation.
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
