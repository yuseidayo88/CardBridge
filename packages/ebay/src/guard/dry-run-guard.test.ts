import { describe, expect, it, vi } from 'vitest';
import {
  DryRunGuard,
  PublishBlockedError,
  loadGuardConfig,
  type AdminApproval,
  type GuardConfig,
} from './dry-run-guard';

const approval = (over: Partial<AdminApproval> = {}): AdminApproval => ({
  catalogProductId: 'product-1',
  approvedBy: 'admin@example.com',
  approvedAt: '2026-08-06T00:00:00.000Z',
  environment: 'PRODUCTION',
  payloadHash: 'abc123',
  ...over,
});

const config = (over: Partial<GuardConfig> = {}): GuardConfig => ({
  environment: 'PRODUCTION',
  dryRun: false,
  allowProductionPublish: true,
  maxPublishPerRun: 5,
  ...over,
});

describe('loadGuardConfig', () => {
  it('defaults to the safe state when nothing is set', () => {
    const c = loadGuardConfig({});
    expect(c.dryRun).toBe(true);
    expect(c.allowProductionPublish).toBe(false);
    expect(c.environment).toBe('SANDBOX');
  });

  it('only "false" disables dry run', () => {
    expect(loadGuardConfig({ DRY_RUN: '0' }).dryRun).toBe(true);
    expect(loadGuardConfig({ DRY_RUN: 'no' }).dryRun).toBe(true);
    expect(loadGuardConfig({ DRY_RUN: 'FALSE' }).dryRun).toBe(true);
    expect(loadGuardConfig({ DRY_RUN: 'false' }).dryRun).toBe(false);
  });

  it('falls back to SANDBOX for an unrecognised environment', () => {
    expect(loadGuardConfig({ EBAY_ENV: 'prod' }).environment).toBe('SANDBOX');
  });
});

describe('DryRunGuard — the production API is never called in dry run', () => {
  it('does not invoke the API function at all when dry run is on', async () => {
    const guard = new DryRunGuard(config({ dryRun: true }));
    const apiCall = vi.fn().mockResolvedValue({ listingId: 'should-never-happen' });

    const outcome = await guard.execute('PUBLISH_OFFER', 'product-1', { sku: 'X' }, apiCall);

    expect(apiCall).not.toHaveBeenCalled();
    expect(outcome.executed).toBe(false);
    expect(outcome.simulated).toBe(true);
    if (!outcome.executed) {
      expect(outcome.reason).toContain('DRY_RUN');
    }
  });

  it('records what would have been sent, for the preview UI', async () => {
    const guard = new DryRunGuard(config({ dryRun: true }));
    const payload = { sku: 'CB-001', price: '120.00' };

    await guard.execute('PUBLISH_OFFER', 'product-1', payload, vi.fn());
    await guard.execute('UPDATE_PRICE', 'product-2', { price: '99' }, vi.fn());

    const calls = guard.getSimulatedCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.payload).toEqual(payload);
    expect(calls[1]?.operation).toBe('UPDATE_PRICE');
  });

  it('still allows reads while in dry run', async () => {
    const guard = new DryRunGuard(config({ dryRun: true }));
    const apiCall = vi.fn().mockResolvedValue({ items: [] });

    const outcome = await guard.execute('READ', 'product-1', {}, apiCall);

    expect(apiCall).toHaveBeenCalledOnce();
    expect(outcome.executed).toBe(true);
  });
});

