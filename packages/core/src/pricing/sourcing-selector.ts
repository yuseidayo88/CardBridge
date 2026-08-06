import { Money } from '../types/money';
import type { StockStatus } from '../types/supplier';

/**
 * Choosing which shop to buy from.
 *
 * The naive answer — cheapest sticker price — is wrong often enough to matter.
 * A card that is JPY 200 cheaper at a shop that charges JPY 800 more for
 * domestic shipping, takes a week longer, and cancels one order in twenty is
 * the worse purchase. So the comparison is on *effective landed cost*, with
 * lead time and cancellation risk priced in rather than mentioned in a note.
 *
 * MVP scope: this recommends, it does not order. The output is what the admin
 * screen shows next to "recommended supplier".
 */

export interface SourcingOption {
  supplierId: string;
  supplierCode: string;
  supplierProductId: string;
  priceInclTaxJpy: string;
  domesticShippingJpy: string;
  handlingFeeJpy: string;
  leadTimeDays: number;
  /** 0..1. Share of orders from this shop that actually ship. */
  reliabilityScore: number;
  /** Admin-set tiebreaker, higher wins. */
  trustScore: number;
  stockStatus: StockStatus;
  /** Null when the shop publishes only in/out of stock. */
  stockQty: number | null;
  safetyStock: number;
}

export interface SourcingWeights {
  /** JPY charged per day of lead time. */
  leadTimeCostPerDayJpy: string;
  /**
   * How hard to penalise unreliability. The penalty is
   * (1 - reliability) x price x this multiplier — i.e. the expected cost of
   * the order falling through, scaled by how much is at stake.
   */
  cancellationRiskMultiplier: string;
}

export const DEFAULT_SOURCING_WEIGHTS: SourcingWeights = {
  leadTimeCostPerDayJpy: '50',
  cancellationRiskMultiplier: '1',
};

export interface EvaluatedOption {
  option: SourcingOption;
  /** Cash actually leaving the account. */
  landedCostJpy: Money;
  /** Landed cost plus the priced-in lead time and cancellation risk. */
  effectiveCostJpy: Money;
  leadTimePenaltyJpy: Money;
  riskPenaltyJpy: Money;
  /** Units we are willing to expose on eBay from this shop. */
  availableStock: number;
  purchasable: boolean;
  reasons: string[];
}

export interface SourcingRecommendation {
  /** Null when nothing is purchasable. */
  recommended: EvaluatedOption | null;
  /** Every option, ranked, including the unpurchasable ones with reasons. */
  alternatives: EvaluatedOption[];
  /** eBay quantity implied by the whole set of options. */
  ebayQuantity: number;
}

/**
 * Sellable stock from one shop.
 *
 * When a shop publishes no count, the answer is 1 and never more. The shop
 * saying "in stock" tells us one is probably there; inferring a number from it
 * would be inventing data, and overselling a card we cannot buy means a
 * cancellation and a defect on the eBay account.
 */
export function availableStockFor(option: SourcingOption): number {
  if (option.stockStatus !== 'IN_STOCK') return 0;
  if (option.stockQty === null) return 1;
  // eslint-disable-next-line no-restricted-syntax -- integer unit counts, not money
  return Math.max(0, option.stockQty - option.safetyStock);
}

export function evaluateOption(
  option: SourcingOption,
  weights: SourcingWeights = DEFAULT_SOURCING_WEIGHTS,
): EvaluatedOption {
  const reasons: string[] = [];

  const price = Money.fromString(option.priceInclTaxJpy, 'JPY');
  const shipping = Money.fromString(option.domesticShippingJpy, 'JPY');
  const handling = Money.fromString(option.handlingFeeJpy, 'JPY');
  const landedCostJpy = price.plus(shipping).plus(handling);

  const leadTimePenaltyJpy = Money.fromString(weights.leadTimeCostPerDayJpy, 'JPY').times(
    option.leadTimeDays,
  );

  // Expected loss from the order not completing, proportional to what is at
  // stake. A 5% failure rate on a JPY 100,000 card is a far bigger problem
  // than the same rate on a JPY 3,000 card.
  // eslint-disable-next-line no-restricted-syntax -- clamping a dimensionless 0..1 ratio; the money multiplication below uses Money
  const unreliability = Math.max(0, Math.min(1, 1 - option.reliabilityScore));
  const riskPenaltyJpy = landedCostJpy
    .times(unreliability.toFixed(6))
    .times(weights.cancellationRiskMultiplier);

  const effectiveCostJpy = landedCostJpy.plus(leadTimePenaltyJpy).plus(riskPenaltyJpy);
  const availableStock = availableStockFor(option);

  if (option.stockStatus === 'OUT_OF_STOCK') reasons.push('out of stock');
  if (option.stockStatus === 'UNKNOWN') reasons.push('stock status could not be determined');
  if (option.stockStatus === 'IN_STOCK' && availableStock === 0) {
    reasons.push(`all ${option.stockQty ?? 0} units are held back as safety stock`);
  }
  if (price.isZero()) reasons.push('price is zero — probably a parse failure');

  return {
    option,
    landedCostJpy,
    effectiveCostJpy,
    leadTimePenaltyJpy,
    riskPenaltyJpy,
    availableStock,
    purchasable: availableStock > 0 && !price.isZero(),
    reasons,
  };
}

export function recommendSupplier(
  options: SourcingOption[],
  weights: SourcingWeights = DEFAULT_SOURCING_WEIGHTS,
  maxEbayQuantity = 1,
): SourcingRecommendation {
  const evaluated = options.map((o) => evaluateOption(o, weights));

  const ranked = [...evaluated].sort((a, b) => {
    // Purchasable options always outrank unpurchasable ones.
    if (a.purchasable !== b.purchasable) return a.purchasable ? -1 : 1;

    if (a.effectiveCostJpy.equals(b.effectiveCostJpy)) {
      // Admin-configurable tiebreaker, then the faster shop.
      if (a.option.trustScore !== b.option.trustScore) {
        return b.option.trustScore - a.option.trustScore;
      }
      return a.option.leadTimeDays - b.option.leadTimeDays;
    }
    return a.effectiveCostJpy.lessThan(b.effectiveCostJpy) ? -1 : 1;
  });

  const recommended = ranked.find((e) => e.purchasable) ?? null;

  // Quantity comes from the recommended shop alone, not the sum across shops.
  // Two shops each holding one copy is not two units we can reliably sell: the
  // second sale would need a second purchase we have not verified.
  // eslint-disable-next-line no-restricted-syntax -- integer unit counts, not money
  const ebayQuantity = recommended ? Math.min(recommended.availableStock, maxEbayQuantity) : 0;

  return { recommended, alternatives: ranked, ebayQuantity };
}
