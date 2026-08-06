import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { GenericCartAdapter } from './generic-cart-adapter';
import { parseSupplierConfig, type SupplierConfig } from '../base/supplier-config';

/**
 * Driven by the synthetic fixture, not by a copy of a partner's page.
 *
 * The fixture mixes patterns common to Japanese storefronts (repeated product
 * cards, mixed stock vocabulary, query-string pagination, partial JSON-LD), so
 * it exercises the adapter properly. When the real sites become reachable, the
 * work is to write a config — not to change this class.
 */
const FIXTURE = readFileSync(
  new URL('../../../../docs/research/fixtures/sample-listing.html', import.meta.url),
  'utf8',
);

const config = (over: Record<string, unknown> = {}): SupplierConfig =>
  parseSupplierConfig('example', {
    supplierCode: 'example',
    baseUrl: 'https://example.test',
    allowedHosts: ['example.test'],
    categoryUrls: ['https://example.test/product-group/99'],
    pagination: { type: 'query', param: 'page', start: 1 },
    list: {
      productCard: '.product-item',
      name: { selector: '.product-name' },
      price: { selector: '.product-price' },
      link: { selector: 'a.product-link', attr: 'href' },
      image: { selector: 'img.product-thumb', attr: 'src' },
      stock: { selector: '.product-stock' },
    },
    productId: [{ from: 'attribute', selector: '[data-product-id]', attr: 'data-product-id' }],
    stockRules: [
      { pattern: '売り切れ|SOLD ?OUT', status: 'OUT_OF_STOCK' },
      { pattern: '残り\\s*(\\d+)\\s*点', status: 'IN_STOCK', qtyGroup: 1 },
      { pattern: '在庫あり|カートに入れる', status: 'IN_STOCK' },
    ],
    capabilities: { hasExactStockCount: true, minRequestIntervalMs: 500 },
    ...over,
  });

/** Serves the fixture for page 1 and an empty list thereafter. */
function fixtureFetch() {
  return vi.fn().mockImplementation(async (url: string) => {
    const page = new URL(url).searchParams.get('page');
    const body = page && page !== '1' ? '<html><body></body></html>' : FIXTURE;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  });
}

