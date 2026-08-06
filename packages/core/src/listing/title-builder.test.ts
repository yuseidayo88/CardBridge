import { describe, expect, it } from 'vitest';
import { EBAY_TITLE_MAX_LENGTH, buildEbayTitle, type TitleBuilderInput } from './title-builder';
import { generateSku, isValidSku, type SkuInput } from './sku';

const card = (over: Partial<TitleBuilderInput> = {}): TitleBuilderInput => ({
  cardNameEn: 'Charizard ex',
  cardNumber: '201/165',
  setNameEn: 'Ruler of the Black Flame',
  rarity: 'SAR',
  releaseYear: 2023,
  language: 'JAPANESE',
  gradingCompany: 'PSA',
  grade: 10,
  ...over,
});

describe('buildEbayTitle — required content', () => {
  it('includes the elements eBay buyers search for', () => {
    const { title } = buildEbayTitle(card());
    expect(title).toContain('Pokemon');
    expect(title).toContain('Japanese');
    expect(title).toContain('Charizard ex');
    expect(title).toContain('PSA 10');
  });

  it('adds GEM MINT for a PSA 10', () => {
    expect(buildEbayTitle(card()).title).toContain('GEM MINT');
  });

  it('omits the language word for English cards, where it wastes budget', () => {
    const { title } = buildEbayTitle(card({ language: 'ENGLISH' }));
    expect(title).not.toContain('Japanese');
    expect(title).not.toContain('English');
  });

  it('warns when the grading company is missing from the title', () => {
    const { warnings } = buildEbayTitle(card({ gradingCompany: '' }));
    expect(warnings.join(' ')).toMatch(/grading company/);
  });
});

describe('buildEbayTitle — the 80 character limit', () => {
  it('never exceeds the limit', () => {
    const inputs = [
      card(),
      card({ cardNameEn: 'Iono Special Art Rare Full Art Alternate Illustration Promo Card' }),
      card({ setNameEn: 'A Very Long Japanese Expansion Set Name That Goes On And On Forever' }),
      card({ cardNameEn: 'X'.repeat(200) }),
    ];
    for (const input of inputs) {
      const { title, length } = buildEbayTitle(input);
      expect(length).toBeLessThanOrEqual(EBAY_TITLE_MAX_LENGTH);
      expect(title.length).toBeLessThanOrEqual(EBAY_TITLE_MAX_LENGTH);
    }
  });

  it('drops the least valuable segments first', () => {
    const { title, omitted } = buildEbayTitle(
      card({ setNameEn: 'An Extremely Long Expansion Set Name For Testing Purposes Indeed' }),
    );
    // The card name, game, language and grade survive; decoration goes.
    expect(title).toContain('Charizard ex');
    expect(title).toContain('PSA 10');
    expect(omitted.length).toBeGreaterThan(0);
  });

  it('keeps the essential tokens even under extreme pressure', () => {
    const { title } = buildEbayTitle(card({ cardNameEn: 'Charizard ex '.repeat(10) }));
    expect(title).toContain('Pokemon');
    expect(title).toContain('PSA 10');
  });

  it('truncates the card name on a word boundary, not mid-word', () => {
    const { title } = buildEbayTitle(
      card({
        cardNameEn: 'Charizard ex Special Illustration Rare Alternate Art Version Extended',
        setNameEn: null,
        releaseYear: null,
        rarity: null,
      }),
    );
    expect(title).not.toMatch(/\w-$/);
    expect(title.length).toBeLessThanOrEqual(EBAY_TITLE_MAX_LENGTH);
  });
});

describe('buildEbayTitle — never invents facts', () => {
  it('omits the year entirely when it is unknown', () => {
    const { title } = buildEbayTitle(card({ releaseYear: null }));
    expect(title).not.toMatch(/\b(19|20)\d{2}\b/);
  });

  it('omits the set name when it is unknown', () => {
    const { title } = buildEbayTitle(card({ setNameEn: null }));
    expect(title).not.toContain('Ruler');
  });

  it('omits the card number when it is unknown', () => {
    const { title } = buildEbayTitle(card({ cardNumber: null }));
    expect(title).not.toContain('201/165');
  });
});

describe('buildEbayTitle — promotional language', () => {
  it('flags unsupported superlatives that reach the title', () => {
    const { warnings } = buildEbayTitle(card({ cardNameEn: 'Charizard ex Authentic Rare' }));
    expect(warnings.join(' ')).toMatch(/authentic/);
    expect(warnings.join(' ')).toMatch(/rare/);
  });

  it('does not trip on a legitimate word containing a banned substring', () => {
    // "Rarity" contains "rar" but is not the banned token "rare".
    const { warnings } = buildEbayTitle(card({ cardNameEn: 'Charizard ex', rarity: 'SAR' }));
    expect(warnings.join(' ')).not.toMatch(/unsupported promotional/);
  });

  it('strips non-ASCII rather than shipping it to eBay search', () => {
    const { title } = buildEbayTitle(card({ cardNameEn: 'リザードンex Charizard' }));
    expect(title).not.toMatch(/[^\x20-\x7E]/);
  });

  it('refuses to build a title with no card name', () => {
    const { title, warnings } = buildEbayTitle(card({ cardNameEn: '' }));
    expect(title).toBe('');
    expect(warnings.join(' ')).toMatch(/card name is empty/);
  });
});

describe('generateSku', () => {
  const sku = (over: Partial<SkuInput> = {}): SkuInput => ({
    cardNameEn: 'Charizard ex',
    cardNameJa: 'リザードンex',
    cardNumber: '201/165',
    setCode: 'SV2a',
    language: 'JAPANESE',
    gradingCompany: 'PSA',
    grade: 10,
    ...over,
  });

  it('is deterministic', () => {
    expect(generateSku(sku())).toBe(generateSku(sku()));
  });

  it('is stable across spelling and spacing differences', () => {
    expect(generateSku(sku())).toBe(generateSku(sku({ cardNameEn: 'Charizard  ex' })));
  });

  it('differs for different cards', () => {
    const skus = new Set([
      generateSku(sku()),
      generateSku(sku({ cardNumber: '202/165' })),
      generateSku(sku({ setCode: 'SV1a' })),
      generateSku(sku({ grade: 9 })),
      generateSku(sku({ language: 'ENGLISH' })),
      generateSku(sku({ gradingCompany: 'BGS' })),
      generateSku(sku({ cardNameEn: 'Pikachu' })),
    ]);
    expect(skus.size).toBe(7);
  });

  it('stays within eBay limits even with long inputs', () => {
    const long = generateSku(
      sku({ cardNameEn: 'X'.repeat(300), setCode: 'VERYLONGSETCODE'.repeat(5) }),
    );
    expect(long.length).toBeLessThanOrEqual(40);
    expect(isValidSku(long)).toBe(true);
  });

  it('produces a readable, valid SKU', () => {
    const value = generateSku(sku());
    expect(value.startsWith('CB-')).toBe(true);
    expect(value).toContain('PSA10');
    expect(isValidSku(value)).toBe(true);
  });

  it('is unaffected by fields that are not part of card identity', () => {
    // Price and stock change constantly; the SKU must not.
    expect(generateSku(sku({ cardNameJa: '別の日本語名' }))).toBe(generateSku(sku()));
  });
});
