/**
 * Text normalisation for Japanese card listings.
 *
 * Japanese storefronts mix full-width and half-width characters freely: the
 * same card number appears as "201/165" on one shop and "２０１／１６５" on
 * another, and "ＰＳＡ１０" and "PSA 10" are the same claim. Without a
 * normalisation pass, every downstream regex has to handle both forms, and
 * matching would treat identical cards as different.
 *
 * All normalisation happens here, once, before any parsing.
 */

/** Full-width ASCII (U+FF01–U+FF5E) maps to half-width by a fixed offset. */
const FULLWIDTH_OFFSET = 0xfee0;

export function toHalfWidth(input: string): string {
  return (
    input
      .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - FULLWIDTH_OFFSET))
      // U+3000 ideographic space, written as an escape so it is visible in a
      // diff and does not trip the irregular-whitespace lint.
      .replace(/\u3000/g, ' ')
      .replace(/[｡-ﾟ]/g, (ch) => ch)
  ); // leave half-width katakana alone
}

/**
 * Normalise for parsing: half-width, collapsed whitespace, unified brackets.
 *
 * Bracket styles carry no meaning here — 【PSA10】 and [PSA10] say the same
 * thing — so they are unified rather than stripped, which keeps them usable as
 * token boundaries.
 */
export function normalizeTitle(input: string): string {
  return (
    toHalfWidth(input)
      .replace(/[【〔［[]/g, '[')
      .replace(/[】〕］\]]/g, ']')
      .replace(/[（(]/g, '(')
      .replace(/[）)]/g, ')')
      .replace(/[／]/g, '/')
      // Dashes only. U+30FC (ー) is deliberately NOT in this set: it is the
      // katakana long-vowel mark, a letter, not punctuation. Folding it to "-"
      // turns リザードン into リザ-ドン and breaks every katakana card name.
      .replace(/[—–―]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Aggressive normalisation for identity comparison only.
 *
 * Used by matching to decide whether two card names refer to the same card.
 * Never store the output — it is lossy by design.
 */
export function normalizeForComparison(input: string): string {
  return (
    normalizeTitle(input)
      .toLowerCase()
      .replace(/[[\]()]/g, ' ')
      .replace(/[・･\-_,.'"]/g, '')
      // Spaces are removed entirely, not collapsed. Shops are inconsistent
      // about them — "リザードンex" and "リザードン ex" are the same card — and
      // leaving one space in makes an identical card score 0.875 instead of 1.
      .replace(/\s+/g, '')
      .trim()
  );
}

/**
 * Parse a Japanese price string into a plain decimal string.
 *
 * Returns null rather than guessing. A price that cannot be read is a parse
 * failure that belongs in the warnings list, not a zero that silently makes an
 * item look free.
 */
export function parseJpyPrice(input: string): string | null {
  const normalized = toHalfWidth(input);
  // Match the first run of digits with optional thousands separators, ignoring
  // any currency marks or tax annotations around it.
  const match = /(\d{1,3}(?:,\d{3})+|\d+)/.exec(normalized.replace(/\s/g, ''));
  if (!match) return null;

  const digits = match[1]!.replace(/,/g, '');
  if (!/^\d+$/.test(digits)) return null;
  return digits;
}

/**
 * Card numbers as printed on Japanese Pokémon cards.
 *
 * The canonical form is "NNN/NNN" (collection number / set size). Promos use
 * a different shape entirely ("123/SM-P", "001/S-P"), so both are recognised.
 */
const CARD_NUMBER_PATTERNS: RegExp[] = [
  // 201/165, 006/165 — the common case
  /\b(\d{1,3}\s*\/\s*\d{1,3})\b/,
  // 123/SM-P, 001/S-P, 045/XY-P — promo numbering
  /\b(\d{1,3}\s*\/\s*[A-Z]{1,3}-?P)\b/i,
  // SV1a 001, S12a 190 — set code followed by a number
  /\b([A-Z]{1,3}\d{1,2}[a-z]?\s+\d{1,3})\b/,
];

export function extractCardNumber(title: string): string | null {
  const normalized = normalizeTitle(title);
  for (const pattern of CARD_NUMBER_PATTERNS) {
    const match = pattern.exec(normalized);
    if (match) {
      return match[1]!.replace(/\s+/g, '').toUpperCase();
    }
  }
  return null;
}

/**
 * Japanese Pokémon TCG rarity codes.
 *
 * Only exact token matches count. "SR" appearing inside a card name must not
 * be read as a rarity, so matching is anchored on token boundaries.
 */
const RARITY_CODES = [
  'SAR',
  'SSR',
  'CSR',
  'CHR',
  'UR',
  'HR',
  'SR',
  'RRR',
  'RR',
  'AR',
  'PROMO',
  'K',
] as const;

export function extractRarity(title: string): string | null {
  const normalized = normalizeTitle(title).toUpperCase();
  // Longest first, so "SAR" is not shadowed by "AR".
  const ordered = [...RARITY_CODES].sort((a, b) => b.length - a.length);
  for (const code of ordered) {
    const pattern = new RegExp(`(?:^|[\\s\\[\\]()/])${code}(?:$|[\\s\\[\\]()/])`);
    if (pattern.test(normalized)) return code;
  }
  return null;
}

/**
 * Set codes such as SV1a, S12a, SM12, XY8.
 *
 * Deliberately conservative: a false positive here propagates into the match
 * key and can merge two different cards.
 */
export function extractSetCode(title: string): string | null {
  const normalized = normalizeTitle(title).toUpperCase();
  const match = /\b(S[VM]?\d{1,2}[A-Z]?|XY\d{1,2}[A-Z]?|SM\d{1,2}[A-Z]?)\b/.exec(normalized);
  return match ? match[1]! : null;
}

/** Strip bracketed annotations to recover the card name itself. */
export function stripAnnotations(title: string): string {
  return normalizeTitle(title)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Levenshtein-based similarity in 0..1.
 *
 * Used by matching to compare card names. Kept simple and dependency-free;
 * card names are short, so the O(n·m) cost is irrelevant.
 */
export function stringSimilarity(a: string, b: string): number {
  const s1 = normalizeForComparison(a);
  const s2 = normalizeForComparison(b);
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const rows = s1.length + 1;
  const cols = s2.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);
  let current = new Array<number>(cols).fill(0);

  for (let i = 1; i < rows; i += 1) {
    current[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }

  const distance = previous[cols - 1]!;
  return 1 - distance / Math.max(s1.length, s2.length);
}