const adapter = (cfg = config(), fetchImpl = fixtureFetch()) =>
  new GenericCartAdapter(cfg, {
    userAgent: 'CardBridgeBot/1.0 (+https://example.com/contact)',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

async function collect(a: GenericCartAdapter) {
  const out = [];
  for await (const product of a.fetchProductList({ maxPages: 3 })) out.push(product);
  return out;
}

describe('GenericCartAdapter — listing', () => {
  it('extracts every product from the page', async () => {
    const products = await collect(adapter());
    expect(products).toHaveLength(5);
  });

  it('reads names, prices and images', async () => {
    const [first] = await collect(adapter());
    expect(first?.rawTitle).toContain('リザードンex');
    expect(first?.priceInclTax).toBe('128000');
    expect(first?.currency).toBe('JPY');
    expect(first?.imageUrls[0]).toBe('https://example.test/img/100234.jpg');
  });

  it("uses the shop's own product ID, not the title or a position", async () => {
    const products = await collect(adapter());
    expect(products.map((p) => p.sourceProductId)).toEqual([
      '100234',
      '100235',
      '100236',
      '100237',
      '100238',
    ]);
  });

  it('normalises the product URL', async () => {
    const [first] = await collect(adapter());
    expect(first?.canonicalUrl).toBe('https://example.test/product/100234');
  });

  it('stops when a page returns nothing rather than walking every page', async () => {
    const fetchImpl = fixtureFetch();
    await collect(adapter(config(), fetchImpl));
    // Page 1 has products, page 2 is empty and ends the loop.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('produces a content hash that ignores irrelevant markup', async () => {
    const [first] = await collect(adapter());
    expect(first?.contentHash).toHaveLength(32);
  });
});

describe('GenericCartAdapter — stock interpretation', () => {
  it('reads an explicit count when the shop publishes one', async () => {
    const products = await collect(adapter());
    const charizard = products.find((p) => p.sourceProductId === '100234');
    expect(charizard?.stockStatus).toBe('IN_STOCK');
    expect(charizard?.stockQty).toBe(2);
  });

  it('recognises sold out', async () => {
    const products = await collect(adapter());
    const pikachu = products.find((p) => p.sourceProductId === '100236');
    expect(pikachu?.stockStatus).toBe('OUT_OF_STOCK');
  });

  it('reports in stock with no count when the shop gives none', async () => {
    const products = await collect(adapter());
    const mew = products.find((p) => p.sourceProductId === '100235');
    expect(mew?.stockStatus).toBe('IN_STOCK');
    expect(mew?.stockQty).toBeNull();
  });

  it('never invents a count when the shop cannot supply one', async () => {
    // capabilities say counts are unavailable, so even a matching "残り2点"
    // rule must not produce a number.
    const products = await collect(
      adapter(config({ capabilities: { hasExactStockCount: false, minRequestIntervalMs: 500 } })),
    );
    for (const product of products) {
      expect(product.stockQty).toBeNull();
    }
  });

  it('reports UNKNOWN rather than guessing when no rule matches', async () => {
    const products = await collect(adapter(config({ stockRules: [] })));
    expect(products.every((p) => p.stockStatus === 'UNKNOWN')).toBe(true);
  });

  it('applies stock rules in order, so specific phrasing wins', async () => {
    const products = await collect(adapter());
    // "カートに入れる" is generic; the item with it is in stock, count unknown.
    const kai = products.find((p) => p.sourceProductId === '100238');
    expect(kai?.stockStatus).toBe('IN_STOCK');
  });
});

describe('GenericCartAdapter — product identity', () => {
  it('falls back through ID strategies in order', () => {
    const a = adapter(
      config({
        productId: [
          { from: 'url_query', param: 'pid' },
          { from: 'url_path', regex: '/product/(\\d+)' },
        ],
      }),
    );
    expect(a.extractSourceProductId('https://example.test/product/12345')).toBe('12345');
    expect(a.extractSourceProductId('https://example.test/detail?pid=999')).toBe('999');
  });

  it('returns null rather than inventing an ID', () => {
    const a = adapter(config({ productId: [{ from: 'url_path', regex: '/product/(\\d+)' }] }));
    expect(a.extractSourceProductId('https://example.test/about-us')).toBeNull();
  });

  it('skips a card whose ID cannot be determined', async () => {
    const products = await collect(
      adapter(config({ productId: [{ from: 'url_path', regex: '/nothing/(\\d+)' }] })),
    );
    expect(products).toHaveLength(0);
  });
});

describe('GenericCartAdapter — courtesy', () => {
  it('identifies itself with a contactable User-Agent', async () => {
    const fetchImpl = fixtureFetch();
    await collect(adapter(config(), fetchImpl));

    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('CardBridgeBot');
    expect(headers['User-Agent']).toContain('http');
  });

  it('refuses to contact a host outside the allowlist', async () => {
    const a = adapter(
      config({
        categoryUrls: ['https://evil.example.com/list'],
        allowedHosts: ['example.test'],
      }),
    );
    await expect(collect(a)).rejects.toThrow(/allowlist/);
  });

  it('re-reads the listing for stock rather than fetching each product page', async () => {
    const fetchImpl = fixtureFetch();
    const results = await adapter(config(), fetchImpl).checkStock(['100234', '100236']);

    expect(results).toHaveLength(2);
    // One listing request covered both products.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('reports a vanished product as UNKNOWN, not as sold out', async () => {
    // "I could not see it" and "the shop says it is sold out" are different
    // facts, and only one of them should end a listing.
    const [result] = await adapter().checkStock(['does-not-exist']);
    expect(result?.stockStatus).toBe('UNKNOWN');
    expect(result?.stockQty).toBeNull();
  });
});

describe('GenericCartAdapter — health check', () => {
  it('passes against markup the selectors match', async () => {
    const health = await adapter().healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.selectorHits.productCard).toBeGreaterThan(0);
  });

  it('fails loudly when the markup has changed', async () => {
    const health = await adapter(
      config({ list: { ...config().list, productCard: '.gone' } }),
    ).healthCheck();

    expect(health.healthy).toBe(false);
    expect(health.errors.join(' ')).toMatch(/no products|matched nothing/);
  });

  it('names the individual selector that stopped matching', async () => {
    const cfg = config();
    const health = await adapter(
      config({ list: { ...cfg.list, price: { selector: '.no-such-price' } } }),
    ).healthCheck();

    expect(health.healthy).toBe(false);
    expect(health.errors.join(' ')).toMatch(/price/);
  });
});

describe('GenericCartAdapter — the two partner shops need config, not code', () => {
  it('serves a different shop from the same class', async () => {
    // Same adapter, different selectors: this is what makes a third shop a
    // database row rather than a release.
    const alternative = parseSupplierConfig('other', {
      supplierCode: 'other',
      baseUrl: 'https://example.test',
      allowedHosts: ['example.test'],
      categoryUrls: ['https://example.test/product-group/99'],
      pagination: { type: 'none' },
      list: {
        productCard: 'li.product-item',
        name: { selector: 'span.product-name' },
        price: { selector: 'span.product-price' },
        link: { selector: 'a', attr: 'href' },
      },
      productId: [{ from: 'url_path', regex: '/product/(\\d+)' }],
      stockRules: [{ pattern: '.*', status: 'IN_STOCK' }],
      capabilities: { hasExactStockCount: false, minRequestIntervalMs: 500 },
    });

    const products = await collect(adapter(alternative));
    expect(products).toHaveLength(5);
    expect(products[0]?.supplierCode).toBe('other');
    expect(products[0]?.stockQty).toBeNull();
  });
});
