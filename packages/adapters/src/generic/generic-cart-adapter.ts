import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';

/**
 * What `$(selector)` returns. Derived from cheerio's own API rather than
 * importing a node type from domhandler, which is a transitive dependency we
 * do not declare.
 */
type CheerioSelection = ReturnType<cheerio.CheerioAPI>;
import type {
  AdapterHealth,
  FetchOptions,
  StockStatus,
  SupplierAdapter,
  SupplierCapabilities,
  SupplierPriceResult,
  SupplierProductDetailRaw,
  SupplierProductRaw,
  SupplierStockResult,
} from '@cardbridge/core';
import { HttpClient } from '../base/http-client';
import { normalizeUrl } from '../base/url-safety';
import type { FieldSelector, StockRule, SupplierConfig } from '../base/supplier-config';

/**
 * A supplier adapter driven entirely by configuration.
 *
 * magi and CardRush both expose `/product-group/{id}`, which strongly suggests
 * a shared storefront platform. If that holds, neither needs bespoke code — the
 * differences are selectors and stock vocabulary, and both live in
 * supplier_settings. A third shop on the same platform is then a database row
 * rather than a release.
 *
 * Where a shop genuinely differs, subclassing this and overriding one method is
 * still far less code than a standalone adapter.
 *
 * Nothing here knows which shop it is talking to. That is the point.
 */
export class GenericCartAdapter implements SupplierAdapter {
  readonly supplierCode: string;
  readonly capabilities: SupplierCapabilities;

  private readonly http: HttpClient;
  /** Per-run selector hit counts, so a silent markup change shows as zeros. */
  private readonly selectorHits = new Map<string, number>();
  private sampledCards = 0;

