import type { MatchCandidate, MatchDecision } from '../types/catalog';
import { stringSimilarity } from '../parsing/normalizers';
import { buildMatchKey, isCompleteMatchKey, type MatchKeyInput } from './match-key';

/**
 * Deciding whether two shops are selling the same card.
 *
 * The asymmetry here is deliberate and is the whole design. A missed match
 * costs us a duplicate catalog entry, which an admin can merge in ten seconds.
 * A false match means two different cards share one eBay listing, and a buyer
 * receives something other than what they bought — an eBay defect, a return,
 * and a hit to seller standing.
 *
 * So the rule from the requirements is enforced literally: a shared card
 * number is never sufficient. Card numbers repeat across sets (006/165 exists
 * in many of them), and two cards with the same number and different set codes
 * are definitively different cards.
 */

export interface MatchScoringInput extends MatchKeyInput {
  setName?: string | null;
  rarity?: string | null;
  releaseYear?: number | null;
}

export interface ScoringThresholds {
  autoMerge: number;
  review: number;
}

export const DEFAULT_THRESHOLDS: ScoringThresholds = {
  autoMerge: 0.95,
  review: 0.75,
};

interface SignalResult {
  matched: boolean;
  weight: number;
  note?: string;
}

/**
 * Signal weights.
 *
 * Card number and set code dominate because together they identify a card
 * uniquely. Name similarity is weighted lower than it intuitively deserves:
 * shops write names differently, and "リザードンex" vs "リザードンex(SAR)" is
 * the same card while "リザードンex" vs "リザードンV" is not — a difference of
 * one character.
 */
const WEIGHTS = {
  cardNumber: 0.3,
  setCode: 0.25,
  cardName: 0.25,
  rarity: 0.1,
  releaseYear: 0.05,
  setName: 0.05,
} as const;

/**
 * Conditions that make an automatic merge impossible regardless of score.
 *
 * These are not penalties — they are vetoes. A blocker means the pair goes to a
 * human or is rejected outright, even if every other signal agrees.
 */
function findBlockers(a: MatchScoringInput, b: MatchScoringInput): string[] {
  const blockers: string[] = [];

  // Different grade or grading company means different products, full stop.
  if (a.gradingCompany && b.gradingCompany && a.gradingCompany !== b.gradingCompany) {
    blockers.push(`different grading companies: ${a.gradingCompany} vs ${b.gradingCompany}`);
  }
  if (a.grade != null && b.grade != null && a.grade !== b.grade) {
    blockers.push(`different grades: ${a.grade} vs ${b.grade}`);
  }
  if (a.language && b.language && a.language !== b.language) {
    blockers.push(`different languages: ${a.language} vs ${b.language}`);
  }

  // Two known, different set codes with the same card number are two different
  // cards that happen to share a collector number. This is precisely the
  // mis-merge the requirements call out.
  if (a.setCode && b.setCode && a.setCode.toUpperCase() !== b.setCode.toUpperCase()) {
    blockers.push(`different set codes: ${a.setCode} vs ${b.setCode}`);
  }

  if (a.cardNumber && b.cardNumber) {
    const an = a.cardNumber.toUpperCase().replace(/\s/g, '');
    const bn = b.cardNumber.toUpperCase().replace(/\s/g, '');
    if (an !== bn) {
      blockers.push(`different card numbers: ${a.cardNumber} vs ${b.cardNumber}`);
    }
  }

  // Different known release years cannot be the same printing.
  if (a.releaseYear != null && b.releaseYear != null && a.releaseYear !== b.releaseYear) {
    blockers.push(`different release years: ${a.releaseYear} vs ${b.releaseYear}`);
  }

  return blockers;
}

