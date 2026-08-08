import { describe, expect, it, vi } from 'vitest';
import { BrowseApiError, EbayBrowseClient, summarise } from './browse-client';

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: string[] = [];
  let index = 0;

  const impl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    const spec = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify(spec.body), { status: spec.status });
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

function item(over: Record<string, unknown> = {}) {
  return {
    itemId: 'v1|1|0',
    title: 'Charizard ex PSA 10',
    price: { value: '300.00', currency: 'USD' },
    condition: 'Graded',
    seller: { username: 'someseller' },
    ...over,
  };
}

function client(responses: Array<{ status: number; body: unknown }>) {
  const { impl, calls } = fakeFetch(responses);
  return {
    calls,
    client: new EbayBrowseClient({
      apiBaseUrl: 'https://api.sandbox.ebay.com',
      getAccessToken: async () => 'token',
      marketplaceId: 'EBAY_US',
      fetchImpl: impl,
    }),
  };
}

describe('summarise', () => {
  it('computes min, median and max across listings', () => {
    const result = summarise({
      itemSummaries: [
        item({ itemId: 'a', price: { value: '300.00', currency: 'USD' } }),
        item({ itemId: 'b', price: { value: '100.00', currency: 'USD' } }),
        item({ itemId: 'c', price: { value: '200.00', currency: 'USD' } }),
      ],
    });

    expect(result.activeMin).toBe('100.00');
    expect(result.activeMedian).toBe('200.00');
    expect(result.activeMax).toBe('300.00');
    expect(result.activeCount).toBe(3);
  });

  // The single most important property of this whole module. A large
  // activeCount is not market evidence, and a caller that treated it as such
  // would price against other sellers' hopes.
  it('never reports sufficiency, however many listings came back', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      item({ itemId: `id-${i}`, price: { value: '250.00', currency: 'USD' } }),
    );
    expect(summarise({ itemSummaries: many }).isSufficient).toBe(false);
  });

  it('labels the source as asks rather than sales', () => {
    expect(summarise({ itemSummaries: [item()] }).source).toBe('ACTIVE_ASKS');
  });

  it('always carries the active-only and sold-unavailable caveats', () => {
    const caveats = summarise({ itemSummaries: [item()] }).caveats.join(' ');
    expect(caveats).toContain('asking prices');
    expect(caveats).toContain('Marketplace Insights');
  });

  // Converting here would bury an FX rate inside a market observation, where
  // nobody looks when the margin comes out wrong.
  it('drops other-currency listings rather than converting them', () => {
    const result = summarise({
      itemSummaries: [
        item({ itemId: 'a', price: { value: '300.00', currency: 'USD' } }),
        item({ itemId: 'b', price: { value: '250.00', currency: 'GBP' } }),
      ],
    });

    expect(result.currency).toBe('USD');
    expect(result.activeCount).toBe(1);
    expect(result.caveats.join(' ')).toContain('another currency');
  });

  it('warns when there are too few listings to mean anything', () => {
    const result = summarise({ itemSummaries: [item(), item({ itemId: 'b' })] });
    expect(result.caveats.join(' ')).toContain('Fewer than three');
  });

  it('does not add the thin-market caveat once there are three', () => {
    const result = summarise({
      itemSummaries: [item({ itemId: 'a' }), item({ itemId: 'b' }), item({ itemId: 'c' })],
    });
    expect(result.caveats.join(' ')).not.toContain('Fewer than three');
  });

  it('handles an empty result without inventing numbers', () => {
    const result = summarise({ itemSummaries: [] });
    expect(result.activeMin).toBeNull();
    expect(result.activeMedian).toBeNull();
    expect(result.activeMax).toBeNull();
    expect(result.activeCount).toBe(0);
  });

  it('skips listings with no price at all', () => {
    const result = summarise({
      itemSummaries: [item(), { itemId: 'b', title: 'no price' }],
    });
    expect(result.activeCount).toBe(1);
  });

  it('keeps prices as strings so they can reach Money intact', () => {
    const result = summarise({
      itemSummaries: [item({ price: { value: '1234.56', currency: 'USD' } })],
    });
    expect(result.observations[0]!.price).toBe('1234.56');
    expect(typeof result.observations[0]!.price).toBe('string');
  });

  // Sorting "1000" before "99" is the classic string-comparison bug, and it
  // would put the most expensive listing in the min slot.
  it('orders by numeric value, not lexicographically', () => {
    const result = summarise({
      itemSummaries: [
        item({ itemId: 'a', price: { value: '1000.00', currency: 'USD' } }),
        item({ itemId: 'b', price: { value: '99.00', currency: 'USD' } }),
        item({ itemId: 'c', price: { value: '250.00', currency: 'USD' } }),
      ],
    });

    expect(result.activeMin).toBe('99.00');
    expect(result.activeMax).toBe('1000.00');
  });

  it('compares fractional parts of differing width correctly', () => {
    const result = summarise({
      itemSummaries: [
        item({ itemId: 'a', price: { value: '10.9', currency: 'USD' } }),
        item({ itemId: 'b', price: { value: '10.10', currency: 'USD' } }),
      ],
    });

    expect(result.activeMin).toBe('10.10');
    expect(result.activeMax).toBe('10.9');
  });

  // Averaging the two middles would produce a price no listing carries, and
  // every number here should trace back to a real observation.
  it('takes a real observation as the median rather than averaging', () => {
    const result = summarise({
      itemSummaries: [
        item({ itemId: 'a', price: { value: '100.00', currency: 'USD' } }),
        item({ itemId: 'b', price: { value: '200.00', currency: 'USD' } }),
      ],
    });

    expect(['100.00', '200.00']).toContain(result.activeMedian);
  });

  it('captures shipping when the listing quotes it', () => {
    const result = summarise({
      itemSummaries: [
        item({ shippingOptions: [{ shippingCost: { value: '15.00', currency: 'USD' } }] }),
      ],
    });
    expect(result.observations[0]!.shipping).toBe('15.00');
  });
});

