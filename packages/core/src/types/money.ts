import Decimal from 'decimal.js';

/**
 * Money — the only currency type in this codebase.
 *
 * Why this exists rather than `number`:
 *   0.1 + 0.2 === 0.30000000000000004. On a 300-item listing run with a dozen
 *   fee components each, those errors accumulate into real yen, and a profit
 *   threshold decided by a drifting number is a threshold that silently lets
 *   loss-making listings through.
 *
 * Two invariants are enforced at runtime, not by convention:
 *   1. Arithmetic between different currencies throws. Adding USD fees to a JPY
 *      cost is the single most likely bug in a cross-border pricing engine, and
 *      it is one that produces plausible-looking wrong answers.
 *   2. Values are immutable. Every operation returns a new Money.
 *
 * Conversion between currencies is deliberately awkward (`convertTo` demands an
 * explicit rate) so that an FX rate can never be implied by context.
 */

// 28 significant digits is far beyond anything a card price needs, but it keeps
// intermediate division (e.g. margin ratios) from losing precision.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type CurrencyCode = 'JPY' | 'USD' | 'EUR' | 'GBP' | 'AUD' | 'CAD';

/** Minor-unit exponent per currency. JPY has no minor unit. */
const CURRENCY_SCALE: Record<CurrencyCode, number> = {
  JPY: 0,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AUD: 2,
  CAD: 2,
};

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'UP' | 'DOWN';

const ROUNDING_MAP: Record<RoundingMode, Decimal.Rounding> = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  UP: Decimal.ROUND_CEIL,
  DOWN: Decimal.ROUND_FLOOR,
};

export class CurrencyMismatchError extends Error {
  constructor(
    readonly left: CurrencyCode,
    readonly right: CurrencyCode,
    operation: string,
  ) {
    super(
      `Cannot ${operation} ${left} and ${right}. Convert explicitly with convertTo(rate) first.`,
    );
    this.name = 'CurrencyMismatchError';
  }
}

export class Money {
  private constructor(
    private readonly amount: Decimal,
    readonly currency: CurrencyCode,
  ) {}

  // --- construction ---------------------------------------------------------

