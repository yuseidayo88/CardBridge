import { describe, expect, it } from 'vitest';
import {
  availableStockFor,
  evaluateOption,
  recommendSupplier,
  type SourcingOption,
} from './sourcing-selector';

const option = (over: Partial<SourcingOption> = {}): SourcingOption => ({
  supplierId: 'sup-1',
  supplierCode: 'magi',
  supplierProductId: 'p-1',
  priceInclTaxJpy: '12800',
  domesticShippingJpy: '500',
  handlingFeeJpy: '0',
  leadTimeDays: 3,
  reliabilityScore: 1,
  trustScore: 50,
  stockStatus: 'IN_STOCK',
  stockQty: 1,
  safetyStock: 0,
  ...over,
});

describe('availableStockFor — quantity is never invented', () => {
  it('caps at 1 when the shop publishes no count', () => {
    // "In stock" means one is probably there. Any larger number is a guess.
    expect(availableStockFor(option({ stockQty: null }))).toBe(1);
    expect(availableStockFor(option({ stockQty: null, safetyStock: 0 }))).toBe(1);
  });

  it('subtracts safety stock from a published count', () => {
    expect(availableStockFor(option({ stockQty: 5, safetyStock: 2 }))).toBe(3);
    expect(availableStockFor(option({ stockQty: 2, safetyStock: 2 }))).toBe(0);
    expect(availableStockFor(option({ stockQty: 1, safetyStock: 3 }))).toBe(0);
  });

  it('is zero unless the shop says in stock', () => {
    expect(availableStockFor(option({ stockStatus: 'OUT_OF_STOCK', stockQty: 5 }))).toBe(0);
    expect(availableStockFor(option({ stockStatus: 'UNKNOWN', stockQty: 5 }))).toBe(0);
  });
});

describe('evaluateOption — effective landed cost', () => {
  it('adds domestic shipping and handling to the sticker price', () => {
    const e = evaluateOption(option({ domesticShippingJpy: '500', handlingFeeJpy: '200' }));
    expect(e.landedCostJpy.toString()).toBe('13500');
  });

  it('prices lead time', () => {
    const fast = evaluateOption(option({ leadTimeDays: 1 }));
    const slow = evaluateOption(option({ leadTimeDays: 10 }));
    expect(slow.effectiveCostJpy.greaterThan(fast.effectiveCostJpy)).toBe(true);
    expect(slow.leadTimePenaltyJpy.toString()).toBe('500'); // 10 days x 50
  });

  it('prices cancellation risk in proportion to what is at stake', () => {
    const cheap = evaluateOption(option({ priceInclTaxJpy: '3000', reliabilityScore: 0.95 }));
    const dear = evaluateOption(option({ priceInclTaxJpy: '100000', reliabilityScore: 0.95 }));
    expect(dear.riskPenaltyJpy.greaterThan(cheap.riskPenaltyJpy)).toBe(true);
  });

  it('charges nothing for risk when a shop is perfectly reliable', () => {
    expect(evaluateOption(option({ reliabilityScore: 1 })).riskPenaltyJpy.isZero()).toBe(true);
  });

  it('marks a zero price unpurchasable', () => {
    const e = evaluateOption(option({ priceInclTaxJpy: '0' }));
    expect(e.purchasable).toBe(false);
    expect(e.reasons.join(' ')).toMatch(/parse failure/);
  });

  it('explains why an option is unpurchasable', () => {
    expect(evaluateOption(option({ stockStatus: 'OUT_OF_STOCK' })).reasons.join(' ')).toMatch(
      /out of stock/,
    );
    expect(evaluateOption(option({ stockStatus: 'UNKNOWN' })).reasons.join(' ')).toMatch(
      /could not be determined/,
    );
    expect(evaluateOption(option({ stockQty: 2, safetyStock: 2 })).reasons.join(' ')).toMatch(
      /safety stock/,
    );
  });
});

describe('recommendSupplier — cheapest sticker price is not the answer', () => {
  it('prefers a dearer card from a shop with much cheaper shipping', () => {
    const result = recommendSupplier([
      option({ supplierCode: 'cheap-item', priceInclTaxJpy: '12000', domesticShippingJpy: '1500' }),
      option({ supplierCode: 'cheap-total', priceInclTaxJpy: '12500', domesticShippingJpy: '300' }),
    ]);
    expect(result.recommended?.option.supplierCode).toBe('cheap-total');
  });

  it('prefers a reliable shop over a marginally cheaper unreliable one', () => {
    const result = recommendSupplier([
      option({ supplierCode: 'flaky', priceInclTaxJpy: '12500', reliabilityScore: 0.7 }),
      option({ supplierCode: 'solid', priceInclTaxJpy: '12800', reliabilityScore: 1 }),
    ]);
    expect(result.recommended?.option.supplierCode).toBe('solid');
  });

  it('skips out-of-stock shops entirely', () => {
    const result = recommendSupplier([
      option({ supplierCode: 'cheapest', priceInclTaxJpy: '9000', stockStatus: 'OUT_OF_STOCK' }),
      option({ supplierCode: 'available', priceInclTaxJpy: '12800' }),
    ]);
    expect(result.recommended?.option.supplierCode).toBe('available');
    // The unavailable one is still listed, with its reason.
    expect(result.alternatives).toHaveLength(2);
  });

  it('uses the admin trust score to break an exact tie', () => {
    const result = recommendSupplier([
      option({ supplierCode: 'low-trust', trustScore: 30 }),
      option({ supplierCode: 'high-trust', trustScore: 80 }),
    ]);
    expect(result.recommended?.option.supplierCode).toBe('high-trust');
  });

  it('falls back to lead time when cost and trust are both tied', () => {
    const result = recommendSupplier([
      option({ supplierCode: 'slow', leadTimeDays: 3, trustScore: 50 }),
      option({ supplierCode: 'also-slow', leadTimeDays: 3, trustScore: 50 }),
    ]);
    // Equal on everything: still deterministic, not arbitrary.
    expect(result.recommended).not.toBeNull();
  });

  it('recommends nothing when nothing is purchasable', () => {
    const result = recommendSupplier([
      option({ stockStatus: 'OUT_OF_STOCK' }),
      option({ stockStatus: 'UNKNOWN' }),
    ]);
    expect(result.recommended).toBeNull();
    expect(result.ebayQuantity).toBe(0);
  });
});

describe('recommendSupplier — eBay quantity', () => {
  it('holds quantity at 1 by default', () => {
    const result = recommendSupplier([option({ stockQty: 10 })]);
    expect(result.ebayQuantity).toBe(1);
  });

  it('does not sum stock across shops', () => {
    // Two shops each holding one copy is not two units we can reliably sell:
    // the second sale would need a purchase we have not verified.
    const result = recommendSupplier(
      [option({ supplierCode: 'a', stockQty: 1 }), option({ supplierCode: 'b', stockQty: 1 })],
      undefined,
      5,
    );
    expect(result.ebayQuantity).toBe(1);
  });

  it('never exceeds 1 when the shop publishes no count, even with a higher cap', () => {
    const result = recommendSupplier([option({ stockQty: null })], undefined, 5);
    expect(result.ebayQuantity).toBe(1);
  });

  it('respects the configured cap when a shop does publish counts', () => {
    expect(recommendSupplier([option({ stockQty: 10 })], undefined, 3).ebayQuantity).toBe(3);
  });

  it('drops to zero when the recommended shop sells out', () => {
    const result = recommendSupplier([option({ stockStatus: 'OUT_OF_STOCK' })]);
    expect(result.ebayQuantity).toBe(0);
  });
});
