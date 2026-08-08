import { describe, expect, it, vi } from 'vitest';
import { EbayMetadataClient, MetadataApiError } from './metadata-client';

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let index = 0;

  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const spec = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify(spec.body), { status: spec.status });
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

function build(responses: Array<{ status: number; body: unknown }>) {
  const { impl, calls } = fakeFetch(responses);
  return {
    calls,
    client: new EbayMetadataClient({
      apiBaseUrl: 'https://api.sandbox.ebay.com',
      getAccessToken: async () => 'app-token',
      marketplaceId: 'EBAY_US',
      fetchImpl: impl,
    }),
  };
}

const ASPECTS_BODY = {
  aspects: [
    {
      localizedAspectName: 'Grade',
      aspectConstraint: {
        aspectRequired: true,
        aspectMode: 'SELECTION_ONLY',
        itemToAspectCardinality: 'SINGLE',
      },
      aspectValues: [{ localizedValue: '10' }, { localizedValue: '9' }],
    },
    {
      localizedAspectName: 'Card Name',
      aspectConstraint: {
        aspectRequired: false,
        aspectMode: 'FREE_TEXT',
        aspectMaxLength: 65,
        itemToAspectCardinality: 'MULTI',
      },
    },
  ],
};

describe('condition policies', () => {
  it('builds the category filter eBay expects', async () => {
    const { client, calls } = build([{ status: 200, body: { itemConditionPolicies: [] } }]);
    await client.getItemConditionPolicies(['183050', '183454']);

    expect(decodeURIComponent(calls[0]!.url)).toContain('categoryIds:{183050|183454}');
    expect(calls[0]!.url).toContain('/sell/metadata/v1/marketplace/EBAY_US');
  });

  it('refuses an empty category list rather than fetching everything', async () => {
    const { client, calls } = build([{ status: 200, body: {} }]);
    await expect(client.getItemConditionPolicies([])).rejects.toThrow(MetadataApiError);
    expect(calls).toHaveLength(0);
  });

  it('returns the policy payload untouched, for the resolver to interpret', async () => {
    const body = {
      itemConditionPolicies: [
        {
          categoryId: '183050',
          itemConditions: [{ conditionId: '2750', conditionDescription: 'Graded' }],
        },
      ],
    };
    const { client } = build([{ status: 200, body }]);
    expect(await client.getItemConditionPolicies(['183050'])).toEqual(body);
  });

  it('sends the application token and marketplace header', async () => {
    const { client, calls } = build([{ status: 200, body: {} }]);
    await client.getItemConditionPolicies(['183050']);

    expect(calls[0]!.headers['Authorization']).toBe('Bearer app-token');
    expect(calls[0]!.headers['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_US');
  });
});

describe('category tree', () => {
  it('reads the default tree id for the marketplace', async () => {
    const { client, calls } = build([{ status: 200, body: { categoryTreeId: '0' } }]);
    expect(await client.getDefaultCategoryTreeId()).toBe('0');
    expect(calls[0]!.url).toContain('marketplace_id=EBAY_US');
  });

  it('throws when eBay returns no tree id', async () => {
    const { client } = build([{ status: 200, body: {} }]);
    await expect(client.getDefaultCategoryTreeId()).rejects.toThrow(/no categoryTreeId/);
  });

  // Assuming tree 0 would return plausible aspects for the wrong marketplace,
  // and wrong Item Specifics are much harder to notice than a missing call.
  it('refuses to guess the tree id rather than defaulting to the US tree', async () => {
    const { client, calls } = build([{ status: 200, body: ASPECTS_BODY }]);

    await expect(client.getCategoryAspects('183050')).rejects.toThrow(/getDefaultCategoryTreeId/);
    expect(calls).toHaveLength(0);
  });

  it('accepts a persisted tree id, skipping the round trip', async () => {
    const { client, calls } = build([{ status: 200, body: ASPECTS_BODY }]);
    client.setCategoryTreeId('0');

    await client.getCategoryAspects('183050');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/category_tree/0/');
  });
});

describe('category aspects', () => {
  async function aspects() {
    const { client } = build([{ status: 200, body: ASPECTS_BODY }]);
    client.setCategoryTreeId('0');
    return client.getCategoryAspects('183050');
  }

  it('normalises name, requiredness and values', async () => {
    const result = await aspects();
    const grade = result.find((a) => a.name === 'Grade')!;

    expect(grade.required).toBe(true);
    expect(grade.values).toEqual(['10', '9']);
    expect(grade.cardinality).toBe('SINGLE');
  });

  // Sending free text to a SELECTION_ONLY aspect is a hard rejection at
  // publish, not a warning, so the distinction has to survive normalisation.
  it('distinguishes SELECTION_ONLY from free text', async () => {
    const result = await aspects();

    expect(result.find((a) => a.name === 'Grade')!.selectionOnly).toBe(true);
    expect(result.find((a) => a.name === 'Card Name')!.selectionOnly).toBe(false);
  });

  it('carries the max length for free-text aspects', async () => {
    const result = await aspects();
    expect(result.find((a) => a.name === 'Card Name')!.maxLength).toBe(65);
  });

  it('reports MULTI cardinality when the category allows it', async () => {
    const result = await aspects();
    expect(result.find((a) => a.name === 'Card Name')!.cardinality).toBe('MULTI');
  });

  it('gives free-text aspects an empty value list rather than undefined', async () => {
    const result = await aspects();
    expect(result.find((a) => a.name === 'Card Name')!.values).toEqual([]);
  });

  it('drops aspects with no name instead of emitting a nameless entry', async () => {
    const { client } = build([
      { status: 200, body: { aspects: [{ aspectConstraint: { aspectRequired: true } }] } },
    ]);
    client.setCategoryTreeId('0');

    expect(await client.getCategoryAspects('183050')).toEqual([]);
  });

  it('treats a missing aspects array as no aspects', async () => {
    const { client } = build([{ status: 200, body: {} }]);
    client.setCategoryTreeId('0');
    expect(await client.getCategoryAspects('183050')).toEqual([]);
  });
});

describe('transport', () => {
  it('retries a 429 and then succeeds', async () => {
    const { client, calls } = build([
      { status: 429, body: { errors: [{ message: 'slow down' }] } },
      { status: 200, body: { itemConditionPolicies: [] } },
    ]);

    await client.getItemConditionPolicies(['183050']);
    expect(calls).toHaveLength(2);
  });

  it('does not retry a 404', async () => {
    const { client, calls } = build([
      { status: 404, body: { errors: [{ errorId: 11001, message: 'not found' }] } },
    ]);

    await expect(client.getItemConditionPolicies(['183050'])).rejects.toThrow(/11001/);
    expect(calls).toHaveLength(1);
  });

  it('surfaces eBay’s own error message', async () => {
    const { client } = build([
      { status: 400, body: { errors: [{ errorId: 2004, message: 'invalid filter' }] } },
    ]);

    await expect(client.getItemConditionPolicies(['183050'])).rejects.toThrow(/invalid filter/);
  });
});
