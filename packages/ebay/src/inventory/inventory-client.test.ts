import { describe, expect, it, vi } from 'vitest';
import { EbayApiError, EbayInventoryClient, type InventoryItemPayload } from './inventory-client';
import { DryRunGuard, type AdminApproval, type GuardConfig } from '../guard/dry-run-guard';
import { decryptToken, encryptToken, maskToken, TokenEncryptionError } from '../auth/token-crypto';
import { EbayAuthError, EbayOAuthClient, isAccessTokenUsable } from '../auth/oauth';

const KEY = Buffer.alloc(32, 7).toString('base64');

const guardConfig = (over: Partial<GuardConfig> = {}): GuardConfig => ({
  environment: 'SANDBOX',
  dryRun: false,
  allowProductionPublish: true,
  maxPublishPerRun: 5,
  ...over,
});

const approval = (over: Partial<AdminApproval> = {}): AdminApproval => ({
  catalogProductId: 'product-1',
  approvedBy: 'admin@example.com',
  approvedAt: new Date().toISOString(),
  environment: 'SANDBOX',
  payloadHash: 'abc',
  ...over,
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const client = (fetchImpl: typeof fetch, guard: DryRunGuard) =>
  new EbayInventoryClient({
    apiBaseUrl: 'https://api.sandbox.ebay.com',
    getAccessToken: async () => 'test-access-token',
    marketplaceId: 'EBAY_US',
    guard,
    fetchImpl,
  });

const item = (): InventoryItemPayload => ({
  sku: 'CB-SV2A-201165-JP-PSA10-ABCD1234',
  condition: '2750',
  conditionDescriptors: [
    { name: '27501', values: ['275010'] },
    { name: '27502', values: ['275020'] },
  ],
  availability: { shipToLocationAvailability: { quantity: 1 } },
  product: {
    title: '2023 Pokemon Japanese Charizard ex 201/165 PSA 10 GEM MINT',
    description: 'A graded card.',
    aspects: { Game: ['Pokémon TCG'] },
    imageUrls: ['https://example.test/a.jpg'],
  },
});

describe('token encryption', () => {
  it('round-trips a token', () => {
    const token = 'v^1.1#i^1#f^0#r^1#I^3#p^3#t^Ul4x';
    expect(decryptToken(encryptToken(token, KEY), KEY)).toBe(token);
  });

  it('produces a different ciphertext each time', () => {
    // A fixed IV would leak that two sellers share a token.
    expect(encryptToken('same', KEY)).not.toBe(encryptToken('same', KEY));
  });

  it('refuses a tampered ciphertext rather than returning garbage', () => {
    const encrypted = encryptToken('secret-token', KEY);
    const [iv, , tag] = encrypted.split('.');
    const tampered = [iv, Buffer.from('evil').toString('base64'), tag].join('.');
    expect(() => decryptToken(tampered, KEY)).toThrow(TokenEncryptionError);
  });

  it('refuses the wrong key', () => {
    const other = Buffer.alloc(32, 9).toString('base64');
    expect(() => decryptToken(encryptToken('secret', KEY), other)).toThrow(
      /tampered|authentication/,
    );
  });

  it('rejects a key of the wrong length', () => {
    expect(() => encryptToken('x', Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('refuses to encrypt nothing', () => {
    expect(() => encryptToken('', KEY)).toThrow();
  });

  it('masks tokens for logging', () => {
    expect(maskToken('v^1.1#i^1#f^0#r^1#abcdef')).not.toContain('1#f^0#r^1#');
    expect(maskToken('short')).toBe('***');
  });
});

describe('OAuth', () => {
  const oauth = (fetchImpl: typeof fetch) =>
    new EbayOAuthClient({
      environment: 'SANDBOX',
      appId: 'app-id',
      certId: 'cert-id',
      redirectUri: 'Some-RuName-SBX-abc',
      fetchImpl,
    });

  it('requires unguessable state on the authorization URL', () => {
    const c = oauth(vi.fn() as unknown as typeof fetch);
    expect(() => c.buildAuthorizationUrl('short')).toThrow(/state/);
    expect(() => c.buildAuthorizationUrl('a'.repeat(32))).not.toThrow();
  });

  it('requests exactly the scopes the application needs', () => {
    const c = oauth(vi.fn() as unknown as typeof fetch);
    const url = new URL(c.buildAuthorizationUrl('a'.repeat(32)));
    const scope = url.searchParams.get('scope') ?? '';

    expect(scope).toContain('sell.inventory');
    expect(scope).toContain('sell.account');
    // Marketplace Insights is a Limited Release we cannot use; asking for it
    // only makes the consent screen scarier.
    expect(scope).not.toContain('buy.marketplace.insights');
  });

  it('uses the sandbox host for sandbox', () => {
    const c = oauth(vi.fn() as unknown as typeof fetch);
    expect(c.buildAuthorizationUrl('a'.repeat(32))).toContain('auth.sandbox.ebay.com');
    expect(c.apiBaseUrl).toBe('https://api.sandbox.ebay.com');
  });

  it('exchanges a code for tokens', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 7200,
        refresh_token_expires_in: 47304000,
        scope: 'https://api.ebay.com/oauth/api_scope/sell.inventory',
      }),
    );

    const tokens = await oauth(fetchImpl as unknown as typeof fetch).exchangeCode('code-abc');
    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('keeps the existing refresh token when eBay omits it on refresh', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: 'access-2', expires_in: 7200 }));

    const tokens = await oauth(fetchImpl as unknown as typeof fetch).refreshUserToken('refresh-1');
    expect(tokens.refreshToken).toBe('refresh-1');
  });

  it('surfaces eBay error descriptions without echoing the token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: 'invalid_grant', error_description: 'the code has expired' }, 400),
      );

    await expect(oauth(fetchImpl as unknown as typeof fetch).exchangeCode('stale')).rejects.toThrow(
      /the code has expired/,
    );
  });

  it('treats a nearly-expired access token as unusable', () => {
    expect(
      isAccessTokenUsable({
        refreshTokenEnc: 'x',
        accessTokenEnc: 'y',
        // Inside the safety margin: a long job would expire mid-run.
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
        refreshTokenExpiresAt: null,
        scopes: [],
      }),
    ).toBe(false);
  });

  it('rejects a token response with no access token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ token_type: 'Bearer' }));
    await expect(oauth(fetchImpl as unknown as typeof fetch).getApplicationToken()).rejects.toThrow(
      EbayAuthError,
    );
  });
});

