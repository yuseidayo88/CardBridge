import { describe, expect, it } from 'vitest';
import { buildSearchQuery } from './market-price';

function product(over: Partial<Parameters<typeof buildSearchQuery>[0]> = {}) {
  return {
    card_name_en: 'Charizard ex',
    card_number: '006/165',
    grading_company: 'PSA',
    grade: '10.0',
    ...over,
  };
}

describe('buildSearchQuery', () => {
  it('combines name, number and grade', () => {
    expect(buildSearchQuery(product())).toBe('Charizard ex 006/165 PSA 10');
  });

  // The listing title has already been trimmed to eBay's 80 characters and may
  // have dropped the very term that identifies the card, so the query is built
  // from structured fields instead.
  it('drops the trailing zero a numeric column adds to the grade', () => {
    expect(buildSearchQuery(product({ grade: '10.0' }))).toContain('PSA 10');
    expect(buildSearchQuery(product({ grade: '10.0' }))).not.toContain('PSA 10.0');
  });

  it('keeps a genuine half grade', () => {
    expect(buildSearchQuery(product({ grade: '9.5' }))).toContain('PSA 9.5');
  });

  it('works without a card number', () => {
    expect(buildSearchQuery(product({ card_number: null }))).toBe('Charizard ex PSA 10');
  });

  // Searching the Japanese name on a US marketplace returns nothing, and
  // storing that empty result as "no market" would be a false negative that
  // blocks a perfectly listable card.
  it('returns null rather than searching without an English name', () => {
    expect(buildSearchQuery(product({ card_name_en: null }))).toBeNull();
  });

  // A PSA 10 and a PSA 8 of the same card are different markets; a query that
  // omitted the grade would average them into a number describing neither.
  it('always includes the grade', () => {
    expect(buildSearchQuery(product({ card_number: null, grade: '8' }))).toContain('PSA 8');
  });

  it('carries a non-PSA grader through', () => {
    expect(buildSearchQuery(product({ grading_company: 'BGS' }))).toContain('BGS 10');
  });
});
