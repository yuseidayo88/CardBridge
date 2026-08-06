import { Money, type CurrencyCode } from '../types/money';

/**
 * Profit calculation.
 *
 * This is the module that decides whether an item is worth listing, so its job
 * is to be *complete* rather than optimistic. Every cost the requirements list
 * is a named field: an omitted cost does not make a listing more profitable,
 * it makes the number wrong in the direction that loses money.
 *
 * Three properties are enforced:
 *
 *   1. No JS `number` arithmetic anywhere. All amounts are Money (decimal.js).
 *      ESLint blocks raw arithmetic in this directory.
 *   2. Currencies never mix implicitly. Purchase costs are JPY, sale proceeds
 *      are in the marketplace currency, and crossing between them requires an
 *      explicit FX rate that gets recorded in the result.
 *   3. Unknown duty is never invented. A destination whose customs mode is
 *      CARRIER_QUOTE_REQUIRED or MANUAL_REVIEW produces a warning and blocks
 *      automatic listing rather than a plausible-looking guess.
 */

export type CustomsMode =
  | 'BUYER_PAID'
  | 'SELLER_PAID'
  | 'MARKETPLACE_COLLECTED'
  | 'CARRIER_QUOTE_REQUIRED'
  | 'MANUAL_REVIEW';

export type ProfitScenario = 'OPTIMISTIC' | 'BASE' | 'PESSIMISTIC';

/** Fee rates. Every one comes from cost_profiles — none is hard-coded. */
export interface FeeProfile {
  categoryFeePercent: string;
  fixedFeePerOrder: string;
  internationalFeePercent: string;
  adRatePercent: string;
  fxSpreadPercent: string;
  fxBufferPercent: string;
  returnReservePercent: string;
  packagingCostJpy: string;
  otherCostJpy: string;
}

export interface ShippingProfile {
  /** What the carrier charges us, in JPY. */
  costJpy: string;
  /** What the buyer pays, in the sale currency. */
  buyerChargedInSaleCurrency: string;
  signatureCostJpy: string;
  insuranceCostJpy: string;
  carrierSurchargeJpy: string;
}

export interface CustomsProfile {
  mode: CustomsMode;
  /** Percent of item value. Null when the mode does not permit an estimate. */
  dutyRatePercent: string | null;
  importTaxRatePercent: string | null;
  /** Below this declared value no duty applies. Null where none exists. */
  deMinimisThreshold: string | null;
  brokerageFeeJpy: string;
}

export interface SourcingCost {
  purchasePriceJpy: string;
  domesticShippingJpy: string;
  supplierHandlingJpy: string;
}

export interface ProfitInput {
  scenario: ProfitScenario;
  saleCurrency: CurrencyCode;
  /** Listing price in the sale currency. */
  sellingPrice: string;
  /** JPY per one unit of the sale currency. */
  fxRate: string;
  sourcing: SourcingCost;
  fees: FeeProfile;
  shipping: ShippingProfile;
  customs: CustomsProfile;
}

export interface ProfitBreakdown {
  scenario: ProfitScenario;
  saleCurrency: CurrencyCode;
  customsMode: CustomsMode;

  /** All revenue components, in the sale currency. */
  revenue: {
    itemPrice: Money;
    shippingCharged: Money;
    total: Money;
  };

  /** All cost components, converted to the sale currency. */
  costs: {
    purchase: Money;
    domesticShipping: Money;
    supplierHandling: Money;
    internationalShipping: Money;
    packaging: Money;
    categoryFee: Money;
    fixedFee: Money;
    internationalFee: Money;
    adFee: Money;
    fxCost: Money;
    fxBuffer: Money;
    returnReserve: Money;
    insurance: Money;
    signature: Money;
    duty: Money;
    importTax: Money;
    customsBrokerage: Money;
    carrierSurcharge: Money;
    other: Money;
    total: Money;
  };

  profit: Money;
  profitJpy: Money;
  /** Profit as a percentage of total revenue. */
  marginPercent: string;
  fxRate: string;

  /** Anything that must block automatic listing. */
  warnings: string[];
}

/**
 * Scenario adjustments.
 *
 * The pessimistic case is the one that governs eligibility. It is not
 * arbitrary pessimism: it models the three things that actually go wrong on
 * cross-border card sales — the yen moves against us, shipping costs more than
 * quoted, and the item comes back.
 */
const SCENARIO_ADJUSTMENTS: Record<
  ProfitScenario,
  { fxAdversePercent: string; shippingIncreasePercent: string; returnMultiplier: string }
