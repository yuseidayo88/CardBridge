import { Money } from '../types/money';
import type { PsaVerdict } from '../types/catalog';
import type { ProfitBreakdown } from '../profit/cost-model';
import { EBAY_TITLE_MAX_LENGTH } from './title-builder';

/**
 * The final gate before a listing can be published.
 *
 * Every condition the requirements list is checked here, in one place, and the
 * result is a list of specific blockers rather than a boolean. That shape is
 * deliberate: "not eligible" is useless to an operator, while "PSA verdict is
 * REVIEW; pessimistic scenario loses ¥340; no sold comparables" tells them
 * exactly what to fix.
 *
 * Nothing here is advisory. An item with any blocker cannot be published, and
 * the guard in @cardbridge/ebay will not mint an authorization for it.
 */

export type BlockerSeverity =
  /** Cannot be listed until resolved. */
  | 'BLOCKING'
  /** Requires a human decision, but a human may override. */
  | 'REVIEW';

export interface EligibilityBlocker {
  code: string;
  message: string;
  severity: BlockerSeverity;
}

export interface EligibilityInput {
  psaVerdict: PsaVerdict;
  parseConfidence: number;
  aiConfidence: number | null;
  aiWarnings: string[];

  hasImages: boolean;
  imageProcessingApproved: boolean;
  imageProcessingConfidence: number | null;
  /** True when the photo may not be of the exact slab being shipped. */
  usesRepresentativeImage: boolean;

  availableStock: number;
  ebayQuantity: number;

  cardNameEn: string | null;
  cardNumber: string | null;
  language: string | null;
  title: string | null;
  /** Required eBay Item Specifics that are still empty. */
  missingRequiredAspects: string[];
  conditionDescriptorsResolved: boolean;

  profitBase: ProfitBreakdown;
  profitPessimistic: ProfitBreakdown;

  /** True when there are enough sold comparables to price against. */
  marketDataSufficient: boolean;

  /** Another live listing already exists for this catalog product. */
  duplicateListingExists: boolean;

  sellingPrice: string;
  saleCurrency: Parameters<typeof Money.fromString>[1];
}

export interface EligibilityThresholds {
  minParseConfidence: number;
  minAiConfidence: number;
  minImageProcessingConfidence: number;
  minProfitJpy: string;
  minProfitMarginPercent: string;
  highValueThreshold: string;
  /** Reject a price this many times the market median as anomalous. */
  anomalousPriceMultiplier: string;
}

export const DEFAULT_ELIGIBILITY_THRESHOLDS: EligibilityThresholds = {
  minParseConfidence: 0.85,
  minAiConfidence: 0.85,
  minImageProcessingConfidence: 0.9,
  minProfitJpy: '1500',
  minProfitMarginPercent: '15',
  highValueThreshold: '200',
  anomalousPriceMultiplier: '3',
};

export interface EligibilityResult {
  eligible: boolean;
  /** True when only REVIEW-severity issues remain. */
  requiresManualReview: boolean;
  blockers: EligibilityBlocker[];
}