describe('EbayInventoryClient — mutations cannot bypass the guard', () => {
  it('does not call eBay in dry run, for any mutation', async () => {
    const fetchImpl = vi.fn();
    const guard = new DryRunGuard(guardConfig({ dryRun: true }));
    const c = client(fetchImpl as unknown as typeof fetch, guard);

    await c.createOrReplaceInventoryItem('product-1', item());
    await c.createOffer('product-1', {} as never);
    await c.publishOffer('product-1', 'offer-1');
    await c.updatePrice('product-1', 'offer-1', { value: '150', currency: 'USD' });
    await c.updateQuantity('product-1', 'sku-1', 0);
    await c.withdrawOffer('product-1', 'offer-1');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(guard.getSimulatedCalls()).toHaveLength(6);
  });

  it('records the payload that would have been sent', async () => {
    const guard = new DryRunGuard(guardConfig({ dryRun: true }));
    const c = client(vi.fn() as unknown as typeof fetch, guard);

    const payload = item();
    await c.createOrReplaceInventoryItem('product-1', payload);

    const [call] = guard.getSimulatedCalls();
    expect(call?.operation).toBe('CREATE_INVENTORY_ITEM');
    expect((call?.payload as InventoryItemPayload).sku).toBe(payload.sku);
  });

  it('executes a mutation carrying a valid authorization', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ listingId: 'L-1' }));
    const guard = new DryRunGuard(guardConfig());
    const c = client(fetchImpl as unknown as typeof fetch, guard);

    const auth = guard.authorizePublish('PUBLISH_OFFER', 'product-1', approval());
    const outcome = await c.publishOffer('product-1', 'offer-1', auth);

    expect(outcome.executed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('lets reads through without an authorization', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ sku: 'sku-1' }));
    const guard = new DryRunGuard(guardConfig({ dryRun: true }));

    const result = await client(fetchImpl as unknown as typeof fetch, guard).getInventoryItem(
      'sku-1',
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result).toEqual({ sku: 'sku-1' });
  });

  it('refuses a negative quantity before it reaches the guard', async () => {
    const guard = new DryRunGuard(guardConfig({ dryRun: true }));
    const c = client(vi.fn() as unknown as typeof fetch, guard);
    await expect(c.updateQuantity('product-1', 'sku-1', -1)).rejects.toThrow(/negative/);
  });
});

