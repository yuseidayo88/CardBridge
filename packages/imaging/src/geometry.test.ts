import { describe, expect, it } from 'vitest';
import {
  cardRegion,
  checkMaskSafety,
  clampToBounds,
  consensusRegions,
  intersects,
  iou,
  labelRegion,
  looksLikeSlab,
  templateRegions,
  type DetectedRegion,
  type Rect,
} from './geometry';

/** A 400x760 slab in a 500x900 image — realistic shop-thumbnail proportions. */
const SLAB: Rect = { x: 50, y: 70, width: 400, height: 760 };
const IMAGE = { width: 500, height: 900 };

describe('slab detection sanity', () => {
  it('accepts a slab-shaped box', () => {
    expect(looksLikeSlab(SLAB)).toBe(true);
  });

  it('rejects a square, which is not a slab', () => {
    expect(looksLikeSlab({ x: 0, y: 0, width: 400, height: 400 })).toBe(false);
  });

  it('rejects a degenerate box', () => {
    expect(looksLikeSlab({ x: 0, y: 0, width: 0, height: 100 })).toBe(false);
  });
});

describe('label and card regions', () => {
  it('puts the label at the top and the card below it', () => {
    const label = labelRegion(SLAB);
    const card = cardRegion(SLAB);

    expect(label.y).toBe(SLAB.y);
    expect(card.y).toBeGreaterThan(label.y);
    expect(intersects(label, card)).toBe(false);
  });

  it('covers the whole slab between them', () => {
    const label = labelRegion(SLAB);
    const card = cardRegion(SLAB);
    expect(label.height + card.height).toBeCloseTo(SLAB.height, 5);
  });

  it('scales with the image rather than assuming pixel sizes', () => {
    const small = labelRegion({ x: 0, y: 0, width: 100, height: 190 });
    const large = labelRegion({ x: 0, y: 0, width: 1000, height: 1900 });
    expect(large.height / small.height).toBeCloseTo(10, 5);
  });

  it('places the legacy label lower, as older slabs do', () => {
    expect(labelRegion(SLAB, 'LEGACY').height).toBeGreaterThan(labelRegion(SLAB, 'CURRENT').height);
  });
});

describe('templateRegions', () => {
  it('produces a cert number and a barcode region', () => {
    const regions = templateRegions(SLAB);
    expect(regions.map((r) => r.kind).sort()).toEqual(['BARCODE', 'CERT_NUMBER']);
  });

  it('keeps both regions inside the label, never on the card', () => {
    const card = cardRegion(SLAB);
    for (const region of templateRegions(SLAB)) {
      expect(intersects(region, card)).toBe(false);
    }
  });

  it('puts the barcode left of the cert number', () => {
    const regions = templateRegions(SLAB);
    const cert = regions.find((r) => r.kind === 'CERT_NUMBER')!;
    const barcode = regions.find((r) => r.kind === 'BARCODE')!;
    expect(barcode.x).toBeLessThan(cert.x);
  });
});

