import { describe, expect, it } from 'vitest';
import { Money } from '../types/money';
import { calculateAllScenarios, calculateProfit, type ProfitInput } from './cost-model';
import { solveMinimumPrice } from './min-price';

/**
 * A realistic baseline: a JPY 12,800 card sold for USD 150 to the US at
 * roughly 150 JPY/USD.
 */
const baseInput = (over: Partial<ProfitInput> = {}): ProfitInput => ({
  scenario: 'BASE',
  saleCurrency: 'USD',
  sellingPrice: '150',
  fxRate: '150',
  sourcing: {
    purchasePriceJpy: '12800',
    domesticShippingJpy: '500',
    supplierHandlingJpy: '0',
  },
  fees: {
    categoryFeePercent: '13.25',
    fixedFeePerOrder: '0.40',
    internationalFeePercent: '1.65',
    adRatePercent: '2',
    fxSpreadPercent: '1.5',
    fxBufferPercent: '3',
    returnReservePercent: '2',
    packagingCostJpy: '250',
    otherCostJpy: '0',
  },
  shipping: {
    costJpy: '3500',
    buyerChargedInSaleCurrency: '15',
    signatureCostJpy: '0',
    insuranceCostJpy: '0',
    carrierSurchargeJpy: '0',
  },
  customs: {
    mode: 'BUYER_PAID',
    dutyRatePercent: null,
    importTaxRatePercent: null,
    deMinimisThreshold: null,
    brokerageFeeJpy: '0',
  },
  ...over,
});

describe('calculateProfit — completeness', () => {
  it('accounts for every cost component the requirements list', () => {
    const result = calculateProfit(baseInput());
    const costKeys = Object.keys(result.costs).filter((k) => k !== 'total');

    // If someone adds a cost to the type but forgets to sum it, this catches it.
    const summed = costKeys.reduce(
      (acc, key) => acc.plus(result.costs[key as keyof typeof result.costs] as never),
      result.costs.total.minus(result.costs.total),
    );
    expect(summed.toFixed()).toBe(result.costs.total.toFixed());
  });

  it('charges eBay fees on item price plus buyer-paid shipping', () => {
    const result = calculateProfit(baseInput());
    // 13.25% of (150 + 15) = 21.8625
    expect(result.costs.categoryFee.roundTo(4).toString()).toBe('21.8625');
  });

  it('produces a profitable base case for a healthy margin', () => {
    const result = calculateProfit(baseInput());
    expect(result.profit.isPositive()).toBe(true);
    expect(Number(result.marginPercent)).toBeGreaterThan(0);
  });

  it('reports profit in JPY as well as the sale currency', () => {
    const result = calculateProfit(baseInput());
    expect(result.profitJpy.currency).toBe('JPY');
    expect(result.profit.currency).toBe('USD');
  });
});

describe('calculateProfit — scenarios', () => {
  it('orders the three scenarios monotonically', () => {
    const s = calculateAllScenarios(baseInput());
    expect(s.OPTIMISTIC.profit.greaterThan(s.BASE.profit)).toBe(true);
    expect(s.BASE.profit.greaterThan(s.PESSIMISTIC.profit)).toBe(true);
  });

  it('models an adverse FX move in the pessimistic case', () => {
    const s = calculateAllScenarios(baseInput());
    // A weaker effective rate means our JPY costs convert to more USD.
    expect(Number(s.PESSIMISTIC.fxRate)).toBeLessThan(Number(s.BASE.fxRate));
    expect(s.PESSIMISTIC.costs.purchase.greaterThan(s.BASE.costs.purchase)).toBe(true);
  });

  it('models a shipping cost increase in the pessimistic case', () => {
    const s = calculateAllScenarios(baseInput());
    expect(
      s.PESSIMISTIC.costs.internationalShipping.greaterThan(s.BASE.costs.internationalShipping),
    ).toBe(true);
  });

  it('doubles the return reserve in the pessimistic case', () => {
    const s = calculateAllScenarios(baseInput());
    expect(s.PESSIMISTIC.costs.returnReserve.toString()).toBe(
      s.BASE.costs.returnReserve.times(2).toString(),
    );
  });

  it('warns when a scenario is loss-making', () => {
    const s = calculateProfit(baseInput({ sellingPrice: '80', scenario: 'PESSIMISTIC' }));
    expect(s.profit.isNegative()).toBe(true);
    expect(s.warnings.join(' ')).toMatch(/loss-making/);
  });
});