describe('EbayInventoryClient — transport', () => {
  const authorized = () => {
    const guard = new DryRunGuard(guardConfig());
    return { guard, auth: guard.authorizePublish('PUBLISH_OFFER', 'product-1', approval()) };
  };

  it('sends an idempotency key on publish', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ listingId: 'L-1' }));
    const { guard, auth } = authorized();

    await client(fetchImpl as unknown as typeof fetch, guard).publishOffer(
      'product-1',
      'offer-1',
      auth,
    );

    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-EBAY-C-IDEMPOTENCY-KEY']).toBe('publish-offer-1');
  });

  it('derives the idempotency key from the operation, so a retry reuses it', async () => {
    // A fresh Response per call: a body can only be consumed once.
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse({ listingId: 'L-1' }));
    const { guard, auth } = authorized();
    const c = client(fetchImpl as unknown as typeof fetch, guard);

    await c.publishOffer('product-1', 'offer-1', auth);
    const auth2 = guard.authorizePublish('PUBLISH_OFFER', 'product-1', approval());
    await c.publishOffer('product-1', 'offer-1', auth2);

    const first = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    const second = (fetchImpl.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>;
    expect(first['X-EBAY-C-IDEMPOTENCY-KEY']).toBe(second['X-EBAY-C-IDEMPOTENCY-KEY']);
  });

  it('sets the marketplace header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ sku: 'x' }));
    const guard = new DryRunGuard(guardConfig({ dryRun: true }));

    await client(fetchImpl as unknown as typeof fetch, guard).getInventoryItem('sku-1');
    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_US');
    expect(headers.Authorization).toBe('Bearer test-access-token');
  });

  it('surfaces eBay error details rather than a bare status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          errors: [
            { errorId: 25002, longMessage: 'A user error has occurred. SKU already exists.' },
          ],
        },
        400,
      ),
    );
    const guard = new DryRunGuard(guardConfig({ dryRun: true }));

    await expect(
      client(fetchImpl as unknown as typeof fetch, guard).getInventoryItem('sku-1'),
    ).rejects.toThrow(/25002.*SKU already exists/);
  });

  it('retries a 500 and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ errors: [] }, 500))
      .mockResolvedValueOnce(jsonResponse({ sku: 'x' }));
    const guard = new DryRunGuard(guardConfig({ dryRun: true }));

    const result = await client(fetchImpl as unknown as typeof fetch, guard).getInventoryItem('s');
    expect(result).toEqual({ sku: 'x' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400 — the request itself is wrong', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ errors: [] }, 400));
    const guard = new DryRunGuard(guardConfig({ dryRun: true }));

    await expect(
      client(fetchImpl as unknown as typeof fetch, guard).getInventoryItem('s'),
    ).rejects.toThrow(EbayApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats 204 as success with no body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const { guard, auth: _ } = authorized();
    const priceAuth = guard.authorizePublish('UPDATE_PRICE', 'product-1', approval());

    const outcome = await client(fetchImpl as unknown as typeof fetch, guard).updatePrice(
      'product-1',
      'offer-1',
      { value: '150', currency: 'USD' },
      priceAuth,
    );
    expect(outcome.executed).toBe(true);
  });

  it('fetches a fresh token per request, so a mid-batch refresh is picked up', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse({ sku: 'x' }));
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('token-2');

    const c = new EbayInventoryClient({
      apiBaseUrl: 'https://api.sandbox.ebay.com',
      getAccessToken,
      marketplaceId: 'EBAY_US',
      guard: new DryRunGuard(guardConfig({ dryRun: true })),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await c.getInventoryItem('a');
    await c.getInventoryItem('b');

    const first = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    const second = (fetchImpl.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>;
    expect(first.Authorization).toBe('Bearer token-1');
    expect(second.Authorization).toBe('Bearer token-2');
  });
});
