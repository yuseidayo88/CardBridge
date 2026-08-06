import { describe, expect, it } from 'vitest';
import { parseTitle } from './title-parser';
import {
  extractCardNumber,
  extractRarity,
  normalizeTitle,
  parseJpyPrice,
  stringSimilarity,
} from './normalizers';

describe('normalizers', () => {
  it('folds full-width to half-width', () => {
    expect(normalizeTitle('ＰＳＡ１０　２０１／１６５')).toBe('PSA10 201/165');
  });

  it('preserves the katakana long-vowel mark', () => {
    // Folding ー to "-" would turn リザードン into リザ-ドン and break matching.
    expect(normalizeTitle('リザードン')).toBe('リザードン');
    expect(normalizeTitle('ミュウツー')).toBe('ミュウツー');
  });

  it('unifies bracket styles', () => {
    expect(normalizeTitle('【PSA10】')).toBe('[PSA10]');
    expect(normalizeTitle('〔PSA10〕')).toBe('[PSA10]');
  });

  it('extracts card numbers in the forms shops actually use', () => {
    expect(extractCardNumber('リザードンex SAR 201/165')).toBe('201/165');
    expect(extractCardNumber('ピカチュウ 001/S-P プロモ')).toBe('001/S-P');
    expect(extractCardNumber('２０１／１６５')).toBe('201/165');
    expect(extractCardNumber('カード名だけ')).toBeNull();
  });

  it('does not shadow SAR with AR', () => {
    expect(extractRarity('リザードンex SAR 201/165')).toBe('SAR');
    expect(extractRarity('ピカチュウ AR 112/108')).toBe('AR');
  });

  it('parses prices and refuses junk', () => {
    expect(parseJpyPrice('¥128,000')).toBe('128000');
    expect(parseJpyPrice('128,000円(税込)')).toBe('128000');
    expect(parseJpyPrice('１２８，０００円')).toBe('128000');
    expect(parseJpyPrice('お問い合わせください')).toBeNull();
    expect(parseJpyPrice('')).toBeNull();
  });

  it('scores string similarity for matching', () => {
    expect(stringSimilarity('リザードンex', 'リザードンex')).toBe(1);
    expect(stringSimilarity('リザードンex', 'リザードン ex')).toBe(1); // spacing only
    expect(stringSimilarity('リザードンex', 'ピカチュウ')).toBeLessThan(0.3);
  });
});

describe('parseTitle — deterministic extraction', () => {
  it('parses a typical PSA 10 listing', () => {
    const { attributes, overallConfidence } = parseTitle({
      title: '【PSA10】リザードンex SAR 201/165 黒煙の支配者',
    });

    expect(attributes.cardNumber.value).toBe('201/165');
    expect(attributes.cardNumber.source).toBe('title_parser');
    expect(attributes.rarity.value).toBe('SAR');
    expect(attributes.gradingCompany.value).toBe('PSA');
    expect(attributes.grade.value).toBe(10);
    expect(attributes.language.value).toBe('JAPANESE');
    expect(attributes.cardNameJa.value).toContain('リザードン');
    expect(overallConfidence).toBeGreaterThan(0.85);
  });

  it('anchors the grade to a grading company', () => {
    // The 10 here belongs to the card number, not to a grade.
    const { attributes } = parseTitle({ title: 'リザードンex 010/165' });
    expect(attributes.grade.value).toBeNull();
    expect(attributes.grade.source).toBe('unknown');
  });
});

describe('parseTitle — never guesses', () => {
  it('leaves the release year unknown, always', () => {
    const { attributes } = parseTitle({
      title: '【PSA10】リザードンex SAR 201/165 黒煙の支配者',
    });
    expect(attributes.releaseYear.value).toBeNull();
    expect(attributes.releaseYear.source).toBe('unknown');
    expect(attributes.releaseYear.confidence).toBe(0);
  });

  it('leaves the set name unknown even when the title contains one', () => {
    // "黒煙の支配者" is a set name, but deciding that from a title is a guess.
    const { attributes } = parseTitle({ title: '【PSA10】リザードンex 201/165 黒煙の支配者' });
    expect(attributes.setName.value).toBeNull();
  });

  it('leaves the English name unknown', () => {
    const { attributes } = parseTitle({ title: '【PSA10】リザードンex 201/165' });
    expect(attributes.cardNameEn.value).toBeNull();
  });

  it('reports a null card number as unknown rather than empty', () => {
    const { attributes, warnings } = parseTitle({ title: '【PSA10】なにかのカード' });
    expect(attributes.cardNumber.value).toBeNull();
    expect(attributes.cardNumber.confidence).toBe(0);
    expect(warnings.some((w) => w.code === 'MISSING_CARD_NUMBER')).toBe(true);
  });
});