describe('DryRunGuard — authorization cannot be bypassed', () => {
  it('simulates a mutation submitted without an authorization', async () => {
    const guard = new DryRunGuard(config());
    const apiCall = vi.fn();

    const outcome = await guard.execute('PUBLISH_OFFER', 'product-1', {}, apiCall);

    expect(apiCall).not.toHaveBeenCalled();
    expect(outcome.executed).toBe(false);
  });

  it('executes with a valid authorization', async () => {
    const guard = new DryRunGuard(config());
    const apiCall = vi.fn().mockResolvedValue({ listingId: 'L1' });
    const auth = guard.authorizePublish('PUBLISH_OFFER', 'product-1', approval());

    const outcome = await guard.execute('PUBLISH_OFFER', 'product-1', {}, apiCall, auth);

    expect(apiCall).toHaveBeenCalledOnce();
    expect(outcome.executed).toBe(true);
  });

  it('rejects an authorization minted for a different product', async () => {
    const guard = new DryRunGuard(config());
    const apiCall = vi.fn();
    const auth = guard.authorizePublish('PUBLISH_OFFER', 'product-1', approval());

    const outcome = await guard.execute('PUBLISH_OFFER', 'product-2', {}, apiCall, auth);

    expect(apiCall).not.toHaveBeenCalled();
    if (!outcome.executed) expect(outcome.reason).toContain('product-1');
  });

  it('rejects an authorization minted for a different operation', async () => {
    const guard = new DryRunGuard(config());
    const apiCall = vi.fn();
    const auth = guard.authorizePublish('UPDATE_PRICE', 'product-1', approval());

    await guard.execute('PUBLISH_OFFER', 'product-1', {}, apiCall, auth);

    expect(apiCall).not.toHaveBeenCalled();
  });

  it('does not let a Sandbox approval authorise a production publish', () => {
    const guard = new DryRunGuard(config({ environment: 'PRODUCTION' }));

    expect(() =>
      guard.authorizePublish('PUBLISH_OFFER', 'product-1', approval({ environment: 'SANDBOX' })),
    ).toThrow(PublishBlockedError);
  });

  it('requires ALLOW_PRODUCTION_PUBLISH even with an admin approval', () => {
    const guard = new DryRunGuard(config({ allowProductionPublish: false }));

    expect(() => guard.authorizePublish('PUBLISH_OFFER', 'product-1', approval())).toThrow(
      /ALLOW_PRODUCTION_PUBLISH/,
    );
  });

  it('lets Sandbox publish without the production interlock', () => {
    const guard = new DryRunGuard(
      config({ environment: 'SANDBOX', allowProductionPublish: false }),
    );

    expect(() =>
      guard.authorizePublish('PUBLISH_OFFER', 'product-1', approval({ environment: 'SANDBOX' })),
    ).not.toThrow();
  });
});

describe('DryRunGuard — run cap', () => {
  it('stops publishing past the cap', async () => {
    const guard = new DryRunGuard(config({ maxPublishPerRun: 2 }));
    const apiCall = vi.fn().mockResolvedValue({ ok: true });

    for (const id of ['p1', 'p2']) {
      const auth = guard.authorizePublish('PUBLISH_OFFER', id, approval({ catalogProductId: id }));
      await guard.execute('PUBLISH_OFFER', id, {}, apiCall, auth);
    }
    expect(apiCall).toHaveBeenCalledTimes(2);

    expect(() =>
      guard.authorizePublish('PUBLISH_OFFER', 'p3', approval({ catalogProductId: 'p3' })),
    ).toThrow(/run cap of 2/);
  });

  it('does not count non-publish mutations against the cap', async () => {
    const guard = new DryRunGuard(config({ maxPublishPerRun: 1 }));
    const apiCall = vi.fn().mockResolvedValue({ ok: true });

    for (let i = 0; i < 3; i += 1) {
      const auth = guard.authorizePublish('UPDATE_QUANTITY', 'product-1', approval());
      await guard.execute('UPDATE_QUANTITY', 'product-1', {}, apiCall, auth);
    }

    expect(apiCall).toHaveBeenCalledTimes(3);
  });
});

describe('DryRunGuard — blockReason explains itself to the UI', () => {
  it('names the specific interlock that is holding the listing back', () => {
    expect(new DryRunGuard(config({ dryRun: true })).blockReason('PUBLISH_OFFER', approval())).toBe(
      'DRY_RUN is enabled',
    );
    expect(
      new DryRunGuard(config({ allowProductionPublish: false })).blockReason(
        'PUBLISH_OFFER',
        approval(),
      ),
    ).toContain('ALLOW_PRODUCTION_PUBLISH');
    expect(new DryRunGuard(config()).blockReason('PUBLISH_OFFER', null)).toContain(
      'no admin approval',
    );
    expect(new DryRunGuard(config()).blockReason('PUBLISH_OFFER', approval())).toBeNull();
  });

  it('never blocks reads', () => {
    expect(new DryRunGuard(config({ dryRun: true })).blockReason('READ', null)).toBeNull();
  });
});
