import { describe, expect, it } from 'vitest';
import { CardNameCatalog, cardNameKey, type CardNameEntry } from './card-name-lookup';

function entry(over: Partial<CardNameEntry> = {}): CardNameEntry {
  return {
    nameJa: 'リザードンex',
    nameEn: 'Charizard ex',
    setCode: 'sv3a',
    cardNumber: '006/165',
    source: 'official-list',
    verified: true,
    ...over,
  };
}

describe('cardNameKey', () => {
  it('ignores spacing differences between shops', () => {
    expect(cardNameKey('リザードン ex')).toBe(cardNameKey('リザードンex'));
  });

  it('ignores full-width and half-width differences', () => {
    expect(cardNameKey('リザードンｅｘ')).toBe(cardNameKey('リザードンex'));
  });

  // Regression: an earlier normaliser folded U+30FC (ー) to a hyphen, which
  // turns リザードン into リザ-ドン and breaks every katakana card name.
  it('preserves the katakana long-vowel mark', () => {
    expect(cardNameKey('リザードン')).not.toBe(cardNameKey('リザドン'));
  });
});

describe('lookup precision', () => {
  it('resolves EXACT when name, set and number all agree', () => {
    const catalog = new CardNameCatalog([entry()]);
    const result = catalog.lookup({
      nameJa: 'リザードンex',
      setCode: 'sv3a',
      cardNumber: '006/165',
    });

    expect(result.precision).toBe('EXACT');
    expect(result.nameEn.value).toBe('Charizard ex');
    expect(result.nameEn.source).toBe('catalog_lookup');
    expect(result.nameEn.confidence).toBe(1);
  });

  it('resolves NAME_AND_NUMBER when the query has no set code', () => {
    const catalog = new CardNameCatalog([entry()]);
    const result = catalog.lookup({ nameJa: 'リザードンex', cardNumber: '006/165' });

    expect(result.precision).toBe('NAME_AND_NUMBER');
    expect(result.nameEn.value).toBe('Charizard ex');
  });

  it('resolves NAME_ONLY when nothing but the name is available', () => {
    const catalog = new CardNameCatalog([entry()]);
    const result = catalog.lookup({ nameJa: 'リザードンex' });

    expect(result.precision).toBe('NAME_ONLY');
    expect(result.nameEn.value).toBe('Charizard ex');
  });

  // A name-only hit is usually right, which is exactly why it must not publish
  // unattended: "usually right" is the case a reviewer exists for.
  it('keeps NAME_ONLY below the default publish floor of 0.85', () => {
    const catalog = new CardNameCatalog([entry()]);
    const result = catalog.lookup({ nameJa: 'リザードンex' });
    expect(result.nameEn.confidence).toBeLessThan(0.85);
  });

  it('reports NOT_FOUND with a null value rather than inventing one', () => {
    const catalog = new CardNameCatalog([entry()]);
    const result = catalog.lookup({ nameJa: 'ピカチュウ' });

    expect(result.precision).toBe('NOT_FOUND');
    expect(result.nameEn.value).toBeNull();
    expect(result.nameEn.source).toBe('unknown');
  });

  it('matches through spacing differences in the query', () => {
    const catalog = new CardNameCatalog([entry()]);
    expect(catalog.lookup({ nameJa: 'リザードン ex' }).precision).toBe('NAME_ONLY');
  });
});

describe('ambiguity', () => {
  const reprints = [
    entry({ setCode: 'sv3a', cardNumber: '006/165', nameEn: 'Charizard ex' }),
    entry({ setCode: 'sv8a', cardNumber: '021/187', nameEn: 'Charizard ex (Terastal)' }),
  ];

  it('refuses to choose between different English names', () => {
    const result = new CardNameCatalog(reprints).lookup({ nameJa: 'リザードンex' });

    expect(result.precision).toBe('AMBIGUOUS');
    expect(result.nameEn.value).toBeNull();
    expect(result.candidates).toHaveLength(2);
  });

  it('resolves the ambiguity once a set code narrows it', () => {
    const result = new CardNameCatalog(reprints).lookup({
      nameJa: 'リザードンex',
      setCode: 'sv8a',
      cardNumber: '021/187',
    });

    expect(result.precision).toBe('EXACT');
    expect(result.nameEn.value).toBe('Charizard ex (Terastal)');
  });

  // A card legitimately appears once per set it was printed in. Treating those
  // rows as a conflict would make every popular card permanently unresolvable.
  it('does not call duplicate rows ambiguous when they agree on the English name', () => {
    const catalog = new CardNameCatalog([
      entry({ setCode: 'sv3a', cardNumber: '006/165' }),
      entry({ setCode: 'sv3a', cardNumber: '201/165' }),
    ]);

    const result = catalog.lookup({ nameJa: 'リザードンex' });
    expect(result.precision).toBe('NAME_ONLY');
    expect(result.nameEn.value).toBe('Charizard ex');
  });

  it('falls back to the wider match when the set code matches nothing', () => {
    const catalog = new CardNameCatalog([entry()]);
    const result = catalog.lookup({
      nameJa: 'リザードンex',
      setCode: 'nonexistent',
      cardNumber: '006/165',
    });

    // The number still identifies it; a wrong set code should not turn a
    // findable card into NOT_FOUND.
    expect(result.precision).toBe('NAME_AND_NUMBER');
    expect(result.nameEn.value).toBe('Charizard ex');
  });
});

describe('verification state', () => {
  it('caps an unverified row below the publish floor even on an exact match', () => {
    const catalog = new CardNameCatalog([entry({ verified: false })]);
    const result = catalog.lookup({
      nameJa: 'リザードンex',
      setCode: 'sv3a',
      cardNumber: '006/165',
    });

    expect(result.precision).toBe('EXACT');
    expect(result.nameEn.value).toBe('Charizard ex');
    expect(result.nameEn.confidence).toBeLessThan(0.85);
  });

  it('records where the answer came from', () => {
    const catalog = new CardNameCatalog([entry({ source: 'admin-entry' })]);
    const result = catalog.lookup({ nameJa: 'リザードンex', cardNumber: '006/165' });
    expect(result.nameEn.note).toContain('admin-entry');
  });
});

describe('index behaviour', () => {
  it('starts empty and reports NOT_FOUND for everything', () => {
    const catalog = new CardNameCatalog();
    expect(catalog.size).toBe(0);
    expect(catalog.lookup({ nameJa: 'リザードンex' }).precision).toBe('NOT_FOUND');
  });

  it('accepts entries added after construction', () => {
    const catalog = new CardNameCatalog();
    catalog.add(entry());
    expect(catalog.size).toBe(1);
    expect(catalog.lookup({ nameJa: 'リザードンex' }).nameEn.value).toBe('Charizard ex');
  });

  it('handles name-only entries that carry no set or number', () => {
    const catalog = new CardNameCatalog([
      entry({ nameJa: 'ピカチュウ', nameEn: 'Pikachu', setCode: null, cardNumber: null }),
    ]);

    // A query with a number must not be dragged down to NOT_FOUND by an entry
    // that simply does not record one.
    const result = catalog.lookup({ nameJa: 'ピカチュウ', cardNumber: '025/165' });
    expect(result.precision).toBe('NAME_ONLY');
    expect(result.nameEn.value).toBe('Pikachu');
  });
});
