import { createHash } from 'node:crypto';
import type { CardLanguage, GradingCompany } from '../types/supplier';
import { normalizeForComparison } from '../parsing/normalizers';

/**
 * SKU generation.
 *
 * A SKU is the primary key of the eBay side of the system, and the database
 * enforces one listing per SKU per marketplace. That makes it the mechanism
 * that prevents duplicate listings — so it has to be:
 *
 *   - deterministic: the same card always produces the same SKU, or a re-sync
 *     creates a second listing for a card already listed
 *   - collision-resistant: two different cards must never collide, or one
 *     listing silently overwrites another
 *   - stable: it must not change when unrelated metadata (price, stock, set
 *     name spelling) changes
 *   - readable: an operator looking at eBay should recognise the card
 *
 * The readable prefix is truncated and therefore lossy, so a hash of the full
 * identity is appended. The hash is what guarantees uniqueness; the prefix is
 * purely for human eyes.
 */

export interface SkuInput {
  cardNameEn: string | null;
  cardNameJa: string;
  cardNumber: string | null;
  setCode: string | null;
  language: CardLanguage;
  gradingCompany: GradingCompany;
  grade: number;
}

const PREFIX = 'CB';
const HASH_LENGTH = 8;
/** eBay allows 50; staying well under leaves room for future suffixes. */
const MAX_SKU_LENGTH = 40;

const LANGUAGE_CODE: Record<CardLanguage, string> = {
  JAPANESE: 'JP',
  ENGLISH: 'EN',
  CHINESE: 'ZH',
  KOREAN: 'KO',
  OTHER: 'XX',
};

/** Keep only characters that are safe in a SKU across every eBay surface. */
function sanitize(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
}

/**
 * The identity string that the hash is taken over.
 *
 * Uses the same normalisation as matching, so that two spellings of one card
 * produce one SKU. Fields absent from this string cannot affect the SKU —
 * which is what makes the SKU stable against price and stock changes.
 */
function identityString(input: SkuInput): string {
  return [
    normalizeForComparison(input.cardNameEn ?? input.cardNameJa),
    input.cardNumber?.toUpperCase().replace(/\s/g, '') ?? '',
    input.setCode?.toUpperCase() ?? '',
    input.language,
    input.gradingCompany,
    String(input.grade),
  ].join('|');
}

export function generateSku(input: SkuInput): string {
  const hash = createHash('sha256')
    .update(identityString(input))
    .digest('hex')
    .slice(0, HASH_LENGTH)
    .toUpperCase();

  // Readable portion: whichever identifying fragments exist.
  const readable = [
    input.setCode ? sanitize(input.setCode) : null,
    input.cardNumber ? sanitize(input.cardNumber) : null,
    LANGUAGE_CODE[input.language],
    `${input.gradingCompany}${formatGrade(input.grade)}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join('-');

  const sku = `${PREFIX}-${readable}-${hash}`;
  if (sku.length <= MAX_SKU_LENGTH) return sku;

  // Trim the readable portion, never the hash: uniqueness must survive.
  const budget = MAX_SKU_LENGTH - PREFIX.length - HASH_LENGTH - 2;
  return `${PREFIX}-${readable.slice(0, Math.max(0, budget))}-${hash}`;
}

function formatGrade(grade: number): string {
  return Number.isInteger(grade) ? String(grade) : String(grade).replace('.', '');
}

/** Cheap shape check for a SKU produced by this module. */
export function isValidSku(sku: string): boolean {
  return new RegExp(`^${PREFIX}-[A-Z0-9-]+-[A-F0-9]{${HASH_LENGTH}}$`).test(sku);
}
