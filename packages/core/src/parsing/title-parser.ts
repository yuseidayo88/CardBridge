import { attributed, unknownAttribute, type Attributed } from '../types/attributed';
import type {
  CardLanguage,
  GradingCompany,
  ParsedCardAttributes,
  ParseWarning,
} from '../types/supplier';
import {
  extractCardNumber,
  extractRarity,
  extractSetCode,
  normalizeTitle,
  stripAnnotations,
} from './normalizers';

/**
 * Deterministic parsing of Japanese card listing titles.
 *
 * The requirement is explicit that regex alone must not be forced to handle
 * every product, and that unknown values stay null rather than being guessed.
 * This module therefore does only what it can do *reliably*, and returns
 * `unknown` for everything else — leaving the gaps visible for structured data,
 * catalog lookup or (last) an LLM to fill, each of which records its own lower
 * provenance.
 *
 * The rule that matters most: release year and set name are NEVER inferred
 * here. A card number tells you nothing about a year, and a plausible-looking
 * wrong year in an eBay title actively harms search relevance while looking
 * perfectly fine to a reviewer.
 */

export interface TitleParseInput {
  title: string;
  /** Values already established by structured data, which always win. */
  structured?: {
    cardName?: string | null;
    cardNumber?: string | null;
    setName?: string | null;
    setCode?: string | null;
    rarity?: string | null;
    gradingCompany?: string | null;
    grade?: number | null;
    releaseYear?: number | null;
  };
  /** Shop-specific extraction, applied before the generic patterns. */
  supplierRules?: SupplierTitleRule[];
}

/**
 * A shop-specific extraction rule.
 *
 * Lives in supplier configuration rather than in this file, so that a shop with
 * an unusual title convention does not require a change to shared parsing code.
 */
export interface SupplierTitleRule {
  field: keyof ParsedCardAttributes;
  /** Applied to the normalised title. Capture group 1 becomes the value. */
  pattern: string;
  confidence: number;
}

export interface TitleParseResult {
  attributes: ParsedCardAttributes;
  warnings: ParseWarning[];
  /** Confidence over the fields that gate listing eligibility. */
  overallConfidence: number;
}

/**
 * Note the lookahead rather than a trailing \b: shops write "PSA10" with no
 * separator, and there is no word boundary between "A" and "1", so `\bPSA\b`
 * silently fails on the single most common form in the entire dataset.
 */
const GRADING_COMPANY_PATTERNS: Array<[RegExp, GradingCompany]> = [
  [/\bPSA(?![A-Za-z])/i, 'PSA'],
  [/\bBGS(?![A-Za-z])/i, 'BGS'],
  [/\bCGC(?![A-Za-z])/i, 'CGC'],
  [/\bSGC(?![A-Za-z])/i, 'SGC'],
  [/\bARS(?![A-Za-z])/i, 'ARS'],
];

/**
 * Language detection.
 *
 * Japanese script in the title is strong evidence of a Japanese card, because
 * these are Japanese shops selling to a Japanese domestic market. An explicit
 * "英語版" marker overrides it.
 */
const JAPANESE_SCRIPT = /[぀-ゟ゠-ヿ一-龯]/;

function detectLanguage(title: string): Attributed<CardLanguage> {
  const normalized = normalizeTitle(title);

  if (/(英語版|英語表記|\bENG?\b|english)/i.test(normalized)) {
    return attributed<CardLanguage>('ENGLISH', 'title_parser', 0.95, 'explicit English marker');
  }
  if (/(中国語版|繁体字|簡体字|chinese)/i.test(normalized)) {
    return attributed<CardLanguage>('CHINESE', 'title_parser', 0.95, 'explicit Chinese marker');
  }
  if (/(韓国語版|한국어|korean)/i.test(normalized)) {
    return attributed<CardLanguage>('KOREAN', 'title_parser', 0.95, 'explicit Korean marker');
  }
  if (JAPANESE_SCRIPT.test(normalized)) {
    // Not certain — a Japanese shop can describe an English card in Japanese —
    // so this is deliberately below the auto-list confidence threshold.
    return attributed<CardLanguage>(
      'JAPANESE',
      'title_parser',
      0.9,
      'Japanese script in the title, no foreign-language marker',
    );
  }
  return unknownAttribute<CardLanguage>('no language signal in the title');
}