describe('EbayBrowseClient', () => {
  it('sends the search query and marketplace', async () => {
    const { client: c, calls } = client([{ status: 200, body: { itemSummaries: [item()] } }]);
    await c.searchActiveListings({ q: 'Charizard ex PSA 10' });

    expect(calls[0]).toContain('q=Charizard+ex+PSA+10');
    expect(calls[0]).toContain('/buy/browse/v1/item_summary/search');
  });

  it('passes condition ids through as a filter', async () => {
    const { client: c, calls } = client([{ status: 200, body: { itemSummaries: [] } }]);
    await c.searchActiveListings({ q: 'x', conditionIds: ['2750'] });

    expect(decodeURIComponent(calls[0]!)).toContain('conditionIds:{2750}');
  });

  it('caps the page size at eBay’s maximum', async () => {
    const { client: c, calls } = client([{ status: 200, body: { itemSummaries: [] } }]);
    await c.searchActiveListings({ q: 'x', limit: 5000 });

    expect(calls[0]).toContain('limit=200');
  });

  it('retries a 500 and then succeeds', async () => {
    const { client: c, calls } = client([
      { status: 500, body: { errors: [{ message: 'boom' }] } },
      { status: 200, body: { itemSummaries: [item()] } },
    ]);

    const result = await c.searchActiveListings({ q: 'x' });
    expect(calls).toHaveLength(2);
    expect(result.activeCount).toBe(1);
  });

  it('does not retry a 400', async () => {
    const { client: c, calls } = client([{ status: 400, body: { errors: [{ message: 'bad' }] } }]);

    await expect(c.searchActiveListings({ q: 'x' })).rejects.toThrow(BrowseApiError);
    expect(calls).toHaveLength(1);
  });
});