export function evaluateEligibility(
  input: EligibilityInput,
  thresholds: EligibilityThresholds = DEFAULT_ELIGIBILITY_THRESHOLDS,
): EligibilityResult {
  const blockers: EligibilityBlocker[] = [];
  const block = (code: string, message: string, severity: BlockerSeverity = 'BLOCKING') =>
    blockers.push({ code, message, severity });

  // --- identity -----------------------------------------------------------
  if (input.psaVerdict === 'REJECTED') {
    block('NOT_PSA10', 'This item is not a PSA 10 Pokémon single.');
  } else if (input.psaVerdict === 'REVIEW') {
    block('PSA_UNCONFIRMED', 'PSA 10 status is not corroborated; a human must confirm.', 'REVIEW');
  }

  if (input.parseConfidence < thresholds.minParseConfidence) {
    block(
      'LOW_PARSE_CONFIDENCE',
      `Parse confidence ${input.parseConfidence.toFixed(2)} is below the ${thresholds.minParseConfidence} threshold.`,
    );
  }

  if (!input.cardNameEn) block('MISSING_CARD_NAME_EN', 'No English card name.');
  if (!input.cardNumber) {
    block(
      'MISSING_CARD_NUMBER',
      'No card number; the card cannot be identified reliably.',
      'REVIEW',
    );
  }
  if (!input.language) block('UNKNOWN_LANGUAGE', 'Card language is unknown.');

  // --- images -------------------------------------------------------------
  if (!input.hasImages) {
    block('NO_IMAGES', 'No usable images.');
  } else {
    if (!input.imageProcessingApproved) {
      block('IMAGE_NOT_APPROVED', 'Image processing has not been approved by an admin.');
    }
    if (
      input.imageProcessingConfidence !== null &&
      input.imageProcessingConfidence < thresholds.minImageProcessingConfidence
    ) {
      block(
        'LOW_IMAGE_CONFIDENCE',
        `Image processing confidence ${input.imageProcessingConfidence.toFixed(2)} is below the ${thresholds.minImageProcessingConfidence} threshold.`,
      );
    }
  }

  if (input.usesRepresentativeImage) {
    // Graded singles are one-of-a-kind items, and eBay permits stock imagery
    // only for new goods. A disclaimer in the description does not resolve
    // this, so it never clears automatically.
    block(
      'REPRESENTATIVE_IMAGE',
      'The listing image may not be the exact slab being shipped. Graded singles are unique items; this needs an explicit decision.',
      'REVIEW',
    );
  }

  // --- stock --------------------------------------------------------------
  if (input.availableStock <= 0) block('OUT_OF_STOCK', 'No sellable stock at any supplier.');
  if (input.ebayQuantity <= 0) block('ZERO_QUANTITY', 'Computed eBay quantity is zero.');

  // --- eBay requirements --------------------------------------------------
  if (!input.title) {
    block('MISSING_TITLE', 'No English title has been generated.');
  } else if (input.title.length > EBAY_TITLE_MAX_LENGTH) {
    block(
      'TITLE_TOO_LONG',
      `Title is ${input.title.length} characters; eBay allows ${EBAY_TITLE_MAX_LENGTH}.`,
    );
  }

  if (input.missingRequiredAspects.length > 0) {
    block(
      'MISSING_REQUIRED_ASPECTS',
      `Required eBay item specifics are empty: ${input.missingRequiredAspects.join(', ')}.`,
    );
  }
  if (!input.conditionDescriptorsResolved) {
    block(
      'CONDITION_DESCRIPTORS_UNRESOLVED',
      'Condition descriptors could not be resolved from the cached eBay metadata.',
    );
  }

  // --- AI -----------------------------------------------------------------
  if (input.aiConfidence !== null && input.aiConfidence < thresholds.minAiConfidence) {
    block(
      'LOW_AI_CONFIDENCE',
      `AI confidence ${input.aiConfidence.toFixed(2)} is below the ${thresholds.minAiConfidence} threshold.`,
    );
  }
  if (input.aiWarnings.length > 0) {
    block('AI_WARNINGS', `AI generation raised warnings: ${input.aiWarnings.join('; ')}`, 'REVIEW');
  }

  // --- profitability ------------------------------------------------------
  const minProfit = Money.fromString(thresholds.minProfitJpy, 'JPY');
  const minMargin = Number(thresholds.minProfitMarginPercent);

  if (input.profitBase.profitJpy.lessThan(minProfit)) {
    block(
      'BELOW_MIN_PROFIT',
      `Base-case profit ${input.profitBase.profitJpy.round().toString()} JPY is below the ${thresholds.minProfitJpy} JPY floor.`,
    );
  }
  if (Number(input.profitBase.marginPercent) < minMargin) {
    block(
      'BELOW_MIN_MARGIN',
      `Base-case margin ${input.profitBase.marginPercent}% is below the ${minMargin}% floor.`,
    );
  }

  // The scenario that decides whether this is a real opportunity: an item that
  // is only profitable when the yen behaves and nothing comes back is not one.
  if (!input.profitPessimistic.profit.isPositive()) {
    block(
      'PESSIMISTIC_LOSS',
      `Pessimistic scenario loses ${input.profitPessimistic.profitJpy.round().abs().toString()} JPY.`,
    );
  }

  for (const warning of [...input.profitBase.warnings, ...input.profitPessimistic.warnings]) {
    if (/carrier quote|manual review/.test(warning)) {
      block('CUSTOMS_UNDETERMINED', warning, 'REVIEW');
    }
    if (/purchase price is zero|selling price is zero/.test(warning)) {
      block('INVALID_PRICE', warning);
    }
  }

  // --- market data --------------------------------------------------------
  if (!input.marketDataSufficient) {
    block(
      'INSUFFICIENT_MARKET_DATA',
      'Not enough sold comparables to price against. Confirm the market price manually.',
      'REVIEW',
    );
  }

  // --- anomalies ----------------------------------------------------------
  const price = Money.fromString(input.sellingPrice, input.saleCurrency);
  if (!price.isPositive()) {
    block('INVALID_PRICE', 'Selling price is zero or negative.');
  }

  const highValue = Money.fromString(thresholds.highValueThreshold, input.saleCurrency);
  if (price.greaterThanOrEqual(highValue)) {
    block(
      'HIGH_VALUE',
      `Price ${price.toFixed()} is at or above the ${highValue.toFixed()} high-value threshold and needs manual approval.`,
      'REVIEW',
    );
  }

  // --- duplicates ---------------------------------------------------------
  if (input.duplicateListingExists) {
    block('DUPLICATE_LISTING', 'A live listing already exists for this card.');
  }

  const hasBlocking = blockers.some((b) => b.severity === 'BLOCKING');
  const hasReview = blockers.some((b) => b.severity === 'REVIEW');

  return {
    eligible: blockers.length === 0,
    requiresManualReview: !hasBlocking && hasReview,
    blockers,
  };
}