> = {
  OPTIMISTIC: { fxAdversePercent: '0', shippingIncreasePercent: '0', returnMultiplier: '0.5' },
  BASE: { fxAdversePercent: '0', shippingIncreasePercent: '0', returnMultiplier: '1' },
  PESSIMISTIC: { fxAdversePercent: '5', shippingIncreasePercent: '15', returnMultiplier: '2' },
};

export function calculateProfit(input: ProfitInput): ProfitBreakdown {
  const currency = input.saleCurrency;
  const warnings: string[] = [];
  const adjust = SCENARIO_ADJUSTMENTS[input.scenario];

  // --- FX -----------------------------------------------------------------
  //
  // The pessimistic scenario assumes a yen that has moved against us: our JPY
  // costs buy less foreign currency, so the effective rate is worse.
  const baseFxRate = Money.fromString(input.fxRate, 'JPY');
  const adverseFx = baseFxRate.minus(baseFxRate.percent(adjust.fxAdversePercent));
  const effectiveFxRate = adverseFx.toString();

  /** JPY -> sale currency at the scenario's effective rate. */
  const toSale = (jpy: Money): Money =>
    jpy.dividedBy(effectiveFxRate).convertTo(currency, '1').roundTo(6);

  // --- revenue ------------------------------------------------------------
  const itemPrice = Money.fromString(input.sellingPrice, currency);
  const shippingCharged = Money.fromString(input.shipping.buyerChargedInSaleCurrency, currency);
  const totalRevenue = itemPrice.plus(shippingCharged);

  if (itemPrice.isZero() || itemPrice.isNegative()) {
    warnings.push('selling price is zero or negative');
  }

  // --- sourcing -----------------------------------------------------------
  const purchaseJpy = Money.fromString(input.sourcing.purchasePriceJpy, 'JPY');
  if (purchaseJpy.isZero()) {
    warnings.push('purchase price is zero — this is almost certainly a parse failure');
  }

  const purchase = toSale(purchaseJpy);
  const domesticShipping = toSale(Money.fromString(input.sourcing.domesticShippingJpy, 'JPY'));
  const supplierHandling = toSale(Money.fromString(input.sourcing.supplierHandlingJpy, 'JPY'));

  // --- shipping -----------------------------------------------------------
  const baseShippingJpy = Money.fromString(input.shipping.costJpy, 'JPY');
  const shippingJpy = baseShippingJpy.plus(baseShippingJpy.percent(adjust.shippingIncreasePercent));
  const internationalShipping = toSale(shippingJpy);
  const insurance = toSale(Money.fromString(input.shipping.insuranceCostJpy, 'JPY'));
  const signature = toSale(Money.fromString(input.shipping.signatureCostJpy, 'JPY'));
  const carrierSurcharge = toSale(Money.fromString(input.shipping.carrierSurchargeJpy, 'JPY'));
  const packaging = toSale(Money.fromString(input.fees.packagingCostJpy, 'JPY'));
  const other = toSale(Money.fromString(input.fees.otherCostJpy, 'JPY'));

  // --- eBay fees ----------------------------------------------------------
  //
  // Charged on the total amount of the sale — item price plus what the buyer
  // paid for shipping — not on the item price alone. Computing them on the
  // item price is a common and expensive mistake.
  const categoryFee = totalRevenue.percent(input.fees.categoryFeePercent);
  const fixedFee = Money.fromString(input.fees.fixedFeePerOrder, currency);
  const internationalFee = totalRevenue.percent(input.fees.internationalFeePercent);
  const adFee = totalRevenue.percent(input.fees.adRatePercent);

  // --- currency conversion cost and risk reserve --------------------------
  const fxCost = totalRevenue.percent(input.fees.fxSpreadPercent);
  const fxBuffer = totalRevenue.percent(input.fees.fxBufferPercent);

  // --- return reserve -----------------------------------------------------
  const returnReserve = totalRevenue
    .percent(input.fees.returnReservePercent)
    .times(adjust.returnMultiplier);

  // --- customs ------------------------------------------------------------
  const { duty, importTax, brokerage, customsWarnings } = calculateCustoms(
    input.customs,
    itemPrice,
    currency,
    toSale,
  );
  warnings.push(...customsWarnings);

  // --- totals -------------------------------------------------------------
  const costComponents = [
    purchase,
    domesticShipping,
    supplierHandling,
    internationalShipping,
    packaging,
    categoryFee,
    fixedFee,
    internationalFee,
    adFee,
    fxCost,
    fxBuffer,
    returnReserve,
    insurance,
    signature,
    duty,
    importTax,
    brokerage,
    carrierSurcharge,
    other,
  ];
  const totalCost = Money.sum(costComponents, currency);
  const profit = totalRevenue.minus(totalCost);
  const profitJpy = profit.convertTo('JPY', effectiveFxRate);

  // percentOf keeps this exact: the value is compared against a configured
  // margin floor, so a float artefact here decides whether an item lists.
  const marginPercent = totalRevenue.isZero() ? '0' : profit.percentOf(totalRevenue);

  if (profit.isNegative()) {
    warnings.push(`${input.scenario} scenario is loss-making`);
  }

  return {
    scenario: input.scenario,
    saleCurrency: currency,
    customsMode: input.customs.mode,
    revenue: { itemPrice, shippingCharged, total: totalRevenue },
    costs: {
      purchase,
      domesticShipping,
      supplierHandling,
      internationalShipping,
      packaging,
      categoryFee,
      fixedFee,
      internationalFee,
      adFee,
      fxCost,
      fxBuffer,
      returnReserve,
      insurance,
      signature,
      duty,
      importTax,
      customsBrokerage: brokerage,
      carrierSurcharge,
      other,
      total: totalCost,
    },
    profit,
    profitJpy,
    marginPercent,
    fxRate: effectiveFxRate,
    warnings,
  };
}

