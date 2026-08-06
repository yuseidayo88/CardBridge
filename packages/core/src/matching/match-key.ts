import type { CardLanguage, GradingCompany } from '../types/supplier';
import { normalizeForComparison } from '../parsing/normalizers';

/**
 * The identity of a physical card, as a deterministic string.
 *
 * Used for blocking (cheaply narrowing candidates) and as a stable key. It is
 * NOT used as proof of identity on its own — two products sharing a match key
 * still go through scoring, because a key built from partially-unknown fields
 * can collide.
 */

export interface MatchKeyInput {
  cardNameJa: string | null;
  cardNameEn?: string | null;
  cardNumber: string | null;
  setCode: string | null;
  language: CardLanguage | null;
  gradingCompany: GradingCompany | null;
  grade: number | null;
}

/** Unknown components become "?" rather than being omitted, so that a key with
 *  a missing field can never accidentally equal one with a different field. */
const UNKNOWN = '?';

export function buildMatchKey(input: MatchKeyInput): string {
  const name = input.cardNameEn
    ? normalizeForComparison(input.cardNameEn)
    : input.cardNameJa
      ? normalizeForComparison(input.cardNameJa)
      : UNKNOWN;

  const parts = [
    name || UNKNOWN,
    input.cardNumber?.toUpperCase().replace(/\s/g, '') ?? UNKNOWN,
    input.setCode?.toUpperCase() ?? UNKNOWN,
    input.language ?? UNKNOWN,
    input.gradingCompany ?? UNKNOWN,
    input.grade != null ? String(input.grade) : UNKNOWN,
  ];

  return parts.join('|');
}

/**
 * True when a key is complete enough to be trusted for automatic merging.
 *
 * A key containing "?" describes a card we cannot fully identify, and merging
 * on it risks combining two different cards into one listing — which would
 * mean shipping the wrong card to a buyer.
 */
export function isCompleteMatchKey(key: string): boolean {
  return !key.split('|').includes(UNKNOWN);
}

/**
 * Blocking key: the cheap prefilter that decides which pairs are even worth
 * scoring. Uses only the fields that are both discriminating and reliably
 * present, so the candidate set stays small without dropping real matches.
 */
export function buildBlockingKey(input: MatchKeyInput): string {
  return [
    input.cardNumber?.toUpperCase().replace(/\s/g, '') ?? UNKNOWN,
    input.language ?? UNKNOWN,
    input.gradingCompany ?? UNKNOWN,
    input.grade != null ? String(input.grade) : UNKNOWN,
  ].join('|');
}