describe('consensusRegions — agreement raises confidence', () => {
  const cert = (over: Partial<DetectedRegion>): DetectedRegion => ({
    x: 300,
    y: 180,
    width: 120,
    height: 40,
    kind: 'CERT_NUMBER',
    source: 'TEMPLATE',
    confidence: 0.7,
    ...over,
  });

  it('raises confidence when independent detectors agree', () => {
    const [merged] = consensusRegions([
      cert({ source: 'TEMPLATE', confidence: 0.7 }),
      cert({ source: 'OCR', confidence: 0.65, x: 305 }),
      cert({ source: 'BARCODE_SCAN', confidence: 0.6, x: 302 }),
    ]);
    expect(merged!.confidence).toBeGreaterThan(0.7);
  });

  it('does not raise confidence for a lone detector', () => {
    const [merged] = consensusRegions([cert({ source: 'OCR', confidence: 0.65 })]);
    expect(merged!.confidence).toBe(0.65);
  });

  it('does not count two readings from the same detector as agreement', () => {
    // Two OCR passes failing the same way is not corroboration.
    const [merged] = consensusRegions([
      cert({ source: 'OCR', confidence: 0.7 }),
      cert({ source: 'OCR', confidence: 0.68, x: 302 }),
    ]);
    expect(merged!.confidence).toBe(0.7);
  });

  it('does not merge detections that are nowhere near each other', () => {
    const [merged] = consensusRegions([
      cert({ source: 'TEMPLATE', confidence: 0.7 }),
      cert({ source: 'OCR', confidence: 0.6, x: 60, y: 700 }),
    ]);
    expect(merged!.confidence).toBe(0.7);
  });

  it('takes the union so a slight offset does not leave the number exposed', () => {
    const [merged] = consensusRegions([
      cert({ source: 'TEMPLATE', confidence: 0.7, x: 300, width: 100 }),
      cert({ source: 'OCR', confidence: 0.69, x: 320, width: 100 }),
    ]);
    expect(merged!.x).toBe(300);
    expect(merged!.x + merged!.width).toBe(420);
  });

  it('lets a manual region override every detector', () => {
    const [merged] = consensusRegions([
      cert({ source: 'TEMPLATE', confidence: 0.9 }),
      cert({ source: 'MANUAL', confidence: 0.5, x: 111, y: 222 }),
    ]);
    expect(merged!.source).toBe('MANUAL');
    expect(merged!.x).toBe(111);
    expect(merged!.confidence).toBe(1);
  });

  it('keeps different kinds separate', () => {
    const merged = consensusRegions([
      cert({ kind: 'CERT_NUMBER' }),
      cert({ kind: 'BARCODE', x: 60 }),
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('checkMaskSafety — the card must never be covered', () => {
  const base = {
    slab: SLAB,
    imageSize: IMAGE,
    maxMaskAreaPercent: 8,
    minConfidence: 0.9,
  };

  it('passes a correct template mask', () => {
    const result = checkMaskSafety({
      ...base,
      regions: templateRegions(SLAB, 'CURRENT', 0.95),
    });
    expect(result.failures).toEqual([]);
    expect(result.safe).toBe(true);
  });

  it('fails a mask that overlaps the card', () => {
    const card = cardRegion(SLAB);
    const result = checkMaskSafety({
      ...base,
      regions: [
        {
          x: card.x + 10,
          y: card.y + 10,
          width: 100,
          height: 100,
          kind: 'CERT_NUMBER',
          source: 'OCR',
          confidence: 0.99,
        },
      ],
    });
    expect(result.safe).toBe(false);
    expect(result.failures.join(' ')).toMatch(/overlaps the card itself/);
  });

  it('fails a mask that covers too much of the frame', () => {
    const result = checkMaskSafety({
      ...base,
      regions: [
        {
          x: 50,
          y: 70,
          width: 400,
          height: 150,
          kind: 'LABEL',
          source: 'TEMPLATE',
          confidence: 0.99,
        },
      ],
    });
    expect(result.safe).toBe(false);
    expect(result.failures.join(' ')).toMatch(/above the 8% limit/);
  });

  it('fails on low detection confidence', () => {
    const result = checkMaskSafety({
      ...base,
      regions: templateRegions(SLAB, 'CURRENT', 0.4),
    });
    expect(result.safe).toBe(false);
    expect(result.failures.join(' ')).toMatch(/below the 0.9 threshold/);
  });

  it('fails when nothing was detected', () => {
    const result = checkMaskSafety({ ...base, regions: [] });
    expect(result.safe).toBe(false);
    expect(result.failures.join(' ')).toMatch(/no regions were detected/);
    expect(result.lowestConfidence).toBe(0);
  });

  it('fails when the box is not slab-shaped', () => {
    const square = { x: 0, y: 0, width: 400, height: 400 };
    const result = checkMaskSafety({
      ...base,
      slab: square,
      regions: templateRegions(square, 'CURRENT', 0.99),
    });
    expect(result.safe).toBe(false);
    expect(result.failures.join(' ')).toMatch(/not slab-shaped/);
  });

  it('fails a mask that runs off the edge of the image', () => {
    const result = checkMaskSafety({
      ...base,
      regions: [
        {
          x: 450,
          y: 100,
          width: 200,
          height: 30,
          kind: 'CERT_NUMBER',
          source: 'TEMPLATE',
          confidence: 0.99,
        },
      ],
    });
    expect(result.safe).toBe(false);
    expect(result.failures.join(' ')).toMatch(/past the edge/);
  });

  it('reports every failure, not just the first', () => {
    const card = cardRegion(SLAB);
    const result = checkMaskSafety({
      ...base,
      regions: [{ ...card, kind: 'CERT_NUMBER', source: 'OCR', confidence: 0.2 }],
    });
    expect(result.failures.length).toBeGreaterThanOrEqual(3);
  });
});

describe('rectangle helpers', () => {
  it('computes IoU', () => {
    expect(iou({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 })).toBe(
      1,
    );
    expect(
      iou({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 10, height: 10 }),
    ).toBe(0);
  });

  it('clamps a rectangle into the image', () => {
    const clamped = clampToBounds({ x: -10, y: -5, width: 1000, height: 1000 }, IMAGE);
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(0);
    expect(clamped.width).toBeLessThanOrEqual(IMAGE.width);
    expect(clamped.height).toBeLessThanOrEqual(IMAGE.height);
  });
});