export function scoreMatch(
  a: MatchScoringInput,
  b: MatchScoringInput,
  catalogProductId: string,
  thresholds: ScoringThresholds = DEFAULT_THRESHOLDS,
): MatchCandidate {
  const signals: Record<string, SignalResult> = {};
  const blockers = findBlockers(a, b);

  // --- card number --------------------------------------------------------
  const bothNumbers = a.cardNumber != null && b.cardNumber != null;
  const numbersEqual =
    bothNumbers &&
    a.cardNumber!.toUpperCase().replace(/\s/g, '') ===
      b.cardNumber!.toUpperCase().replace(/\s/g, '');
  signals.cardNumber = {
    matched: numbersEqual,
    weight: WEIGHTS.cardNumber,
    note: bothNumbers
      ? numbersEqual
        ? 'card numbers agree'
        : 'card numbers differ'
      : 'card number missing on at least one side',
  };

  // --- set code -----------------------------------------------------------
  const bothSetCodes = a.setCode != null && b.setCode != null;
  const setCodesEqual = bothSetCodes && a.setCode!.toUpperCase() === b.setCode!.toUpperCase();
  signals.setCode = {
    matched: setCodesEqual,
    weight: WEIGHTS.setCode,
    note: bothSetCodes
      ? setCodesEqual
        ? 'set codes agree'
        : 'set codes differ'
      : 'set code missing on at least one side',
  };

  // --- card name ----------------------------------------------------------
  const nameA = a.cardNameEn ?? a.cardNameJa;
  const nameB = b.cardNameEn ?? b.cardNameJa;
  const nameSimilarity = nameA && nameB ? stringSimilarity(nameA, nameB) : 0;
  signals.cardName = {
    matched: nameSimilarity >= 0.9,
    weight: WEIGHTS.cardName * nameSimilarity,
    note: `name similarity ${nameSimilarity.toFixed(3)}`,
  };

  // --- rarity -------------------------------------------------------------
  const bothRarities = a.rarity != null && b.rarity != null;
  const raritiesEqual = bothRarities && a.rarity!.toUpperCase() === b.rarity!.toUpperCase();
  signals.rarity = {
    matched: raritiesEqual,
    weight: WEIGHTS.rarity,
    note: bothRarities ? (raritiesEqual ? 'rarities agree' : 'rarities differ') : 'rarity missing',
  };

  // --- release year -------------------------------------------------------
  const bothYears = a.releaseYear != null && b.releaseYear != null;
  const yearsEqual = bothYears && a.releaseYear === b.releaseYear;
  signals.releaseYear = {
    matched: yearsEqual,
    weight: WEIGHTS.releaseYear,
    note: bothYears ? (yearsEqual ? 'years agree' : 'years differ') : 'year missing',
  };

  // --- set name -----------------------------------------------------------
  const bothSetNames = a.setName != null && b.setName != null;
  const setNameSimilarity = bothSetNames ? stringSimilarity(a.setName!, b.setName!) : 0;
  signals.setName = {
    matched: setNameSimilarity >= 0.9,
    weight: WEIGHTS.setName * setNameSimilarity,
    note: bothSetNames ? `set name similarity ${setNameSimilarity.toFixed(3)}` : 'set name missing',
  };

  // --- aggregate ----------------------------------------------------------
  //
  // Scored against the weight of the signals that could actually be evaluated,
  // so a pair whose set code is unknown on both sides is not punished for a
  // field neither shop published. Unevaluable signals are excluded from both
  // numerator and denominator.
  let earned = 0;
  let available = 0;

  const addBinary = (key: keyof typeof WEIGHTS, evaluable: boolean, matched: boolean) => {
    if (!evaluable) return;
    available += WEIGHTS[key];
    if (matched) earned += WEIGHTS[key];
  };
  const addGraded = (key: keyof typeof WEIGHTS, evaluable: boolean, ratio: number) => {
    if (!evaluable) return;
    available += WEIGHTS[key];
    earned += WEIGHTS[key] * ratio;
  };

  addBinary('cardNumber', bothNumbers, numbersEqual);
  addBinary('setCode', bothSetCodes, setCodesEqual);
  addGraded('cardName', Boolean(nameA && nameB), nameSimilarity);
  addBinary('rarity', bothRarities, raritiesEqual);
  addBinary('releaseYear', bothYears, yearsEqual);
  addGraded('setName', bothSetNames, setNameSimilarity);

  const score = available > 0 ? earned / available : 0;

  // --- decision -----------------------------------------------------------
  let decision: MatchDecision;
  if (blockers.length > 0) {
    // A veto never becomes an auto-merge. Where the conflict is decisive
    // (different number, set, grade, language) the pair is rejected; anything
    // softer goes to a human.
    const decisive = blockers.some((b) =>
      /card numbers|set codes|grades|grading companies|languages/.test(b),
    );
    decision = decisive ? 'REJECT' : 'REVIEW';
  } else if (score < thresholds.review) {
    decision = 'REJECT';
  } else if (score >= thresholds.autoMerge) {
    // The final gate: auto-merge additionally requires that both sides are
    // fully identified. A high score computed from two or three known fields
    // is not the same as a confident identification.
    const keyA = buildMatchKey(a);
    const keyB = buildMatchKey(b);
    const identified = isCompleteMatchKey(keyA) && isCompleteMatchKey(keyB);
    const structurallyPinned = numbersEqual && setCodesEqual;

    decision = identified && structurallyPinned ? 'AUTO_MERGE' : 'REVIEW';
    if (!structurallyPinned) {
      blockers.push('auto-merge requires both a card number and a set code on both sides');
    } else if (!identified) {
      blockers.push('auto-merge requires every identity field to be known on both sides');
    }
  } else {
    decision = 'REVIEW';
  }

  return {
    catalogProductId,
    score,
    decision,
    signals: Object.fromEntries(
      Object.entries(signals).map(([k, v]) => [
        k,
        { matched: v.matched, weight: v.weight, ...(v.note ? { note: v.note } : {}) },
      ]),
    ),
    blockers,
  };
}

/** Rank candidates best-first, dropping anything decisively rejected. */
export function rankCandidates(candidates: MatchCandidate[]): MatchCandidate[] {
  return candidates.filter((c) => c.decision !== 'REJECT').sort((a, b) => b.score - a.score);
}
