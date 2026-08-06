import { describe, expect, it } from 'vitest';
import { scoreMatch, rankCandidates, type MatchScoringInput } from './scoring';
import { buildBlockingKey, buildMatchKey, isCompleteMatchKey } from './match-key';

const charizard = (over: Partial<MatchScoringInput> = {}): MatchScoringInput => ({
  cardNameJa: 'リザードンex',
  cardNameEn: null,
  cardNumber: '201/165',
  setCode: 'SV2a',
  setName: '黒煙の支配者',
  rarity: 'SAR',
  releaseYear: 2023,
  language: 'JAPANESE',
  gradingCompany: 'PSA',
  grade: 10,
  ...over,
});

describe('match keys', () => {
  it('is stable across spacing and case differences', () => {
    expect(buildMatchKey(charizard())).toBe(
      buildMatchKey(charizard({ cardNameJa: 'リザードン ex', setCode: 'sv2a' })),
    );
  });

  it('marks a key incomplete when any identity field is unknown', () => {
    expect(isCompleteMatchKey(buildMatchKey(charizard()))).toBe(true);
    expect(isCompleteMatchKey(buildMatchKey(charizard({ setCode: null })))).toBe(false);
    expect(isCompleteMatchKey(buildMatchKey(charizard({ cardNumber: null })))).toBe(false);
  });

  it('does not let a missing field collide with a present one', () => {
    // "?" as a placeholder rather than omission: otherwise a key with no set
    // code could equal a key whose fields happen to shift left.
    expect(buildMatchKey(charizard({ setCode: null }))).not.toBe(
      buildMatchKey(charizard({ setCode: 'SV2a' })),
    );
  });

  it('blocks on the cheap discriminating fields only', () => {
    expect(buildBlockingKey(charizard())).toBe(
      buildBlockingKey(charizard({ cardNameJa: 'まったく別の名前', setName: null })),
    );
  });
});

describe('scoreMatch — genuine matches', () => {
  it('auto-merges the same card from two shops', () => {
    const result = scoreMatch(charizard(), charizard({ cardNameJa: 'リザードン ex' }), 'cat-1');
    expect(result.decision).toBe('AUTO_MERGE');
    expect(result.score).toBeGreaterThanOrEqual(0.95);
    expect(result.blockers).toHaveLength(0);
  });

  it('explains its reasoning signal by signal', () => {
    const result = scoreMatch(charizard(), charizard(), 'cat-1');
    expect(result.signals.cardNumber?.matched).toBe(true);
    expect(result.signals.setCode?.matched).toBe(true);
    expect(result.signals.cardName?.note).toMatch(/similarity/);
  });
});

describe('scoreMatch — the card-number-alone rule', () => {
  it('never auto-merges on a shared card number when set codes differ', () => {
    // 006/165 exists in more than one set. This is the mis-merge that ships
    // the wrong card to a buyer.
    const a = charizard({ cardNumber: '006/165', setCode: 'SV2a', setName: null, rarity: null });
    const b = charizard({
      cardNumber: '006/165',
      setCode: 'SV1a',
      setName: null,
      rarity: null,
      cardNameJa: 'リザードンex',
    });

    const result = scoreMatch(a, b, 'cat-1');
    expect(result.decision).toBe('REJECT');
    expect(result.blockers.join(' ')).toMatch(/different set codes/);
  });

  it('sends a shared card number with unknown set codes to review, not auto-merge', () => {
    const a = charizard({ setCode: null, setName: null, releaseYear: null, rarity: null });
    const b = charizard({ setCode: null, setName: null, releaseYear: null, rarity: null });

    const result = scoreMatch(a, b, 'cat-1');
    // Name and number agree perfectly, so the score is high — but the set code
    // is unknown on both sides, so identity is not pinned down.
    expect(result.score).toBeGreaterThanOrEqual(0.95);
    expect(result.decision).toBe('REVIEW');
    expect(result.blockers.join(' ')).toMatch(/card number and a set code/);
  });
});

