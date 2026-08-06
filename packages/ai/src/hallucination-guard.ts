/**
 * Mechanical detection of invented facts in AI output.
 *
 * A schema proves the response is well-formed; it says nothing about whether
 * the model made the content up. The requirement is explicit that years, card
 * numbers and set names must never be guessed, and asking the model nicely is
 * not a control — an LLM that invents "2021" will also confidently report high
 * confidence about it.
 *
 * So every factual token in the output is checked against the source text it
 * was supposed to be derived from. A number that appears in the output but
 * nowhere in the input did not come from the input.
 *
 * This is deliberately a blunt instrument. It produces false positives (a
 * legitimately translated set name may contain a number the Japanese title
 * wrote in kanji), and that is the right trade: a false positive costs one
 * manual review, a false negative ships a fabricated year to eBay.
 */

export interface HallucinationFlag {
  field: string;
  value: string;
  reason: string;
  severity: 'BLOCKING' | 'REVIEW';
}

export interface GuardInput {
  /** Everything the model was given: title, description, breadcrumbs. */
  sourceText: string;
  /** Field paths whose values must be traceable to the source. */
  output: Record<string, unknown>;
  /**
   * Fields exempt from the numeric check because they are legitimately
   * generated prose rather than extracted facts.
   */
  generativeFields?: readonly string[];
}

const DEFAULT_GENERATIVE_FIELDS = ['descriptionEn', 'warnings', 'confidence'] as const;

/** Numbers that carry no factual claim and appear in ordinary English prose. */
const HARMLESS_NUMBERS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '100']);

/**
 * Every distinct number in a string, including ones embedded in words.
 *
 * Card numbers ("201/165") are split into their components so that a model
 * echoing only half of one is still traced.
 */
function extractNumbers(text: string): string[] {
  return [...text.matchAll(/\d+/g)].map((m) => m[0]).filter((n) => !HARMLESS_NUMBERS.has(n));
}

/**
 * Years are checked separately and more strictly.
 *
 * A fabricated release year is the single most damaging invention available to
 * this system: it looks entirely plausible in an eBay title, a reviewer has no
 * way to spot it, and it silently degrades search relevance for the listing's
 * whole life.
 */
function extractYears(text: string): string[] {
  return [...text.matchAll(/\b(19[89]\d|20[0-4]\d)\b/g)].map((m) => m[0]);
}

export function detectHallucinations(input: GuardInput): HallucinationFlag[] {
  const flags: HallucinationFlag[] = [];
  const generative = new Set<string>([
    ...DEFAULT_GENERATIVE_FIELDS,
    ...(input.generativeFields ?? []),
  ]);

  const sourceNumbers = new Set(extractNumbers(input.sourceText));
  const sourceYears = new Set(extractYears(input.sourceText));

  const walk = (value: unknown, path: string): void => {
    if (value === null || value === undefined) return;

    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, path ? `${path}.${key}` : key);
      }
      return;
    }
    if (typeof value !== 'string' && typeof value !== 'number') return;

    const leafField =
      path
        .split('.')
        .pop()
        ?.replace(/\[\d+\]$/, '') ?? path;
    if (generative.has(leafField) || generative.has(path)) return;

    const text = String(value);

    // Years first: any year in the output that is not in the source is a
    // fabrication, full stop.
    for (const year of extractYears(text)) {
      if (!sourceYears.has(year)) {
        flags.push({
          field: path,
          value: text,
          reason: `the year ${year} does not appear anywhere in the source text`,
          severity: 'BLOCKING',
        });
      }
    }

    // Other numbers: card numbers, set numbers, quantities.
    for (const number of extractNumbers(text)) {
      if (extractYears(text).includes(number)) continue; // already handled
      if (!sourceNumbers.has(number)) {
        flags.push({
          field: path,
          value: text,
          reason: `the number ${number} does not appear anywhere in the source text`,
          severity: 'BLOCKING',
        });
      }
    }
  };

  walk(input.output, '');

  // Deduplicate: one flag per field/reason pair is enough.
  const seen = new Set<string>();
  return flags.filter((f) => {
    const key = `${f.field}|${f.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Drop item specifics the category does not actually offer.
 *
 * A model asked to produce eBay item specifics will invent aspect names that
 * sound right. eBay rejects unknown aspects, and the error it returns is not
 * informative, so they are filtered here against the real aspect list from
 * getItemAspectsForCategory.
 */
export function filterToAllowedAspects(
  itemSpecifics: Record<string, string>,
  allowedAspectNames: readonly string[],
): { accepted: Record<string, string>; rejected: string[] } {
  const allowed = new Map(allowedAspectNames.map((name) => [name.trim().toLowerCase(), name]));
  const accepted: Record<string, string> = {};
  const rejected: string[] = [];

  for (const [name, value] of Object.entries(itemSpecifics)) {
    const canonical = allowed.get(name.trim().toLowerCase());
    if (canonical) {
      // Use eBay's own spelling, not the model's.
      accepted[canonical] = value;
    } else {
      rejected.push(name);
    }
  }

  return { accepted, rejected };
}

/** True when nothing in the flags list can be waved through automatically. */
export function hasBlockingFlags(flags: readonly HallucinationFlag[]): boolean {
  return flags.some((f) => f.severity === 'BLOCKING');
}
