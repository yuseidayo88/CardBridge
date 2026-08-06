import { describe, expect, it } from 'vitest';
import { detectPsa10 } from './psa-detector';

const psaCategory = {
  breadcrumbs: ['ホーム', 'ポケモンカード', 'PSA10'],
  sourceCategoryUrl: 'https://example.test/product-group/14',
};

describe('detectPsa10 — accepts a well-corroborated PSA 10', () => {
  it('confirms when title, category and Pokémon identity all agree', () => {
    const result = detectPsa10({
      title: '【PSA10】リザードンex SAR 201/165 黒煙の支配者',
      ...psaCategory,
    });
    expect(result.verdict).toBe('CONFIRMED');
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('confirms on structured data even when the title is terse', () => {
    const result = detectPsa10({
      title: 'リザードンex 201/165',
      structuredGradingCompany: 'PSA',
      structuredGrade: 10,
      ...psaCategory,
    });
    expect(result.verdict).toBe('CONFIRMED');
  });

  it('handles full-width text', () => {
    const result = detectPsa10({
      title: '【ＰＳＡ１０】ピカチュウ　ＡＲ　１１２／１０８',
      description: 'ポケモンカード',
      ...psaCategory,
    });
    expect(result.verdict).toBe('CONFIRMED');
  });
});

describe('detectPsa10 — a title claim alone is never enough', () => {
  it('sends an uncorroborated PSA 10 to review rather than confirming it', () => {
    const result = detectPsa10({ title: 'PSA10 リザードン' });
    // Pokémon is identified, but there is no category and no description:
    // only two signals, so this is not auto-listable.
    expect(result.verdict).toBe('REVIEW');
    expect(result.reasons.join(' ')).toMatch(/not corroborated/);
  });

  it('reviews rather than rejects when it cannot tell what game it is', () => {
    // A PSA category, but nothing anywhere identifies the game. Surfacing this
    // for a human beats guessing in either direction.
    const result = detectPsa10({
      title: 'PSA10 なにかのカード 001/100',
      breadcrumbs: ['ホーム', 'PSA10'],
      sourceCategoryUrl: 'https://example.test/product-group/14',
    });
    expect(result.verdict).toBe('REVIEW');
    expect(result.reasons.join(' ')).toMatch(/Pok/);
  });

  it('accepts the shop category as the Pokémon signal when the title is vague', () => {
    // Conversely: if the breadcrumb says ポケモンカード, that is a real signal.
    const result = detectPsa10({ title: 'PSA10 なにかのカード 001/100', ...psaCategory });
    expect(result.verdict).toBe('CONFIRMED');
  });
});

describe('detectPsa10 — disqualifiers', () => {
  it('rejects "PSA10相当", which means ungraded', () => {
    const result = detectPsa10({
      title: 'リザードンex PSA10相当 美品 201/165',
      ...psaCategory,
    });
    expect(result.verdict).toBe('REJECTED');
    expect(result.reasons.join(' ')).toMatch(/ungraded/);
  });

  it('rejects grades below 10', () => {
    for (const title of ['【PSA9】リザードンex', 'PSA 8 ピカチュウ', '【PSA1】テスト']) {
      expect(detectPsa10({ title, ...psaCategory }).verdict).toBe('REJECTED');
    }
  });

  it('does not read the 10 in PSA10 as a lower grade', () => {
    expect(detectPsa10({ title: '【PSA10】リザードンex', ...psaCategory }).verdict).toBe(
      'CONFIRMED',
    );
  });

  it('rejects other grading companies', () => {
    for (const title of ['BGS9.5 リザードン', 'CGC 10 ピカチュウ', 'ARS10 ミュウ']) {
      expect(detectPsa10({ title, ...psaCategory }).verdict).toBe('REJECTED');
    }
  });

  it('rejects ungraded items', () => {
    expect(detectPsa10({ title: '未鑑定 リザードンex 201/165', ...psaCategory }).verdict).toBe(
      'REJECTED',
    );
  });

  it('rejects boxes, packs and supplies', () => {
    const titles = [
      '【PSA10】ポケモンカード 黒煙の支配者 BOX',
      'ポケモンカード 拡張パック 未開封',
      'ポケモンカード スリーブ リザードン',
      'デッキケース ポケモン',
    ];
    for (const title of titles) {
      expect(detectPsa10({ title, ...psaCategory }).verdict).toBe('REJECTED');
    }
  });

  it('rejects bundles', () => {
    for (const title of ['PSA10 ポケモンカード まとめ売り', 'PSA10 リザードン 10枚セット']) {
      expect(detectPsa10({ title, ...psaCategory }).verdict).toBe('REJECTED');
    }
  });

  it('rejects damage notes, which contradict a gem mint grade', () => {
    expect(detectPsa10({ title: 'PSA10 リザードンex 傷あり', ...psaCategory }).verdict).toBe(
      'REJECTED',
    );
  });
});

describe('detectPsa10 — other trading card games are out of scope', () => {
  it('rejects non-Pokémon TCGs even with a valid PSA 10 claim', () => {
    const cases: Array<[string, string]> = [
      ['【PSA10】ブラック・マジシャン 遊戯王', 'Yu-Gi-Oh'],
      ['【PSA10】ONE PIECEカード ルフィ', 'One Piece'],
      ['【PSA10】MTG Black Lotus', 'MTG'],
      ['【PSA10】デュエルマスターズ ボルメテウス', 'Duel Masters'],
      ['【PSA10】ヴァイスシュヴァルツ', 'Weiss'],
      ['【PSA10】ドラゴンボールヒーローズ', 'Dragon Ball'],
    ];
    for (const [title, label] of cases) {
      const result = detectPsa10({ title, ...psaCategory });
      expect(result.verdict, `${label} should be rejected`).toBe('REJECTED');
    }
  });
});

describe('detectPsa10 — structured data overrides an optimistic title', () => {
  it('rejects when structured data contradicts the title', () => {
    const result = detectPsa10({
      title: '【PSA10】リザードンex 201/165',
      structuredGradingCompany: 'PSA',
      structuredGrade: 9,
      ...psaCategory,
    });
    expect(result.verdict).toBe('REJECTED');
    expect(result.reasons.join(' ')).toMatch(/structured data/);
  });
});

describe('detectPsa10 — evidence is always explained', () => {
  it('records every signal considered, including the ones that did not fire', () => {
    const result = detectPsa10({ title: '【PSA10】リザードンex SAR', ...psaCategory });
    expect(result.evidence.length).toBeGreaterThan(5);
    expect(result.evidence.some((e) => e.found === false)).toBe(true);
    expect(result.evidence.some((e) => e.signal === 'title_psa10' && e.found)).toBe(true);
  });

  it('gives a reason whenever the verdict is not CONFIRMED', () => {
    for (const title of ['PSA10 なぞのカード', '未鑑定 リザードン', 'PSA9 ピカチュウ']) {
      const result = detectPsa10({ title, ...psaCategory });
      if (result.verdict !== 'CONFIRMED') {
        expect(result.reasons.length).toBeGreaterThan(0);
      }
    }
  });

  it('does not let a shop category word disqualify an item', () => {
    // "パック" in a breadcrumb is the shop's navigation, not this item.
    const result = detectPsa10({
      title: '【PSA10】リザードンex SAR 201/165',
      breadcrumbs: ['ホーム', '拡張パック', 'PSA10'],
      sourceCategoryUrl: 'https://example.test/product-group/14',
    });
    expect(result.verdict).toBe('CONFIRMED');
  });
});