describe('scoreMatch — vetoes', () => {
  it('rejects different grades', () => {
    const result = scoreMatch(charizard(), charizard({ grade: 9 }), 'cat-1');
    expect(result.decision).toBe('REJECT');
    expect(result.blockers.join(' ')).toMatch(/different grades/);
  });

  it('rejects different grading companies', () => {
    const result = scoreMatch(charizard(), charizard({ gradingCompany: 'BGS' }), 'cat-1');
    expect(result.decision).toBe('REJECT');
  });

  it('rejects different languages', () => {
    const result = scoreMatch(charizard(), charizard({ language: 'ENGLISH' }), 'cat-1');
    expect(result.decision).toBe('REJECT');
    expect(result.blockers.join(' ')).toMatch(/different languages/);
  });

  it('rejects different card numbers even when everything else agrees', () => {
    const result = scoreMatch(charizard(), charizard({ cardNumber: '202/165' }), 'cat-1');
    expect(result.decision).toBe('REJECT');
  });

  it('sends a year conflict to review rather than rejecting outright', () => {
    // Everything else agrees, including the set code — so one of the two years
    // is simply wrong metadata rather than evidence of a different card. Year
    // is the least reliable field (often catalog lookup or AI), so treating a
    // mismatch as decisive would reject genuine matches over bad data.
    const result = scoreMatch(charizard(), charizard({ releaseYear: 2021 }), 'cat-1');
    expect(result.decision).toBe('REVIEW');
    expect(result.blockers.join(' ')).toMatch(/different release years/);
  });

  it('rejects a similar but different card', () => {
    // リザードンex vs リザードンV — one character apart, different cards.
    const result = scoreMatch(
      charizard(),
      charizard({ cardNameJa: 'リザードンV', cardNumber: '100/165' }),
      'cat-1',
    );
    expect(result.decision).toBe('REJECT');
  });
});

describe('scoreMatch — partial information', () => {
  it('does not punish a pair for a field neither shop published', () => {
    const a = charizard({ rarity: null, setName: null, releaseYear: null });
    const b = charizard({ rarity: null, setName: null, releaseYear: null });
    const result = scoreMatch(a, b, 'cat-1');
    // Only number, set code and name were evaluable, and all three agree.
    expect(result.score).toBe(1);
    expect(result.decision).toBe('AUTO_MERGE');
  });

  it('scores zero when nothing at all can be compared', () => {
    const empty: MatchScoringInput = {
      cardNameJa: null,
      cardNumber: null,
      setCode: null,
      language: null,
      gradingCompany: null,
      grade: null,
    };
    const result = scoreMatch(empty, empty, 'cat-1');
    expect(result.score).toBe(0);
    expect(result.decision).toBe('REJECT');
  });

  it('reviews a plausible but unconfirmed pair', () => {
    const a = charizard({ setCode: null, rarity: null, releaseYear: null, setName: null });
    const b = charizard({
      setCode: null,
      rarity: null,
      releaseYear: null,
      setName: null,
      cardNameJa: 'リザードンex SAR',
    });
    const result = scoreMatch(a, b, 'cat-1');
    expect(result.decision).toBe('REVIEW');
  });
});

describe('rankCandidates', () => {
  it('drops rejects and orders the rest best-first', () => {
    const candidates = [
      scoreMatch(charizard(), charizard({ cardNameJa: 'リザードンex SAR' }), 'cat-2'),
      scoreMatch(charizard(), charizard(), 'cat-1'),
      scoreMatch(charizard(), charizard({ grade: 9 }), 'cat-3'),
    ];

    const ranked = rankCandidates(candidates);
    expect(ranked.map((c) => c.catalogProductId)).not.toContain('cat-3');
    expect(ranked[0]?.catalogProductId).toBe('cat-1');
  });
});
