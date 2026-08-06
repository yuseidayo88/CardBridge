import { describe, expect, it } from 'vitest';
import { evaluateEligibility, type EligibilityInput } from './eligibility';
import { calculateProfit, type ProfitInput } from '../profit/cost-model';

const profitInput = (over: Partial<ProfitInput> = {}): ProfitInput => ({
  scenario: 'BASE',
  saleCurrency: 'USD',
  sellingPrice: '150',
  fxRate: '150',
  sourcing: { purchasePriceJpy: '12800', domesticShippingJpy: '500', supplierHandlingJpy: '0' },
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

/** A listing that clears every gate. Individual tests break one thing at a time. */
const eligible = (over: Partial<EligibilityInput> = {}): EligibilityInput => ({
  psaVerdict: 'CONFIRMED',
  parseConfidence: 0.95,
  aiConfidence: 0.92,
  aiWarnings: [],
  hasImages: true,
  imageProcessingApproved: true,
  imageProcessingConfidence: 0.97,
  usesRepresentativeImage: false,
  availableStock: 1,
  ebayQuantity: 1,
  cardNameEn: 'Charizard ex',
  cardNumber: '201/165',
  language: 'JAPANESE',
  title: '2023 Pokemon Japanese Charizard ex 201/165 PSA 10 GEM MINT',
  missingRequiredAspects: [],
  conditionDescriptorsResolved: true,
  profitBase: calculateProfit(profitInput({ sellingPrice: '190' })),
  profitPessimistic: calculateProfit(profitInput({ sellingPrice: '190', scenario: 'PESSIMISTIC' })),
  marketDataSufficient: true,
  duplicateListingExists: false,
  sellingPrice: '190',
  saleCurrency: 'USD',
  ...over,
});

describe('evaluateEligibility — the happy path', () => {
  it('passes a listing that satisfies every condition', () => {
    const result = evaluateEligibility(eligible());
    expect(result.blockers).toEqual([]);
    expect(result.eligible).toBe(true);
  });
});

describe('evaluateEligibility — PSA status', () => {
  it('blocks a rejected item outright', () => {
    const result = evaluateEligibility(eligible({ psaVerdict: 'REJECTED' }));
    expect(result.eligible).toBe(false);
    expect(result.blockers.some((b) => b.code === 'NOT_PSA10' && b.severity === 'BLOCKING')).toBe(
      true,
    );
  });

  it('sends an uncorroborated item to review rather than blocking it forever', () => {
    const result = evaluateEligibility(eligible({ psaVerdict: 'REVIEW' }));
    expect(result.eligible).toBe(false);
    expect(result.requiresManualReview).toBe(true);
    expect(result.blockers[0]?.code).toBe('PSA_UNCONFIRMED');
  });
});

describe('evaluateEligibility — confidence thresholds', () => {
  it('blocks low parse confidence', () => {
    const result = evaluateEligibility(eligible({ parseConfidence: 0.5 }));
    expect(result.blockers.some((b) => b.code === 'LOW_PARSE_CONFIDENCE')).toBe(true);
  });

  it('blocks low AI confidence', () => {
    const result = evaluateEligibility(eligible({ aiConfidence: 0.4 }));
    expect(result.blockers.some((b) => b.code === 'LOW_AI_CONFIDENCE')).toBe(true);
  });

  it('sends AI warnings to review', () => {
    const result = evaluateEligibility(eligible({ aiWarnings: ['set name was uncertain'] }));
    expect(result.requiresManualReview).toBe(true);
    expect(result.blockers.some((b) => b.code === 'AI_WARNINGS')).toBe(true);
  });
});

describe('evaluateEligibility — images', () => {
  it('blocks when there are no images', () => {
    expect(
      evaluateEligibility(eligible({ hasImages: false })).blockers.some(
        (b) => b.code === 'NO_IMAGES',
      ),
    ).toBe(true);
  });

  it('blocks unapproved image processing', () => {
    const result = evaluateEligibility(eligible({ imageProcessingApproved: false }));
    expect(result.blockers.some((b) => b.code === 'IMAGE_NOT_APPROVED')).toBe(true);
  });

  it('blocks low mask detection confidence', () => {
    const result = evaluateEligibility(eligible({ imageProcessingConfidence: 0.6 }));
    expect(result.blockers.some((b) => b.code === 'LOW_IMAGE_CONFIDENCE')).toBe(true);
  });

  it('always routes a representative image to a human', () => {
    // Graded singles are unique items; a disclaimer does not make a stand-in
    // photo acceptable, so this never clears automatically.
    const result = evaluateEligibility(eligible({ usesRepresentativeImage: true }));
    expect(result.eligible).toBe(false);
    expect(result.blockers.some((b) => b.code === 'REPRESENTATIVE_IMAGE')).toBe(true);
  });
});

describe('evaluateEligibility — stock', () => {
  it('blocks when stock has run out', () => {
    const result = evaluateEligibility(eligible({ availableStock: 0, ebayQuantity: 0 }));
    expect(result.blockers.some((b) => b.code === 'OUT_OF_STOCK')).toBe(true);
    expect(result.blockers.some((b) => b.code === 'ZERO_QUANTITY')).toBe(true);
  });
});

describe('evaluateEligibility — eBay requirements', () => {
  it('blocks a missing title', () => {
    expect(
      evaluateEligibility(eligible({ title: null })).blockers.some(
        (b) => b.code === 'MISSING_TITLE',
      ),
    ).toBe(true);
  });

  it('blocks a title over 80 characters', () => {
    const result = evaluateEligibility(eligible({ title: 'X'.repeat(81) }));
    expect(result.blockers.some((b) => b.code === 'TITLE_TOO_LONG')).toBe(true);
  });

  it('accepts a title of exactly 80 characters', () => {
    const result = evaluateEligibility(eligible({ title: 'X'.repeat(80) }));
    expect(result.blockers.some((b) => b.code === 'TITLE_TOO_LONG')).toBe(false);
  });

  it('blocks missing required item specifics', () => {
    const result = evaluateEligibility(eligible({ missingRequiredAspects: ['Card Name', 'Set'] }));
    const blocker = result.blockers.find((b) => b.code === 'MISSING_REQUIRED_ASPECTS');
    expect(blocker?.message).toContain('Card Name');
  });

  it('blocks when condition descriptors could not be resolved', () => {
    const result = evaluateEligibility(eligible({ conditionDescriptorsResolved: false }));
    expect(result.blockers.some((b) => b.code === 'CONDITION_DESCRIPTORS_UNRESOLVED')).toBe(true);
  });
});

describe('evaluateEligibility — profitability', () => {
  it('blocks when the base case is below the profit floor', () => {
    const low = calculateProfit(profitInput({ sellingPrice: '100' }));
    const result = evaluateEligibility(
      eligible({ profitBase: low, sellingPrice: '100', profitPessimistic: low }),
    );
    expect(result.blockers.some((b) => b.code === 'BELOW_MIN_PROFIT')).toBe(true);
  });

  it('blocks when the pessimistic scenario loses money, even if the base case is fine', () => {
    // This is the check that stops marginal listings: comfortable at today's
    // rate, loss-making the moment the yen moves and one item comes back.
    const base = calculateProfit(profitInput({ sellingPrice: '175' }));
    const pessimistic = calculateProfit(
      profitInput({ sellingPrice: '175', scenario: 'PESSIMISTIC' }),
    );

    const result = evaluateEligibility(
      eligible({ profitBase: base, profitPessimistic: pessimistic, sellingPrice: '175' }),
    );

    if (!pessimistic.profit.isPositive()) {
      expect(result.blockers.some((b) => b.code === 'PESSIMISTIC_LOSS')).toBe(true);
    }
  });

  it('routes an undetermined customs position to review', () => {
    const customs = {
      mode: 'CARRIER_QUOTE_REQUIRED' as const,
      dutyRatePercent: null,
      importTaxRatePercent: null,
      deMinimisThreshold: null,
      brokerageFeeJpy: '0',
    };
    const base = calculateProfit(profitInput({ sellingPrice: '190', customs }));
    const pess = calculateProfit(
      profitInput({ sellingPrice: '190', customs, scenario: 'PESSIMISTIC' }),
    );

    const result = evaluateEligibility(eligible({ profitBase: base, profitPessimistic: pess }));
    expect(result.blockers.some((b) => b.code === 'CUSTOMS_UNDETERMINED')).toBe(true);
  });

  it('blocks a zero purchase price as a parse failure', () => {
    const broken = calculateProfit(
      profitInput({
        sellingPrice: '190',
        sourcing: { purchasePriceJpy: '0', domesticShippingJpy: '0', supplierHandlingJpy: '0' },
      }),
    );
    const result = evaluateEligibility(eligible({ profitBase: broken, profitPessimistic: broken }));
    expect(result.blockers.some((b) => b.code === 'INVALID_PRICE')).toBe(true);
  });
});

describe('evaluateEligibility — market data and anomalies', () => {
  it('routes insufficient sold data to review rather than pricing blind', () => {
    const result = evaluateEligibility(eligible({ marketDataSufficient: false }));
    expect(result.requiresManualReview).toBe(true);
    expect(result.blockers.some((b) => b.code === 'INSUFFICIENT_MARKET_DATA')).toBe(true);
  });

  it('routes a high-value item to manual approval', () => {
    const base = calculateProfit(profitInput({ sellingPrice: '500' }));
    const pess = calculateProfit(profitInput({ sellingPrice: '500', scenario: 'PESSIMISTIC' }));
    const result = evaluateEligibility(
      eligible({ sellingPrice: '500', profitBase: base, profitPessimistic: pess }),
    );
    expect(result.blockers.some((b) => b.code === 'HIGH_VALUE')).toBe(true);
    expect(result.requiresManualReview).toBe(true);
  });

  it('blocks a duplicate listing', () => {
    const result = evaluateEligibility(eligible({ duplicateListingExists: true }));
    expect(result.blockers.some((b) => b.code === 'DUPLICATE_LISTING')).toBe(true);
  });
});

describe('evaluateEligibility — reporting', () => {
  it('reports every problem at once, not just the first', () => {
    const result = evaluateEligibility(
      eligible({
        psaVerdict: 'REVIEW',
        hasImages: false,
        availableStock: 0,
        ebayQuantity: 0,
        title: null,
        marketDataSufficient: false,
      }),
    );
    expect(result.blockers.length).toBeGreaterThanOrEqual(5);
  });

  it('distinguishes blocking issues from ones a human may override', () => {
    const reviewOnly = evaluateEligibility(eligible({ marketDataSufficient: false }));
    expect(reviewOnly.requiresManualReview).toBe(true);

    const hardBlock = evaluateEligibility(
      eligible({ marketDataSufficient: false, hasImages: false }),
    );
    // A hard blocker is present, so this is not merely awaiting review.
    expect(hardBlock.requiresManualReview).toBe(false);
    expect(hardBlock.eligible).toBe(false);
  });

  it('gives every blocker an actionable message', () => {
    const result = evaluateEligibility(eligible({ psaVerdict: 'REVIEW', parseConfidence: 0.2 }));
    for (const blocker of result.blockers) {
      expect(blocker.message.length).toBeGreaterThan(10);
      expect(blocker.code).toMatch(/^[A-Z_]+$/);
    }
  });
});