  constructor(
    private readonly config: SupplierConfig,
    options: { userAgent: string; fetchImpl?: typeof fetch } = { userAgent: 'CardBridgeBot/1.0' },
  ) {
    this.supplierCode = config.supplierCode;
    this.capabilities = config.capabilities;

    this.http = new HttpClient({
      userAgent: options.userAgent,
      allowedHosts: config.allowedHosts,
      minIntervalMs: config.capabilities.minRequestIntervalMs,
      maxConcurrency: config.capabilities.maxConcurrency,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  // --- listing ------------------------------------------------------------

  /**
   * Stream products page by page.
   *
   * An AsyncIterable rather than a returned array so a sync job can persist
   * incrementally, respect the rate limiter between pages, and be cancelled
   * without losing what it already read.
   */
  async *fetchProductList(options: FetchOptions = {}): AsyncIterable<SupplierProductRaw> {
    const maxPages = options.maxPages ?? 20;

    for (const categoryUrl of this.config.categoryUrls) {
      for (let page = 1; page <= maxPages; page += 1) {
        if (options.signal?.aborted) return;

        const url = this.pageUrl(categoryUrl, page);
        const response = await this.http.getText(url);
        if (response.notModified) break;

        const $ = cheerio.load(response.body);
        const cards = $(this.config.list.productCard);
        this.record('productCard', cards.length);

        // No cards means we have run past the last page — or the selector has
        // stopped matching. Either way, stop rather than walking every page.
        if (cards.length === 0) break;

        let yielded = 0;
        for (const element of cards.toArray()) {
          const product = this.parseCard($, $(element), categoryUrl, response.fetchedAt);
          if (product) {
            yielded += 1;
            yield product;
          }
        }

        this.sampledCards += cards.length;
        if (yielded === 0) break;
        if (this.config.pagination.type === 'none') break;
      }
    }
  }

  private pageUrl(categoryUrl: string, page: number): string {
    const pagination = this.config.pagination;

    switch (pagination.type) {
      case 'query': {
        if (page === pagination.start) return categoryUrl;
        const url = new URL(categoryUrl);
        url.searchParams.set(pagination.param, String(page));
        return url.toString();
      }
      case 'path': {
        if (page === pagination.start) return categoryUrl;
        return pagination.template.replace('{n}', String(page));
      }
      default:
        return categoryUrl;
    }
  }

  private parseCard(
    $: cheerio.CheerioAPI,
    card: CheerioSelection,
    categoryUrl: string,
    fetchedAt: string,
  ): SupplierProductRaw | null {
    const name = this.readField($, card, this.config.list.name, 'name');
    const priceText = this.readField($, card, this.config.list.price, 'price');
    const href = this.readField($, card, this.config.list.link, 'link');

    // A card without these three is not a product row — it is a layout element
    // that happened to match the selector.
    if (!name || !priceText || !href) return null;

    const productUrl = new URL(href, categoryUrl).toString();
    const canonicalUrl = normalizeUrl(productUrl, {
      keepParams: this.config.canonicalKeepParams,
      ...(this.config.forceHost ? { forceHost: this.config.forceHost } : {}),
    });

    const sourceProductId = this.extractSourceProductId(canonicalUrl, $.html(card));
    if (!sourceProductId) return null;

    const price = parsePrice(priceText);
    if (price === null) return null;

    const stockText = this.config.list.stock
      ? this.readField($, card, this.config.list.stock, 'stock')
      : null;
    const { status, quantity } = this.interpretStock(stockText ?? card.text());

    const imageRaw = this.config.list.image
      ? this.readField($, card, this.config.list.image, 'image')
      : null;
    const imageUrls = imageRaw ? [new URL(imageRaw, categoryUrl).toString()] : [];

    const rawPayload = {
      name,
      priceText,
      href,
      stockText,
      imageRaw,
      categoryUrl,
    };

    return {
      supplierCode: this.supplierCode,
      sourceProductId,
      canonicalUrl,
      rawTitle: name,
      priceInclTax: price,
      currency: 'JPY',
      stockQty: quantity,
      stockStatus: status,
      imageUrls,
      rawPayload,
      // Hash of the meaningful fields only, so an unrelated markup tweak does
      // not look like a product change and trigger a pointless detail fetch.
      contentHash: hashContent([name, price, String(quantity), status, ...imageUrls]),
      fetchedAt,
    };
  }

  /**
   * Map on-page stock text to a status and, where published, a count.
   *
   * Rules are ordered and the first match wins, so a shop's specific phrasing
   * ("残り1点") can be listed before its generic one ("在庫あり"). When no rule
   * matches, the answer is UNKNOWN — never "probably in stock".
   */
  private interpretStock(text: string): { status: StockStatus; quantity: number | null } {
    for (const rule of this.config.stockRules as StockRule[]) {
      const match = new RegExp(rule.pattern, 'i').exec(text);
      if (!match) continue;

      let quantity: number | null = null;
      if (rule.qtyGroup !== undefined) {
        const captured = match[rule.qtyGroup];
        const parsed = captured ? Number(captured) : Number.NaN;
        if (Number.isInteger(parsed) && parsed >= 0) quantity = parsed;
      }

      // A shop that does not publish counts must not produce one here: the
      // sourcing layer caps eBay quantity at 1 precisely because of this.
      if (!this.capabilities.hasExactStockCount) quantity = null;

      return { status: rule.status, quantity };
    }
    return { status: 'UNKNOWN', quantity: null };
  }

  private readField(
    $: cheerio.CheerioAPI,
    scope: CheerioSelection,
    selector: FieldSelector,
    label: string,
  ): string | null {
    const element = scope.find(selector.selector).first();
    if (element.length === 0) {
      this.record(label, 0);
      return null;
    }

    const raw = selector.attr ? element.attr(selector.attr) : element.text();
    if (!raw) {
      this.record(label, 0);
      return null;
    }

    const value = raw.trim();
    if (selector.regex) {
      const match = new RegExp(selector.regex).exec(value);
      const captured = match?.[1] ?? match?.[0];
      if (!captured) {
        this.record(label, 0);
        return null;
      }
      this.record(label, 1);
      return captured.trim();
    }

    this.record(label, 1);
    return value;
  }

  private record(label: string, hits: number): void {
    this.selectorHits.set(label, (this.selectorHits.get(label) ?? 0) + hits);
  }

  // --- detail -------------------------------------------------------------

  async fetchProductDetail(sourceProductId: string): Promise<SupplierProductDetailRaw> {
    const url = this.detailUrl(sourceProductId);
    const response = await this.http.getText(url);
    const $ = cheerio.load(response.body);

    const structuredData = extractJsonLd($);
    const detail = this.config.detail;

    const name =
      (detail.name ? this.readField($, $('body'), detail.name, 'detail.name') : null) ??
      $('title').text().trim();

    const priceText = detail.price
      ? this.readField($, $('body'), detail.price, 'detail.price')
      : null;
    const price = priceText ? parsePrice(priceText) : null;

    const stockText = detail.stock
      ? this.readField($, $('body'), detail.stock, 'detail.stock')
      : null;
    const { status, quantity } = this.interpretStock(stockText ?? $('body').text());

    const descriptionHtml = detail.description
      ? ($(detail.description.selector).first().html() ?? null)
      : null;

    const breadcrumbs = detail.breadcrumbs
      ? $(detail.breadcrumbs.selector)
          .map((_, el) => $(el).text().trim())
          .toArray()
          .filter(Boolean)
      : [];

    const imageUrls = detail.images
      ? $(detail.images.selector)
          .map((_, el) => $(el).attr(detail.images?.attr ?? 'src'))
          .toArray()
          .filter((v): v is string => Boolean(v))
          .map((src) => new URL(src, url).toString())
      : [];

    return {
      supplierCode: this.supplierCode,
      sourceProductId,
      canonicalUrl: normalizeUrl(url, { keepParams: this.config.canonicalKeepParams }),
      rawTitle: name,
      priceInclTax: price ?? '0',
      currency: 'JPY',
      stockQty: quantity,
      stockStatus: status,
      imageUrls,
      rawPayload: { priceText, stockText },
      contentHash: hashContent([name, price ?? '', status, ...imageUrls]),
      fetchedAt: response.fetchedAt,
      descriptionHtml,
      breadcrumbs,
      structuredData,
    };
  }

  private detailUrl(sourceProductId: string): string {
    // The ID strategy is reversible for the path form, which is how a detail
    // page is addressed without having kept the listing URL around.
    const strategy = this.config.productId[0];
    if (strategy?.from === 'url_path') {
      const template = strategy.regex.replace(/\\d\+|\(\\d\+\)|\([^)]*\)/g, sourceProductId);
      return new URL(template.replace(/[\\^$]/g, ''), this.config.baseUrl).toString();
    }
    return new URL(`/product/${sourceProductId}`, this.config.baseUrl).toString();
  }

  // --- checks -------------------------------------------------------------

  /**
   * Re-read stock for a set of products.
   *
   * Batched by re-reading the category listing rather than fetching each
   * product page: one request covers a whole page of products, which is the
   * difference between a courteous integration and a standing load on a
   * partner's shop.
   */
  async checkStock(sourceProductIds: string[]): Promise<SupplierStockResult[]> {
    const wanted = new Set(sourceProductIds);
    const results: SupplierStockResult[] = [];

    for await (const product of this.fetchProductList()) {
      if (!wanted.has(product.sourceProductId)) continue;
      results.push({
        sourceProductId: product.sourceProductId,
        stockQty: product.stockQty,
        stockStatus: product.stockStatus,
        checkedAt: product.fetchedAt,
      });
      wanted.delete(product.sourceProductId);
      if (wanted.size === 0) break;
    }

    // Anything the listing no longer contains has gone. Reporting UNKNOWN
    // rather than OUT_OF_STOCK matters: "I could not see it" and "the shop
    // says it is sold out" are different facts, and only one of them should
    // silently end a listing.
    for (const missing of wanted) {
      results.push({
        sourceProductId: missing,
        stockQty: null,
        stockStatus: 'UNKNOWN',
        checkedAt: new Date().toISOString(),
      });
    }

    return results;
  }

  async checkPrice(sourceProductIds: string[]): Promise<SupplierPriceResult[]> {
    const wanted = new Set(sourceProductIds);
    const results: SupplierPriceResult[] = [];

    for await (const product of this.fetchProductList()) {
      if (!wanted.has(product.sourceProductId)) continue;
      results.push({
        sourceProductId: product.sourceProductId,
        priceInclTax: product.priceInclTax,
        currency: 'JPY',
        checkedAt: product.fetchedAt,
      });
      wanted.delete(product.sourceProductId);
      if (wanted.size === 0) break;
    }

    return results;
  }

  normalizeUrl(url: string): string {
    return normalizeUrl(url, {
      keepParams: this.config.canonicalKeepParams,
      ...(this.config.forceHost ? { forceHost: this.config.forceHost } : {}),
    });
  }

  /**
   * Derive the shop's own product ID.
   *
   * Strategies are tried in configured order and the first hit wins. None of
   * them derives an ID from the title: a shop that renames a product must not
   * orphan its price history.
   */
  extractSourceProductId(url: string, html?: string): string | null {
    for (const strategy of this.config.productId) {
      switch (strategy.from) {
        case 'url_path': {
          const match = new RegExp(strategy.regex).exec(url);
          if (match?.[1]) return match[1];
          break;
        }
        case 'url_query': {
          try {
            const value = new URL(url).searchParams.get(strategy.param);
            if (value) return value;
          } catch {
            // Not an absolute URL; try the next strategy.
          }
          break;
        }
        case 'attribute': {
          if (!html) break;
          const $ = cheerio.load(html);
          const value = $(strategy.selector).first().attr(strategy.attr);
          if (value) return value;
          break;
        }
        case 'json_ld': {
          if (!html) break;
          const data = extractJsonLd(cheerio.load(html));
          const value = data ? readPath(data, strategy.path) : null;
          if (typeof value === 'string' && value) return value;
          break;
        }
      }
    }
    return null;
  }

  /**
   * Confirm the selectors still match.
   *
   * Run on a schedule so that a shop redesign surfaces as an alert rather than
   * as a sync that quietly returns zero products and looks like a quiet day.
   */
  async healthCheck(): Promise<AdapterHealth> {
    const errors: string[] = [];
    this.selectorHits.clear();
    this.sampledCards = 0;

    try {
      let seen = 0;
      for await (const _product of this.fetchProductList({ maxPages: 1 })) {
        seen += 1;
        if (seen >= 5) break;
      }
      if (seen === 0) {
        errors.push('the first category page yielded no products — the selectors may be stale');
      }
    } catch (error) {
      errors.push(`fetch failed: ${(error as Error).message}`);
    }

    for (const [label, hits] of this.selectorHits) {
      if (hits === 0) errors.push(`selector "${label}" matched nothing`);
    }

    return {
      healthy: errors.length === 0,
      checkedAt: new Date().toISOString(),
      selectorHits: Object.fromEntries(this.selectorHits),
      sampleSize: this.sampledCards,
      errors,
    };
  }
}

// --- helpers ---------------------------------------------------------------

function hashContent(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 32);
}

/** Same rules as core's price parser, kept local so adapters stay standalone. */
function parsePrice(text: string): string | null {
  const halfWidth = text.replace(/[！-～]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  const match = /(\d{1,3}(?:,\d{3})+|\d+)/.exec(halfWidth.replace(/\s/g, ''));
  if (!match) return null;
  const digits = match[1]!.replace(/,/g, '');
  return /^\d+$/.test(digits) ? digits : null;
}

function extractJsonLd($: cheerio.CheerioAPI): Record<string, unknown> | null {
  const blocks: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // A malformed block is the shop's problem, not a reason to fail the parse.
    }
  });

  const flat = blocks.flatMap((b) => (Array.isArray(b) ? b : [b]));
  const product = flat.find(
    (b) =>
      typeof b === 'object' &&
      b !== null &&
      /Product/i.test(String((b as Record<string, unknown>)['@type'])),
  );
  return (product as Record<string, unknown>) ?? (flat[0] as Record<string, unknown>) ?? null;
}

function readPath(data: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, data);
}