describe('parseTitle — provenance precedence', () => {
  it('lets structured data override the title parser', () => {
    const { attributes } = parseTitle({
      title: '【PSA10】リザードンex SAR 201/165',
      structured: { cardNumber: '006/165', setName: '黒煙の支配者', releaseYear: 2023 },
    });

    expect(attributes.cardNumber.value).toBe('006/165');
    expect(attributes.cardNumber.source).toBe('structured_data');
    // Structured data may supply what the parser refuses to infer.
    expect(attributes.setName.value).toBe('黒煙の支配者');
    expect(attributes.releaseYear.value).toBe(2023);
    expect(attributes.releaseYear.source).toBe('structured_data');
  });

  it('lets a supplier rule override the generic parser', () => {
    const { attributes } = parseTitle({
      title: '[PSA10] リザードンex <<SAR>> 201/165',
      supplierRules: [{ field: 'rarity', pattern: '<<([A-Z]+)>>', confidence: 0.99 }],
    });
    expect(attributes.rarity.value).toBe('SAR');
    expect(attributes.rarity.source).toBe('supplier_rule');
  });

  it('records a warning for an invalid supplier rule instead of crashing', () => {
    const { warnings } = parseTitle({
      title: '【PSA10】リザードンex 201/165',
      supplierRules: [{ field: 'rarity', pattern: '([unclosed', confidence: 1 }],
    });
    expect(warnings.some((w) => w.code === 'INVALID_SUPPLIER_RULE')).toBe(true);
  });

  it('keeps structured data above a supplier rule', () => {
    const { attributes } = parseTitle({
      title: '[PSA10] リザードンex <<SAR>> 201/165',
      supplierRules: [{ field: 'rarity', pattern: '<<([A-Z]+)>>', confidence: 0.99 }],
      structured: { rarity: 'SR' },
    });
    expect(attributes.rarity.value).toBe('SR');
    expect(attributes.rarity.source).toBe('structured_data');
  });
});

describe('parseTitle — language', () => {
  it('detects an explicit English marker over Japanese script', () => {
    const { attributes } = parseTitle({ title: '【PSA10】リザードンex 英語版 201/165' });
    expect(attributes.language.value).toBe('ENGLISH');
  });

  it('infers Japanese from script, below the auto-list threshold', () => {
    const { attributes } = parseTitle({ title: '【PSA10】リザードンex 201/165' });
    expect(attributes.language.value).toBe('JAPANESE');
    expect(attributes.language.confidence).toBeLessThan(1);
  });

  it('leaves language unknown when there is no signal at all', () => {
    const { attributes, warnings } = parseTitle({ title: 'PSA10 201/165' });
    expect(attributes.language.value).toBeNull();
    expect(warnings.some((w) => w.code === 'UNKNOWN_LANGUAGE')).toBe(true);
  });
});

describe('parseTitle — warnings gate listing', () => {
  it('flags a grade that is not 10 as an error', () => {
    const { warnings } = parseTitle({ title: '【PSA9】リザードンex 201/165' });
    expect(warnings.some((w) => w.code === 'NOT_GRADE_10' && w.severity === 'ERROR')).toBe(true);
  });

  it('drops overall confidence when a gating field is missing', () => {
    const { overallConfidence } = parseTitle({ title: 'PSA10 201/165' });
    expect(overallConfidence).toBe(0); // language unknown
  });

  it('excludes set name and year from the gating confidence', () => {
    // Both are legitimately unknown; a good parse must not be dragged down.
    const { overallConfidence } = parseTitle({
      title: '【PSA10】リザードンex SAR 201/165 黒煙の支配者',
    });
    expect(overallConfidence).toBeGreaterThan(0.85);
  });
});
