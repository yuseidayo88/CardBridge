/**
 * Slab geometry.
 *
 * A PSA slab has a fixed layout: a label band across the top, the card below
 * it, and the certification number and barcode inside the label. So once the
 * slab's bounding box is known, the regions to redact are a matter of
 * proportion rather than recognition — and proportion is far more reliable than
 * OCR on a 400px shop thumbnail.
 *
 * Everything here is pure arithmetic on rectangles. No image library, no
 * network, fully testable — which matters because the safety checks below are
 * the thing standing between "mask the cert number" and "mask the card".
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type RegionKind = 'CERT_NUMBER' | 'BARCODE' | 'LABEL' | 'CARD';
export type DetectorSource = 'TEMPLATE' | 'BARCODE_SCAN' | 'OCR' | 'MANUAL';

export interface DetectedRegion extends Rect {
  kind: RegionKind;
  source: DetectorSource;
  confidence: number;
}

/**
 * PSA slab proportions.
 *
 * A slab is roughly 1.9 times taller than it is wide, and the label occupies
 * about the top 21%. Within the label, older and current generations place the
 * certification number and barcode differently, which is why generation is a
 * parameter rather than an assumption.
 */
export const SLAB_ASPECT_RATIO = 1.9;
export const SLAB_ASPECT_TOLERANCE = 0.35;

export type LabelGeneration = 'CURRENT' | 'LEGACY';

interface LabelLayout {
  /** Label band as a fraction of slab height, measured from the top. */
  labelHeightRatio: number;
  /** Cert number position within the label, as fractions of the label box. */
  certNumber: Rect;
  /** Barcode position within the label. */
  barcode: Rect;
}

/**
 * Layouts as fractions, never pixels.
 *
 * Shop thumbnails arrive at every size from 200px to 2000px; anything
 * expressed in pixels would be wrong for all but one of them.
 */
const LAYOUTS: Record<LabelGeneration, LabelLayout> = {
  CURRENT: {
    labelHeightRatio: 0.21,
    // Bottom-right of the label: "CERT #12345678"
    certNumber: { x: 0.52, y: 0.62, width: 0.46, height: 0.34 },
    // Bottom-left: the 1D barcode
    barcode: { x: 0.02, y: 0.58, width: 0.44, height: 0.38 },
  },
  LEGACY: {
    labelHeightRatio: 0.24,
    certNumber: { x: 0.55, y: 0.55, width: 0.43, height: 0.4 },
    barcode: { x: 0.02, y: 0.52, width: 0.48, height: 0.44 },
  },
};

