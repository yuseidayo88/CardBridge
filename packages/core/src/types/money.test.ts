import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError, Money } from './money';

describe('Money — precision', () => {
  it('does not reproduce the classic float error', () => {
    const a = Money.fromString('0.1', 'USD');
    const b = Money.fromString('0.2', 'USD');
    expect(a.plus(b).toString()).toBe('0.3');
    // for contrast: 0.1 + 0.2 === 0.30000000000000004
  });

  it('stays exact across a long chain of fee deductions', () => {
    // A realistic fee stack: category fee, fixed fee, international fee, ads.
    let amount = Money.fromString('123.45', 'USD');
    for (let i = 0; i < 100; i += 1) {
      amount = amount.minus(Money.fromString('0.01', 'USD'));
    }
    expect(amount.toString()).toBe('122.45');
  });

  it('computes percentages without drift', () => {
    const price = Money.fromString('249.99', 'USD');
    expect(price.percent('13.25').roundTo(4).toString()).toBe('33.1237');
  });

  it('handles JPY as a zero-decimal currency', () => {
    const price = Money.fromString('12800', 'JPY');
    expect(price.percent('10').round().toString()).toBe('1280');
    expect(price.toFixed()).toBe('12800');
  });
});

describe('Money — currency safety', () => {
  it('refuses to add different currencies', () => {
    const jpy = Money.fromString('1000', 'JPY');
    const usd = Money.fromString('10', 'USD');
    expect(() => jpy.plus(usd)).toThrow(CurrencyMismatchError);
  });

  it('refuses to compare different currencies', () => {
    const jpy = Money.fromString('1000', 'JPY');
    const usd = Money.fromString('10', 'USD');
    expect(() => jpy.greaterThan(usd)).toThrow(CurrencyMismatchError);
  });

  it('converts only with an explicit rate', () => {
    const jpy = Money.fromString('15000', 'JPY');
    const usd = jpy.convertTo('USD', '0.0067');
    expect(usd.currency).toBe('USD');
    expect(usd.round().toString()).toBe('100.5');
  });

  it('rejects a non-positive FX rate', () => {
    expect(() => Money.fromString('100', 'JPY').convertTo('USD', '0')).toThrow(/positive/);
    expect(() => Money.fromString('100', 'JPY').convertTo('USD', '-1')).toThrow(/positive/);
  });

  it('treats equality as currency-aware', () => {
    expect(Money.fromString('10', 'USD').equals(Money.fromString('10', 'USD'))).toBe(true);
    expect(Money.fromString('10', 'USD').equals(Money.fromString('10', 'EUR'))).toBe(false);
  });
});

describe('Money — construction guards', () => {
  it('parses formatted strings from scraped pages', () => {
    expect(Money.fromString('¥12,800', 'JPY').toString()).toBe('12800');
    expect(Money.fromString(' 1,234.56 ', 'USD').toString()).toBe('1234.56');
  });

  it('rejects junk instead of silently producing NaN', () => {
    expect(() => Money.fromString('', 'JPY')).toThrow();
    expect(() => Money.fromString('お問い合わせ', 'JPY')).toThrow();
    expect(() => Money.fromString('12.34.56', 'USD')).toThrow();
  });

  it('rejects exponential notation, which signals lost precision', () => {
    expect(() => Money.fromNumber(1e21, 'JPY')).toThrow(/Exponential/);
  });

  it('rejects non-finite numbers', () => {
    expect(() => Money.fromNumber(Number.NaN, 'JPY')).toThrow();
    expect(() => Money.fromNumber(Number.POSITIVE_INFINITY, 'JPY')).toThrow();
  });

  it('round-trips minor units', () => {
    expect(Money.fromMinorUnits(12345, 'USD').toString()).toBe('123.45');
    expect(Money.fromMinorUnits(12800, 'JPY').toString()).toBe('12800');
    expect(Money.fromString('123.45', 'USD').toMinorUnits()).toBe(12345n);
    expect(Money.fromString('12800', 'JPY').toMinorUnits()).toBe(12800n);
  });
});

describe('Money — aggregation and comparison', () => {
  it('sums an empty list to zero rather than throwing', () => {
    expect(Money.sum([], 'JPY').isZero()).toBe(true);
  });

  it('sums a cost stack', () => {
    const costs = [
      Money.fromString('12800', 'JPY'),
      Money.fromString('500', 'JPY'),
      Money.fromString('150', 'JPY'),
    ];
    expect(Money.sum(costs, 'JPY').toString()).toBe('13450');
  });

  it('distinguishes negative from zero', () => {
    expect(Money.fromString('-1', 'JPY').isNegative()).toBe(true);
    expect(Money.zero('JPY').isNegative()).toBe(false);
    expect(Money.zero('JPY').isPositive()).toBe(false);
  });

  it('computes a margin ratio', () => {
    const profit = Money.fromString('30', 'USD');
    const revenue = Money.fromString('120', 'USD');
    expect(profit.ratioTo(revenue)).toBeCloseTo(0.25, 10);
  });

  it('refuses to divide by zero', () => {
    expect(() => Money.fromString('10', 'USD').dividedBy(0)).toThrow(/zero/);
    expect(() => Money.fromString('10', 'USD').ratioTo(Money.zero('USD'))).toThrow(/zero/);
  });
});

describe('Money — rounding', () => {
  it('rounds half up by default', () => {
    expect(Money.fromString('1.005', 'USD').round().toString()).toBe('1.01');
    expect(Money.fromString('1500.5', 'JPY').round().toString()).toBe('1501');
  });

  it('supports floor rounding, which is what a profit floor needs', () => {
    // Rounding a projected profit up would let a marginal item pass the gate.
    expect(Money.fromString('1.999', 'USD').round('DOWN').toString()).toBe('1.99');
  });

  it('supports ceiling rounding, which is what a cost estimate needs', () => {
    expect(Money.fromString('1.001', 'USD').round('UP').toString()).toBe('1.01');
  });
});