  /**
   * Build from a string. This is the preferred entry point: strings come
   * straight out of Postgres `numeric` columns and out of scraped HTML without
   * ever passing through a double.
   */
  static fromString(value: string, currency: CurrencyCode): Money {
    const cleaned = value.replace(/[,\s¥$€£]/g, '');
    if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) {
      throw new Error(`Not a valid monetary amount: ${JSON.stringify(value)}`);
    }
    return new Money(new Decimal(cleaned), currency);
  }

  /**
   * Build from integer minor units (cents, or whole yen for JPY). Safe because
   * the input is an integer.
   */
  static fromMinorUnits(minorUnits: number | bigint, currency: CurrencyCode): Money {
    const asString = minorUnits.toString();
    if (!/^-?\d+$/.test(asString)) {
      throw new Error(`Minor units must be an integer, got ${asString}`);
    }
    const scale = CURRENCY_SCALE[currency];
    return new Money(new Decimal(asString).div(new Decimal(10).pow(scale)), currency);
  }

  /**
   * Escape hatch for literals in configuration and tests only. Rejects any
   * value that has already lost precision as a double, which catches the
   * `Money.fromNumber(0.1 + 0.2)` class of mistake at the boundary.
   */
  static fromNumber(value: number, currency: CurrencyCode): Money {
    if (!Number.isFinite(value)) {
      throw new Error(`Not a finite number: ${value}`);
    }
    const asString = String(value);
    if (asString.includes('e') || asString.includes('E')) {
      throw new Error(`Exponential notation is not accepted: ${asString}. Use fromString().`);
    }
    return new Money(new Decimal(asString), currency);
  }

  static zero(currency: CurrencyCode): Money {
    return new Money(new Decimal(0), currency);
  }

  // --- arithmetic -----------------------------------------------------------

  private assertSameCurrency(other: Money, operation: string): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency, operation);
    }
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other, 'add');
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other, 'subtract');
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  /** Multiply by a dimensionless factor (a fee rate, a quantity). */
  times(factor: number | string): Money {
    return new Money(this.amount.times(new Decimal(String(factor))), this.currency);
  }

  dividedBy(divisor: number | string): Money {
    const d = new Decimal(String(divisor));
    if (d.isZero()) {
      throw new Error('Division by zero in monetary calculation');
    }
    return new Money(this.amount.div(d), this.currency);
  }

  /** Percentage of this amount. `percent(15)` is 15%, not 0.15. */
  percent(rate: number | string): Money {
    return new Money(this.amount.times(new Decimal(String(rate))).div(100), this.currency);
  }

  negated(): Money {
    return new Money(this.amount.negated(), this.currency);
  }

  abs(): Money {
    return new Money(this.amount.abs(), this.currency);
  }

  static sum(items: readonly Money[], currency: CurrencyCode): Money {
    return items.reduce((acc, item) => acc.plus(item), Money.zero(currency));
  }

  static max(a: Money, b: Money): Money {
    a.assertSameCurrency(b, 'compare');
    return a.amount.gte(b.amount) ? a : b;
  }

  static min(a: Money, b: Money): Money {
    a.assertSameCurrency(b, 'compare');
    return a.amount.lte(b.amount) ? a : b;
  }

  // --- currency conversion --------------------------------------------------

  /**
   * Convert using an explicit rate. There is intentionally no ambient rate
   * lookup here: an FX rate is an input to a profit calculation and has to be
   * captured in the calculation's snapshot, so the caller must supply it.
   */
  convertTo(target: CurrencyCode, rate: number | string): Money {
    const r = new Decimal(String(rate));
    if (r.lte(0)) {
      throw new Error(`FX rate must be positive, got ${String(rate)}`);
    }
    return new Money(this.amount.times(r), target);
  }

  // --- rounding & comparison ------------------------------------------------

  /** Round to the currency's natural precision (0 dp for JPY, 2 dp otherwise). */
  round(mode: RoundingMode = 'HALF_UP'): Money {
    const scale = CURRENCY_SCALE[this.currency];
    return new Money(this.amount.toDecimalPlaces(scale, ROUNDING_MAP[mode]), this.currency);
  }

  roundTo(decimalPlaces: number, mode: RoundingMode = 'HALF_UP'): Money {
    return new Money(this.amount.toDecimalPlaces(decimalPlaces, ROUNDING_MAP[mode]), this.currency);
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isNegative(): boolean {
    return this.amount.isNegative() && !this.amount.isZero();
  }

  isPositive(): boolean {
    return this.amount.greaterThan(0);
  }

  greaterThan(other: Money): boolean {
    this.assertSameCurrency(other, 'compare');
    return this.amount.greaterThan(other.amount);
  }

  greaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other, 'compare');
    return this.amount.greaterThanOrEqualTo(other.amount);
  }

  lessThan(other: Money): boolean {
    this.assertSameCurrency(other, 'compare');
    return this.amount.lessThan(other.amount);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  /**
   * This amount as an exact percentage of another, returned as a decimal
   * string.
   *
   * Exists so that a margin can be computed without a float step. The obvious
   * `ratioTo(x) * 100` reintroduces IEEE-754 at the last moment, and the
   * result is compared against a configured margin floor — so a value landing
   * a fraction below 15 instead of exactly on it decides whether an item gets
   * listed.
   */
  percentOf(other: Money, decimalPlaces = 4): string {
    this.assertSameCurrency(other, 'compare');
    if (other.amount.isZero()) {
      throw new Error('Cannot compute a percentage of zero');
    }
    return this.amount
      .div(other.amount)
      .times(100)
      .toDecimalPlaces(decimalPlaces, Decimal.ROUND_HALF_UP)
      .toFixed();
  }

  /**
   * Ratio against another amount, as a plain number. Only for ratios that are
   * genuinely dimensionless and not used for a threshold decision — prefer
   * percentOf() for anything that gates behaviour.
   */
  ratioTo(other: Money): number {
    this.assertSameCurrency(other, 'compare');
    if (other.amount.isZero()) {
      throw new Error('Cannot compute a ratio against zero');
    }
    return this.amount.div(other.amount).toNumber();
  }

  // --- serialisation --------------------------------------------------------

  /** Exact decimal string. This is what goes into Postgres `numeric` columns. */
  toString(): string {
    return this.amount.toFixed();
  }

  /** Rounded, currency-scaled string for storage and display. */
  toFixed(): string {
    return this.amount.toFixed(CURRENCY_SCALE[this.currency]);
  }

  toMinorUnits(): bigint {
    const scale = CURRENCY_SCALE[this.currency];
    return BigInt(this.amount.times(new Decimal(10).pow(scale)).toFixed(0));
  }

  format(locale = 'en-US'): string {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: this.currency,
      minimumFractionDigits: CURRENCY_SCALE[this.currency],
    }).format(Number(this.toFixed()));
  }

  toJSON(): { amount: string; currency: CurrencyCode } {
    return { amount: this.toString(), currency: this.currency };
  }
}