function detectGradingCompany(title: string): Attributed<GradingCompany> {
  const normalized = normalizeTitle(title);
  for (const [pattern, company] of GRADING_COMPANY_PATTERNS) {
    if (pattern.test(normalized)) {
      return attributed<GradingCompany>(company, 'title_parser', 1, `matched ${pattern.source}`);
    }
  }
  return unknownAttribute<GradingCompany>('no grading company in the title');
}

function detectGrade(title: string): Attributed<number> {
  const normalized = normalizeTitle(title);
  // Anchored to a grading company so that "10" from a card number or a set
  // size is never read as a grade.
  const match = /\b(?:PSA|BGS|CGC|SGC|ARS)\s*(10|[1-9](?:\.5)?)\b/i.exec(normalized);
  if (!match) return unknownAttribute<number>('no grade adjacent to a grading company');

  const grade = Number(match[1]);
  if (!Number.isFinite(grade) || grade < 1 || grade > 10) {
    return unknownAttribute<number>(`grade ${match[1]} is out of range`);
  }
  return attributed(grade, 'title_parser', 1, `grade ${grade} adjacent to a grading company`);
}

/**
 * Recover the card name.
 *
 * Strips bracketed annotations, the grading claim, the card number and the
 * rarity, and keeps what remains. Conservative by design: an over-eager strip
 * that removes part of the name is worse than leaving a stray token, because
 * the name feeds both matching and the English title.
 */