export function rectArea(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

export function intersects(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

export function intersection(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

export function clampToBounds(rect: Rect, bounds: Size): Rect {
  const x = Math.max(0, Math.min(rect.x, bounds.width));
  const y = Math.max(0, Math.min(rect.y, bounds.height));
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(Math.max(0, Math.min(rect.width, bounds.width - x))),
    height: Math.round(Math.max(0, Math.min(rect.height, bounds.height - y))),
  };
}

/** Does this bounding box plausibly contain a graded slab? */
export function looksLikeSlab(slab: Rect): boolean {
  if (slab.width <= 0 || slab.height <= 0) return false;
  const ratio = slab.height / slab.width;
  return Math.abs(ratio - SLAB_ASPECT_RATIO) <= SLAB_ASPECT_TOLERANCE;
}

/** The label band, given the slab box. */
export function labelRegion(slab: Rect, generation: LabelGeneration = 'CURRENT'): Rect {
  const layout = LAYOUTS[generation];
  return {
    x: slab.x,
    y: slab.y,
    width: slab.width,
    height: slab.height * layout.labelHeightRatio,
  };
}

/**
 * The card itself — everything below the label.
 *
 * This is what must never be covered. A mask over the card is not a redaction,
 * it is a misrepresentation of the item.
 */
export function cardRegion(slab: Rect, generation: LabelGeneration = 'CURRENT'): Rect {
  const label = labelRegion(slab, generation);
  return {
    x: slab.x,
    y: label.y + label.height,
    width: slab.width,
    height: slab.height - label.height,
  };
}

/** Template-derived redaction regions, from the slab box alone. */
export function templateRegions(
  slab: Rect,
  generation: LabelGeneration = 'CURRENT',
  confidence = 0.7,
): DetectedRegion[] {
  const layout = LAYOUTS[generation];
  const label = labelRegion(slab, generation);

  const withinLabel = (fraction: Rect): Rect => ({
    x: label.x + label.width * fraction.x,
    y: label.y + label.height * fraction.y,
    width: label.width * fraction.width,
    height: label.height * fraction.height,
  });

  return [
    { ...withinLabel(layout.certNumber), kind: 'CERT_NUMBER', source: 'TEMPLATE', confidence },
    { ...withinLabel(layout.barcode), kind: 'BARCODE', source: 'TEMPLATE', confidence },
  ];
}

export interface ConsensusOptions {
  /** IoU above which two detections are considered the same region. */
  agreementThreshold?: number;
}

/**
 * Combine detections from several detectors into one region per kind.
 *
 * The requirement is explicit that OCR alone is not enough. Agreement between
 * independent detectors is what raises confidence: a template guess and a
 * barcode scan landing in the same place is meaningfully stronger evidence
 * than either on its own, because they fail in unrelated ways.
 */
export function consensusRegions(
  detections: readonly DetectedRegion[],
  options: ConsensusOptions = {},
): DetectedRegion[] {
  const threshold = options.agreementThreshold ?? 0.3;
  const byKind = new Map<RegionKind, DetectedRegion[]>();

  for (const detection of detections) {
    const list = byKind.get(detection.kind) ?? [];
    list.push(detection);
    byKind.set(detection.kind, list);
  }

  const result: DetectedRegion[] = [];

  for (const [kind, group] of byKind) {
    // A manual region is an admin's decision and overrides every detector.
    const manual = group.find((d) => d.source === 'MANUAL');
    if (manual) {
      result.push({ ...manual, confidence: 1 });
      continue;
    }

    const best = [...group].sort((a, b) => b.confidence - a.confidence)[0]!;
    const agreeing = group.filter(
      (d) => d !== best && iou(d, best) >= threshold && d.source !== best.source,
    );

    // Each independent corroboration adds confidence, capped below certainty:
    // agreement is evidence, not proof.
    const boosted = Math.min(0.99, best.confidence + 0.15 * agreeing.length);

    result.push({
      // Union of the agreeing boxes, so a slight offset in one detector does
      // not leave part of the number exposed.
      ...agreeing.reduce((acc, d) => union(acc, d), best as Rect),
      kind,
      source: best.source,
      confidence: agreeing.length > 0 ? boosted : best.confidence,
    });
  }

  return result;
}

export function iou(a: Rect, b: Rect): number {
  const overlap = rectArea(intersection(a, b));
  const total = rectArea(a) + rectArea(b) - overlap;
  return total <= 0 ? 0 : overlap / total;
}

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

export interface SafetyCheckInput {
  regions: readonly DetectedRegion[];
  slab: Rect;
  imageSize: Size;
  generation?: LabelGeneration;
  maxMaskAreaPercent: number;
  minConfidence: number;
}

export interface SafetyCheckResult {
  safe: boolean;
  failures: string[];
  totalMaskAreaPercent: number;
  lowestConfidence: number;
}

/**
 * The gate between a proposed mask and an applied one.
 *
 * Every failure here sends the image to manual review rather than producing a
 * best-effort result. A mask that covers the card, or one placed on a
 * low-confidence guess, is worse than no mask at all: it misrepresents the item
 * to a buyer, and it does so in a way that looks deliberate.
 */
export function checkMaskSafety(input: SafetyCheckInput): SafetyCheckResult {
  const failures: string[] = [];
  const card = cardRegion(input.slab, input.generation);

  let maskedArea = 0;
  let lowestConfidence = 1;

  for (const region of input.regions) {
    maskedArea += rectArea(region);
    lowestConfidence = Math.min(lowestConfidence, region.confidence);

    // The check that matters most.
    if (intersects(region, card)) {
      const overlap = rectArea(intersection(region, card));
      failures.push(
        `the ${region.kind} mask overlaps the card itself by ${Math.round(overlap)} square pixels`,
      );
    }

    if (region.x < 0 || region.y < 0) {
      failures.push(`the ${region.kind} mask starts outside the image`);
    }
    if (
      region.x + region.width > input.imageSize.width ||
      region.y + region.height > input.imageSize.height
    ) {
      failures.push(`the ${region.kind} mask extends past the edge of the image`);
    }
    if (rectArea(region) <= 0) {
      failures.push(`the ${region.kind} mask has no area`);
    }
  }

  const imageArea = input.imageSize.width * input.imageSize.height;
  const totalMaskAreaPercent = imageArea > 0 ? (maskedArea / imageArea) * 100 : 0;

  if (totalMaskAreaPercent > input.maxMaskAreaPercent) {
    failures.push(
      `masks cover ${totalMaskAreaPercent.toFixed(1)}% of the image, above the ${input.maxMaskAreaPercent}% limit`,
    );
  }
  if (input.regions.length === 0) {
    failures.push('no regions were detected');
  }
  if (lowestConfidence < input.minConfidence) {
    failures.push(
      `detection confidence ${lowestConfidence.toFixed(2)} is below the ${input.minConfidence} threshold`,
    );
  }
  if (!looksLikeSlab(input.slab)) {
    failures.push(
      `the detected bounding box is not slab-shaped (aspect ${(input.slab.height / input.slab.width).toFixed(2)}, expected about ${SLAB_ASPECT_RATIO})`,
    );
  }

  return {
    safe: failures.length === 0,
    failures,
    totalMaskAreaPercent,
    lowestConfidence: input.regions.length > 0 ? lowestConfidence : 0,
  };
}
