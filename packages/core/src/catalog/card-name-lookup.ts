import { normalizeForComparison } from '../parsing/normalizers';
import { attributed, unknownAttribute, type Attributed } from '../types/attributed';

/**
 * Japanese card name to official English name.
 *
 * This exists because "リザードンex" -> "Charizard ex" is a lookup, not a
 * transformation. No amount of string manipulation gets there, and romanising
 * produces "Rizadon ex", which nobody searches for on eBay.
 *
 * A curated table is preferred over asking a model, for one reason that matters
 * more than cost: a model that does not know a card will produce a plausible
 * English name anyway, and a plausible wrong name is indistinguishable from a
 * right one to the reviewer who has to approve it. A lookup either has the
 * answer or says it does not.
 */

export interface CardNameEntry {
  /** As printed on the card, before normalisation. Kept for display. */
  nameJa: string;
  /** Official English release name. */
  nameEn: string;
  /** e.g. "sv4a". Null when the entry is name-only. */
  setCode: string | null;
  /** e.g. "006/165". Null when the entry is name-only. */
  cardNumber: string | null;
  /** Where the row came from: an official list, an admin, an import. */
  source: string;
  /** False for rows that still need a human to confirm them. */
  verified: boolean;
}

export interface CardNameQuery {
  nameJa: string;
  setCode?: string | null;
  cardNumber?: string | null;
}

export type LookupPrecision =
  /** Name, set and number all agreed. Nothing else can be this specific. */
  | 'EXACT'
  /** Name and number agreed; the query carried no set code. */
  | 'NAME_AND_NUMBER'
  /** Only the name matched, and it matched exactly one entry. */
  | 'NAME_ONLY'
  /** The name matched several entries with different English names. */
  | 'AMBIGUOUS'
  | 'NOT_FOUND';

export interface CardNameResult {
  precision: LookupPrecision;
  nameEn: Attributed<string>;
  /** Populated when precision is AMBIGUOUS, so a human can pick. */
  candidates: CardNameEntry[];
}

/**
 * Confidence per precision.
 *
 * NAME_ONLY is deliberately below the 0.85 default publish floor. A Pokémon
 * name is reprinted across many sets, and matching on the name alone is right
 * far more often than not — but "far more often than not" is exactly the case
 * that should reach a human rather than a live listing.
 */
const PRECISION_CONFIDENCE: Record<Exclude<LookupPrecision, 'NOT_FOUND' | 'AMBIGUOUS'>, number> = {
  EXACT: 1,
  NAME_AND_NUMBER: 0.95,
  NAME_ONLY: 0.7,
};

/** The key a name-only comparison uses. Spaces and width folded away. */
export function cardNameKey(nameJa: string): string {
  return normalizeForComparison(nameJa);
}

/**
 * An index built once and queried many times.
 *
 * The alternative — scanning an array per product — is fine at a hundred cards
 * and quietly terrible at fifty thousand, which is the size this table reaches
 * once a full set list is imported.
 */
export class CardNameCatalog {
  private readonly byName = new Map<string, CardNameEntry[]>();

  constructor(entries: readonly CardNameEntry[] = []) {
    for (const entry of entries) this.add(entry);
  }

  add(entry: CardNameEntry): void {
    const key = cardNameKey(entry.nameJa);
    const bucket = this.byName.get(key);
    if (bucket) bucket.push(entry);
    else this.byName.set(key, [entry]);
  }

  get size(): number {
    let total = 0;
    for (const bucket of this.byName.values()) total += bucket.length;
    return total;
  }

  lookup(query: CardNameQuery): CardNameResult {
    const bucket = this.byName.get(cardNameKey(query.nameJa));

    if (!bucket || bucket.length === 0) {
      return { precision: 'NOT_FOUND', nameEn: unknownAttribute<string>(), candidates: [] };
    }

    const number = query.cardNumber ? normalizeForComparison(query.cardNumber) : null;
    const setCode = query.setCode ? normalizeForComparison(query.setCode) : null;

    // Most specific first. An entry that agrees on set *and* number is the only
    // kind that can be trusted without a second look, because reprints share
    // both a name and, across sets, sometimes a number.
    if (setCode && number) {
      const exact = bucket.filter(
        (e) =>
          e.setCode !== null &&
          e.cardNumber !== null &&
          normalizeForComparison(e.setCode) === setCode &&
          normalizeForComparison(e.cardNumber) === number,
      );
      const resolved = resolve(exact, 'EXACT');
      if (resolved) return resolved;
    }

    if (number) {
      const byNumber = bucket.filter(
        (e) => e.cardNumber !== null && normalizeForComparison(e.cardNumber) === number,
      );
      const resolved = resolve(byNumber, 'NAME_AND_NUMBER');
      if (resolved) return resolved;
    }

    return resolve(bucket, 'NAME_ONLY') ?? ambiguous(bucket);
  }
}

/**
 * Turn a set of candidate rows into a result.
 *
 * Entries that disagree on English name are ambiguous; entries that merely
 * duplicate the same English name are not. That distinction matters because a
 * card legitimately appears in the table once per set, and treating those
 * duplicates as a conflict would make every popular card unresolvable.
 */
function resolve(entries: CardNameEntry[], precision: keyof typeof PRECISION_CONFIDENCE) {
  if (entries.length === 0) return null;

  const distinct = new Set(entries.map((e) => e.nameEn));
  if (distinct.size > 1) return ambiguous(entries);

  const chosen = entries[0]!;
  // An unverified row can still be used, but never at a confidence that would
  // let it publish unattended.
  const confidence = chosen.verified
    ? PRECISION_CONFIDENCE[precision]
    : Math.min(PRECISION_CONFIDENCE[precision], 0.6);

  return {
    precision: precision as LookupPrecision,
    nameEn: attributed(
      chosen.nameEn,
      'catalog_lookup',
      confidence,
      `${precision} / ${chosen.source}`,
    ),
    candidates: [],
  } satisfies CardNameResult;
}

function ambiguous(entries: CardNameEntry[]): CardNameResult {
  return {
    precision: 'AMBIGUOUS',
    // No value at all, rather than picking one. Choosing arbitrarily here would
    // produce a listing under the wrong card's English name, which is the exact
    // failure this table exists to prevent.
    nameEn: unknownAttribute<string>(),
    candidates: entries,
  };
}