function extractCardName(title: string): Attributed<string> {
  let working = stripAnnotations(title);

  working = working
    .replace(/\b(?:PSA|BGS|CGC|SGC|ARS)\s*(?:10|[1-9](?:\.5)?)\b/gi, ' ')
    .replace(/\b\d{1,3}\s*\/\s*(?:\d{1,3}|[A-Z]{1,3}-?P)\b/gi, ' ')
    .replace(/\b(SAR|SSR|CSR|CHR|RRR|UR|HR|SR|RR|AR|PROMO)\b/g, ' ')
    .replace(/\b(S[VM]?\d{1,2}[A-Z]?|XY\d{1,2}[A-Z]?)\b/gi, ' ')
    .replace(/(美品|新品|中古|送料無料|即決|鑑定品|日本語版)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (working.length === 0) {
    return unknownAttribute<string>('nothing left after stripping annotations');
  }
  // A single stray character is not a card name.
  if (working.length < 2) {
    return unknownAttribute<string>(`residue too short to be a card name: ${working}`);
  }

  // Lower confidence when the residue is long: it probably still carries set
  // names or seller boilerplate that a human should look at.
  const confidence = working.length <= 40 ? 0.9 : 0.6;
  return attributed(working, 'title_parser', confidence, 'residue after stripping annotations');
}

export function parseTitle(input: TitleParseInput): TitleParseResult {
  const { title, structured, supplierRules = [] } = input;
  const normalized = normalizeTitle(title);
  const warnings: ParseWarning[] = [];

  // --- generic deterministic pass -----------------------------------------
  const cardNumberRaw = extractCardNumber(normalized);
  const rarityRaw = extractRarity(normalized);
  const setCodeRaw = extractSetCode(normalized);

  const attributes: ParsedCardAttributes = {
    cardNameJa: extractCardName(normalized),
    // The English name is never derived from a Japanese title by string
    // manipulation. It comes from catalog lookup or AI translation later.
    cardNameEn: unknownAttribute<string>('English name requires catalog lookup or translation'),
    cardNumber: cardNumberRaw
      ? attributed(cardNumberRaw, 'title_parser', 0.95, 'matched a card-number pattern')
      : unknownAttribute<string>('no card number pattern in the title'),
    setCode: setCodeRaw
      ? attributed(setCodeRaw, 'title_parser', 0.8, 'matched a set-code pattern')
      : unknownAttribute<string>('no set code in the title'),
    // Set name and release year are deliberately never inferred here.
    setName: unknownAttribute<string>('set name requires catalog lookup'),
    releaseYear: unknownAttribute<number>('release year requires catalog lookup — never inferred'),
    rarity: rarityRaw
      ? attributed(rarityRaw, 'title_parser', 0.9, 'matched a rarity code')
      : unknownAttribute<string>('no rarity code in the title'),
    language: detectLanguage(normalized),
    gradingCompany: detectGradingCompany(normalized),
    grade: detectGrade(normalized),
    conditionNote: unknownAttribute<string>('condition notes come from the detail page'),
  };

  // --- shop-specific rules override the generic pass -----------------------
  for (const rule of supplierRules) {
    try {
      const match = new RegExp(rule.pattern).exec(normalized);
      const captured = match?.[1]?.trim();
      if (captured) {
        // Cast is confined here: the rule names a field, and every field on
        // ParsedCardAttributes is an Attributed of some type.
        (attributes as Record<string, Attributed<unknown>>)[rule.field] = attributed(
          captured,
          'supplier_rule',
          rule.confidence,
          `supplier rule ${rule.pattern}`,
        );
      }
    } catch {
      warnings.push({
        code: 'INVALID_SUPPLIER_RULE',
        message: `Supplier rule for ${rule.field} is not a valid regular expression`,
        severity: 'ERROR',
        field: rule.field,
      });
    }
  }

  // --- structured data wins over everything automated ----------------------
  if (structured) {
    const apply = <K extends keyof ParsedCardAttributes>(
      field: K,
      value: unknown,
      confidence = 1,
    ) => {
      if (value === null || value === undefined || value === '') return;
      (attributes as Record<string, Attributed<unknown>>)[field] = attributed(
        value,
        'structured_data',
        confidence,
        'from the page structured data',
      );
    };

    apply('cardNameJa', structured.cardName);
    apply('cardNumber', structured.cardNumber);
    apply('setName', structured.setName);
    apply('setCode', structured.setCode);
    apply('rarity', structured.rarity);
    apply('releaseYear', structured.releaseYear);
    if (structured.gradingCompany) {
      const upper = structured.gradingCompany.toUpperCase();
      const known = (['PSA', 'BGS', 'CGC', 'SGC', 'ARS'] as const).find((c) => c === upper);
      apply('gradingCompany', known ?? 'OTHER');
    }
    apply('grade', structured.grade);
  }

  // --- warnings ------------------------------------------------------------
  if (attributes.cardNumber.value === null) {
    warnings.push({
      code: 'MISSING_CARD_NUMBER',
      message: 'No card number found. Matching and eBay identification will be unreliable.',
      severity: 'WARN',
      field: 'cardNumber',
    });
  }
  if (attributes.cardNameJa.value === null) {
    warnings.push({
      code: 'MISSING_CARD_NAME',
      message: 'Could not recover a card name from the title.',
      severity: 'ERROR',
      field: 'cardNameJa',
    });
  }
  if (attributes.language.value === null) {
    warnings.push({
      code: 'UNKNOWN_LANGUAGE',
      message: 'Language could not be determined.',
      severity: 'WARN',
      field: 'language',
    });
  }
  if (attributes.grade.value !== null && attributes.grade.value !== 10) {
    warnings.push({
      code: 'NOT_GRADE_10',
      message: `Parsed grade is ${attributes.grade.value}, not 10.`,
      severity: 'ERROR',
      field: 'grade',
    });
  }

  // Confidence over the fields that actually gate a listing. Set name and
  // release year are excluded: they are legitimately unknown at this stage and
  // must not drag a good parse below the threshold.
  const gatingFields = [
    attributes.cardNameJa,
    attributes.cardNumber,
    attributes.language,
    attributes.gradingCompany,
    attributes.grade,
  ];
  const overallConfidence = gatingFields.reduce((min, a) => Math.min(min, a.confidence), 1);

  return { attributes, warnings, overallConfidence };
}
