/**
 * eBay English title construction.
 *
 * The requirement is explicit that the AI must not free-write titles. So the
 * title is assembled here from structured fields, deterministically, and the
 * AI's only contribution is the English card name — one field, validated
 * separately.
 *
 * That split matters for a reason beyond compliance: eBay title search is
 * token-based, and a title is a keyword budget, not prose. Assembling it from
 * known fields in a fixed priority order means the 80 characters go to the
 * tokens buyers actually search for, every time.
 *
 * Nothing here invents a value. A missing year is simply absent from the title.
 */

export interface TitleBuilderInput {
  cardNameEn: string;
  cardNumber?: string | null;
  setNameEn?: string | null;
  rarity?: string | null;
  releaseYear?: number | null;
  language: 'JAPANESE' | 'ENGLISH' | 'CHINESE' | 'KOREAN' | 'OTHER';
  gradingCompany: string;
  grade: number;
}

export interface TitleBuildResult {
  title: string;
  length: number;
  /** Segments left out because the budget ran out. */
  omitted: string[];
  warnings: string[];
}

/** eBay's hard cap. Exceeding it is ErrorCode 70. */
export const EBAY_TITLE_MAX_LENGTH = 80;

const LANGUAGE_LABEL: Record<TitleBuilderInput['language'], string | null> = {
  JAPANESE: 'Japanese',
  ENGLISH: null, // English cards are the default on eBay.com; the word wastes budget
  CHINESE: 'Chinese',
  KOREAN: 'Korean',
  OTHER: null,
};

/**
 * Words that make a claim we cannot substantiate from the data.
 *
 * eBay's listing policies treat unsupported superlatives as keyword spam, and
 * they are exactly what an unconstrained language model reaches for. Checked
 * against the assembled title so that a bad English card name is caught too.
 */
const PROHIBITED_TERMS = [
  'authentic',
  'genuine',
  'rare',
  'super rare',
  'ultra rare',
  'l@@k',
  'look',
  'wow',
  'must see',
  'best',
  'perfect',
  'flawless',
  'investment',
  'hot',
  'l👀k',
];

export function buildEbayTitle(input: TitleBuilderInput): TitleBuildResult {
  const warnings: string[] = [];
  const omitted: string[] = [];

  // Ordered by search value. The first four are effectively mandatory: they are
  // what a buyer types. Year and set name are useful but expendable.
  const segments: Array<{ text: string; essential: boolean; label: string }> = [];

  if (input.releaseYear != null) {
    segments.push({ text: String(input.releaseYear), essential: false, label: 'year' });
  }

  segments.push({ text: 'Pokemon', essential: true, label: 'game' });

  const languageLabel = LANGUAGE_LABEL[input.language];
  if (languageLabel) {
    segments.push({ text: languageLabel, essential: true, label: 'language' });
  }

  const cardName = sanitizeSegment(input.cardNameEn);
  if (!cardName) {
    warnings.push('card name is empty — a title cannot be built without it');
    return { title: '', length: 0, omitted: [], warnings };
  }
  segments.push({ text: cardName, essential: true, label: 'card name' });

  if (input.setNameEn) {
    segments.push({ text: sanitizeSegment(input.setNameEn), essential: false, label: 'set name' });
  }
  if (input.cardNumber) {
    segments.push({ text: sanitizeSegment(input.cardNumber), essential: false, label: 'number' });
  }
  if (input.rarity) {
    segments.push({ text: sanitizeSegment(input.rarity), essential: false, label: 'rarity' });
  }

  // The grade is the point of the listing and goes last, where eBay's own
  // graded-card titles put it.
  segments.push({
    text: `${input.gradingCompany} ${formatGrade(input.grade)}`,
    essential: true,
    label: 'grade',
  });
  if (input.grade === 10 && input.gradingCompany.toUpperCase() === 'PSA') {
    segments.push({ text: 'GEM MINT', essential: false, label: 'gem mint' });
  }

  // Fit to budget by dropping the least valuable optional segments first.
  let selected = segments.filter((s) => s.essential || true);
  let title = join(selected);

  // Least search value first. The English set name goes first: it is the
  // longest segment and the one buyers are least likely to type — Japanese set
  // names have no settled English form, so nobody searches for them. The card
  // number survives longest because it is what disambiguates one printing from
  // another, and "GEM MINT" outranks the set name because it is a phrase
  // buyers actually search for on PSA 10 listings.
  const droppableOrder = ['set name', 'rarity', 'gem mint', 'year', 'number'];
  for (const label of droppableOrder) {
    if (title.length <= EBAY_TITLE_MAX_LENGTH) break;
    const index = selected.findIndex((s) => s.label === label && !s.essential);
    if (index >= 0) {
      omitted.push(label);
      selected = selected.filter((_, i) => i !== index);
      title = join(selected);
    }
  }

  if (title.length > EBAY_TITLE_MAX_LENGTH) {
    // Only the card name can still be too long. Truncate on a word boundary
    // rather than mid-word, which reads as a mistake to a buyer.
    const overflow = title.length - EBAY_TITLE_MAX_LENGTH;
    const nameSegment = selected.find((s) => s.label === 'card name');
    if (nameSegment) {
      const trimmed = truncateOnWord(nameSegment.text, nameSegment.text.length - overflow);
      nameSegment.text = trimmed;
      title = join(selected);
      warnings.push('the card name was truncated to fit the 80-character limit');
    }
  }

  if (title.length > EBAY_TITLE_MAX_LENGTH) {
    title = title.slice(0, EBAY_TITLE_MAX_LENGTH).trim();
    warnings.push('title had to be hard-truncated at 80 characters');
  }

  // --- validation ---------------------------------------------------------
  const lower = title.toLowerCase();
  for (const term of PROHIBITED_TERMS) {
    // Word-boundary match so "Rarity" does not trip on "rare".
    if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) {
      warnings.push(`title contains the unsupported promotional term "${term}"`);
    }
  }
  if (/[^\x20-\x7E]/.test(title)) {
    warnings.push('title contains non-ASCII characters, which eBay search handles poorly');
  }
  if (!/PSA|BGS|CGC|SGC|ARS/i.test(title)) {
    warnings.push('title does not state the grading company');
  }
  if (input.language === 'JAPANESE' && !/japanese/i.test(title)) {
    warnings.push('title does not state that the card is Japanese');
  }

  return { title, length: title.length, omitted, warnings };
}

function join(segments: Array<{ text: string }>): string {
  return segments
    .map((s) => s.text)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip characters that add no search value and waste the budget. */
function sanitizeSegment(text: string): string {
  return text
    .replace(/[【】[\]（）()]/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateOnWord(text: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

function formatGrade(grade: number): string {
  return Number.isInteger(grade) ? String(grade) : grade.toFixed(1);
}
