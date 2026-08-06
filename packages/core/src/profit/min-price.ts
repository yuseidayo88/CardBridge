import { Money } from '../types/money';
import { calculateProfit, type ProfitInput } from './cost-model';

/**
 * Work backwards from a profit floor to the price that achieves it.
 *
 * Solving this algebraically is possible but fragile: percentage fees apply to
 * revenue (which includes the price we are solving for), duty applies to item
 * value only above a threshold, and the de minimis rule introduces a
 * discontinuity. Any closed form would have to be rederived every time a cost
 * component is added — and would silently go wrong if someone forgot.
 *
 * Bisection over calculateProfit avoids all of that: it is defined in terms of
 * the same function that decides eligibility, so the two can never disagree.
 * Profit is monotonically increasing in price (every fee rate is below 100%),
 * which is what makes bisection valid here.
 */

export interface MinPriceInput extends Omit<ProfitInput, 'sellingPrice' | 'scenario'> {
  /** Absolute profit floor, in JPY. */
  minProfitJpy: string;
  /** Margin floor, as a percentage of revenue. */
  minMarginPercent: string;
  /**
   * Which scenario the floor must hold under. PESSIMISTIC by default: a price
   * that only clears the bar when nothing goes wrong is not a safe price.
   *
   * Deliberately NOT called `scenario`. Callers routinely build this input by
   * spreading a ProfitInput, and a field named `scenario` would then be set
   * silently — quietly solving against BASE and returning a price that loses
   * money the moment the yen moves. Requiring a distinct name makes choosing a
   * weaker scenario an explicit act.
   */
  scenarioOverride?: ProfitInput['scenario'];
  /** Search bounds in the sale currency. */
  maxPrice?: string;
  /** Stop when the bracket is narrower than this. */
  tolerance?: string;
}

export interface MinPriceResult {
  /** Null when no price within the search range satisfies both floors. */
  minimumPrice: Money | null;
  /** Which constraint was binding at the solution. */
  bindingConstraint: 'PROFIT_FLOOR' | 'MARGIN_FLOOR' | 'NONE';
  iterations: number;
  warnings: string[];
}

const DEFAULT_MAX_PRICE = '100000';
const DEFAULT_TOLERANCE = '0.01';
const MAX_ITERATIONS = 60;

export function solveMinimumPrice(input: MinPriceInput): MinPriceResult {
  const currency = input.saleCurrency;
  const scenario = input.scenarioOverride ?? 'PESSIMISTIC';
  const tolerance = Money.fromString(input.tolerance ?? DEFAULT_TOLERANCE, currency);
  const warnings: string[] = [];

  const minProfitJpy = Money.fromString(input.minProfitJpy, 'JPY');
  const minMarginPercent = Money.fromString(input.minMarginPercent, 'JPY');

  /** Does this price clear both floors? */
  const satisfies = (
    price: Money,
  ): { ok: boolean; binding: MinPriceResult['bindingConstraint'] } => {
    // `scenario` is applied last so that a stray scenario field on a spread
    // input cannot downgrade the safety scenario.
    const result = calculateProfit({ ...input, sellingPrice: price.toString(), scenario });

    const profitOk = result.profitJpy.greaterThanOrEqual(minProfitJpy);
    const marginOk = Money.fromString(result.marginPercent, 'JPY').greaterThanOrEqual(
      minMarginPercent,
    );

    if (profitOk && marginOk) return { ok: true, binding: 'NONE' };
    return { ok: false, binding: profitOk ? 'MARGIN_FLOOR' : 'PROFIT_FLOOR' };
  };

  let low = Money.zero(currency);
  let high = Money.fromString(input.maxPrice ?? DEFAULT_MAX_PRICE, currency);

  // If even the ceiling fails, no price in range works. This is a real outcome
  // — an item whose landed cost exceeds what the market will bear — and it
  // must be reported rather than papered over with the ceiling price.
  const ceiling = satisfies(high);
  if (!ceiling.ok) {
    warnings.push(
      `no price up to ${high.toFixed()} ${currency} satisfies the floors under the ${scenario} scenario`,
    );
    return { minimumPrice: null, bindingConstraint: ceiling.binding, iterations: 1, warnings };
  }

  let iterations = 1;
  let binding: MinPriceResult['bindingConstraint'] = 'NONE';

  while (high.minus(low).greaterThan(tolerance) && iterations < MAX_ITERATIONS) {
    const mid = low.plus(high).dividedBy(2);
    const check = satisfies(mid);
    iterations += 1;

    if (check.ok) {
      high = mid;
    } else {
      low = mid;
      binding = check.binding;
    }
  }

  if (iterations >= MAX_ITERATIONS) {
    warnings.push('bisection hit the iteration cap; the result may be imprecise');
  }

  // Round up: rounding down could land a cent below the floor.
  const minimumPrice = high.round('UP');

  // Verify the rounded price still clears the floors, rather than assuming it.
  const verified = satisfies(minimumPrice);
  if (!verified.ok) {
    warnings.push('the rounded minimum price does not satisfy the floors — widen the tolerance');
  }

  return { minimumPrice, bindingConstraint: binding, iterations, warnings };
}