/**
 * Duty and import tax.
 *
 * Who pays depends on the destination and the shipping arrangement, and the
 * requirements are explicit that it must not be a single global assumption.
 * Under BUYER_PAID and MARKETPLACE_COLLECTED the amounts are not our cost at
 * all; under SELLER_PAID they are. Under the two "we do not know" modes no
 * figure is produced and the item is sent to a human.
 */
function calculateCustoms(
  customs: CustomsProfile,
  itemPrice: Money,
  currency: CurrencyCode,
  toSale: (jpy: Money) => Money,
): { duty: Money; importTax: Money; brokerage: Money; customsWarnings: string[] } {
  const zero = Money.zero(currency);
  const customsWarnings: string[] = [];
  const brokerage = toSale(Money.fromString(customs.brokerageFeeJpy, 'JPY'));

  switch (customs.mode) {
    case 'BUYER_PAID':
      // The buyer settles duty on import. It is not our cost — but it does
      // suppress conversion, which is a pricing consideration, not a cost line.
      return { duty: zero, importTax: zero, brokerage, customsWarnings };

    case 'MARKETPLACE_COLLECTED':
      // eBay collects VAT/GST at checkout and remits it. The buyer pays it and
      // it never reaches our payout, so it is neither revenue nor cost.
      return { duty: zero, importTax: zero, brokerage, customsWarnings };

    case 'SELLER_PAID': {
      if (customs.dutyRatePercent === null && customs.importTaxRatePercent === null) {
        customsWarnings.push(
          'customs mode is SELLER_PAID but no duty or import tax rate is configured',
        );
        return { duty: zero, importTax: zero, brokerage, customsWarnings };
      }

      // A de minimis threshold exempts consignments below it. Note that the US
      // removed its USD 800 exemption on 2025-08-29, so a null threshold for a
      // US rule is correct rather than an oversight.
      const threshold = customs.deMinimisThreshold
        ? Money.fromString(customs.deMinimisThreshold, currency)
        : null;
      const exempt = threshold !== null && itemPrice.lessThan(threshold);

      if (exempt) {
        return { duty: zero, importTax: zero, brokerage, customsWarnings };
      }

      const duty = customs.dutyRatePercent ? itemPrice.percent(customs.dutyRatePercent) : zero;
      const importTax = customs.importTaxRatePercent
        ? itemPrice.plus(duty).percent(customs.importTaxRatePercent)
        : zero;
      return { duty, importTax, brokerage, customsWarnings };
    }

    case 'CARRIER_QUOTE_REQUIRED':
      customsWarnings.push(
        'duty cannot be determined without a carrier quote — manual review required before listing',
      );
      return { duty: zero, importTax: zero, brokerage, customsWarnings };

    case 'MANUAL_REVIEW':
      customsWarnings.push('customs treatment for this destination requires manual review');
      return { duty: zero, importTax: zero, brokerage, customsWarnings };
  }
}

/** Run all three scenarios against one set of inputs. */
export function calculateAllScenarios(
  input: Omit<ProfitInput, 'scenario'>,
): Record<ProfitScenario, ProfitBreakdown> {
  return {
    OPTIMISTIC: calculateProfit({ ...input, scenario: 'OPTIMISTIC' }),
    BASE: calculateProfit({ ...input, scenario: 'BASE' }),
    PESSIMISTIC: calculateProfit({ ...input, scenario: 'PESSIMISTIC' }),
  };
}