describe('calculateProfit — customs modes are not a single global assumption', () => {
  it('BUYER_PAID puts no duty on our side', () => {
    const result = calculateProfit(
      baseInput({ customs: { ...baseInput().customs, mode: 'BUYER_PAID' } }),
    );
    expect(result.costs.duty.isZero()).toBe(true);
    expect(result.costs.importTax.isZero()).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('SELLER_PAID charges duty and import tax to us', () => {
    const result = calculateProfit(
      baseInput({
        customs: {
          mode: 'SELLER_PAID',
          dutyRatePercent: '5',
          importTaxRatePercent: '10',
          deMinimisThreshold: null,
          brokerageFeeJpy: '1500',
        },
      }),
    );
    // duty 5% of 150 = 7.50; import tax 10% of (150 + 7.50) = 15.75
    expect(result.costs.duty.roundTo(2).toString()).toBe('7.5');
    expect(result.costs.importTax.roundTo(2).toString()).toBe('15.75');
    expect(result.costs.customsBrokerage.isPositive()).toBe(true);
  });

  it('honours a de minimis exemption under SELLER_PAID', () => {
    const customs = {
      mode: 'SELLER_PAID' as const,
      dutyRatePercent: '5',
      importTaxRatePercent: '10',
      deMinimisThreshold: '200',
      brokerageFeeJpy: '0',
    };
    const below = calculateProfit(baseInput({ sellingPrice: '150', customs }));
    const above = calculateProfit(baseInput({ sellingPrice: '250', customs }));

    expect(below.costs.duty.isZero()).toBe(true);
    expect(above.costs.duty.isPositive()).toBe(true);
  });

  it('MARKETPLACE_COLLECTED treats VAT as neither revenue nor cost', () => {
    const result = calculateProfit(
      baseInput({
        customs: {
          mode: 'MARKETPLACE_COLLECTED',
          dutyRatePercent: '0',
          importTaxRatePercent: '20',
          deMinimisThreshold: '135',
          brokerageFeeJpy: '0',
        },
      }),
    );
    expect(result.costs.importTax.isZero()).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('CARRIER_QUOTE_REQUIRED refuses to invent a duty figure', () => {
    const result = calculateProfit(
      baseInput({
        customs: {
          mode: 'CARRIER_QUOTE_REQUIRED',
          dutyRatePercent: null,
          importTaxRatePercent: null,
          deMinimisThreshold: null,
          brokerageFeeJpy: '0',
        },
      }),
    );
    expect(result.costs.duty.isZero()).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/carrier quote/);
  });

  it('MANUAL_REVIEW warns rather than guessing', () => {
    const result = calculateProfit(
      baseInput({
        customs: {
          mode: 'MANUAL_REVIEW',
          dutyRatePercent: null,
          importTaxRatePercent: null,
          deMinimisThreshold: null,
          brokerageFeeJpy: '0',
        },
      }),
    );
    expect(result.warnings.join(' ')).toMatch(/manual review/);
  });

  it('warns when SELLER_PAID has no rate configured', () => {
    const result = calculateProfit(
      baseInput({
        customs: {
          mode: 'SELLER_PAID',
          dutyRatePercent: null,
          importTaxRatePercent: null,
          deMinimisThreshold: null,
          brokerageFeeJpy: '0',
        },
      }),
    );
    expect(result.warnings.join(' ')).toMatch(/no duty or import tax rate/);
  });
});

describe('calculateProfit — data quality', () => {
  it('warns on a zero purchase price rather than reporting a huge margin', () => {
    const result = calculateProfit(
      baseInput({
        sourcing: { purchasePriceJpy: '0', domesticShippingJpy: '0', supplierHandlingJpy: '0' },
      }),
    );
    expect(result.warnings.join(' ')).toMatch(/purchase price is zero/);
  });

  it('warns on a zero selling price', () => {
    const result = calculateProfit(baseInput({ sellingPrice: '0' }));
    expect(result.warnings.join(' ')).toMatch(/selling price is zero/);
  });

  it('reflects a higher domestic shipping cost in the total', () => {
    const cheap = calculateProfit(baseInput());
    const dear = calculateProfit(
      baseInput({
        sourcing: {
          purchasePriceJpy: '12800',
          domesticShippingJpy: '2000',
          supplierHandlingJpy: '0',
        },
      }),
    );
    expect(dear.profit.lessThan(cheap.profit)).toBe(true);
  });
});

describe('solveMinimumPrice', () => {
  it('finds a price that meets both floors under the pessimistic scenario', () => {
    const result = solveMinimumPrice({
      ...baseInput(),
      minProfitJpy: '1500',
      minMarginPercent: '15',
    });

    expect(result.minimumPrice).not.toBeNull();

    const verify = calculateProfit({
      ...baseInput(),
      scenario: 'PESSIMISTIC',
      sellingPrice: result.minimumPrice!.toString(),
    });
    expect(verify.profitJpy.greaterThanOrEqual(Money.fromString('1500', 'JPY'))).toBe(true);
    expect(Number(verify.marginPercent)).toBeGreaterThanOrEqual(15);
  });

  it('returns null when no price in range can satisfy the floors', () => {
    const result = solveMinimumPrice({
      ...baseInput(),
      minProfitJpy: '1500',
      minMarginPercent: '99', // unreachable: fees alone exceed 1%
    });
    expect(result.minimumPrice).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/no price up to/);
  });

  it('requires a higher price when the profit floor rises', () => {
    const low = solveMinimumPrice({ ...baseInput(), minProfitJpy: '1500', minMarginPercent: '10' });
    const high = solveMinimumPrice({
      ...baseInput(),
      minProfitJpy: '5000',
      minMarginPercent: '10',
    });
    expect(high.minimumPrice!.greaterThan(low.minimumPrice!)).toBe(true);
  });

  it('requires a higher price when sourcing costs more', () => {
    const cheap = solveMinimumPrice({
      ...baseInput(),
      minProfitJpy: '1500',
      minMarginPercent: '10',
    });
    const dear = solveMinimumPrice({
      ...baseInput({
        sourcing: {
          purchasePriceJpy: '25000',
          domesticShippingJpy: '500',
          supplierHandlingJpy: '0',
        },
      }),
      minProfitJpy: '1500',
      minMarginPercent: '10',
    });
    expect(dear.minimumPrice!.greaterThan(cheap.minimumPrice!)).toBe(true);
  });

  it('converges quickly', () => {
    const result = solveMinimumPrice({
      ...baseInput(),
      minProfitJpy: '1500',
      minMarginPercent: '15',
    });
    expect(result.iterations).toBeLessThan(40);
  });

  it('solves against PESSIMISTIC even when a BASE input is spread in', () => {
    // baseInput() carries scenario: 'BASE'. Spreading it must NOT downgrade
    // the safety scenario — that would return a price that loses money as soon
    // as the yen moves, while looking perfectly reasonable.
    const spread = solveMinimumPrice({
      ...baseInput({ scenario: 'BASE' }),
      minProfitJpy: '1500',
      minMarginPercent: '15',
    });
    const explicit = solveMinimumPrice({
      ...baseInput(),
      scenarioOverride: 'PESSIMISTIC',
      minProfitJpy: '1500',
      minMarginPercent: '15',
    });

    expect(spread.minimumPrice!.toString()).toBe(explicit.minimumPrice!.toString());
  });

  it('returns a lower price when a weaker scenario is chosen deliberately', () => {
    const pessimistic = solveMinimumPrice({
      ...baseInput(),
      minProfitJpy: '1500',
      minMarginPercent: '15',
    });
    const optimistic = solveMinimumPrice({
      ...baseInput(),
      scenarioOverride: 'OPTIMISTIC',
      minProfitJpy: '1500',
      minMarginPercent: '15',
    });
    expect(optimistic.minimumPrice!.lessThan(pessimistic.minimumPrice!)).toBe(true);
  });
});
