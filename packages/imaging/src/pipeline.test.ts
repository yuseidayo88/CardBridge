import { describe, expect, it, beforeEach, vi } from 'vitest';
import { __setSharpForTesting, hashImage, processImage } from './pipeline';
import { cardRegion, templateRegions, type DetectedRegion, type Rect } from './geometry';

const SLAB: Rect = { x: 50, y: 70, width: 400, height: 760 };
const BYTES = Buffer.from('fake-image-bytes');

/** Minimal sharp stand-in: records what it was asked to do. */
function fakeSharp(width = 500, height = 900) {
  const composited: unknown[][] = [];
  const extracted: unknown[] = [];

  const factory = vi.fn((_input: Buffer) => ({
    metadata: async () => ({ width, height }),
    composite: (overlays: unknown[]) => {
      composited.push(overlays);
      return { toBuffer: async () => Buffer.from('processed') };
    },
    extract: (region: unknown) => {
      extracted.push(region);
      return {
        blur: () => ({ toBuffer: async () => Buffer.from('blurred') }),
        toBuffer: async () => Buffer.from('cropped'),
      };
    },
  }));

  return { factory, composited, extracted };
}

const request = (over: Partial<Parameters<typeof processImage>[0]> = {}) => ({
  imageBytes: BYTES,
  method: 'BLACK_MASK' as const,
  slab: SLAB,
  detections: templateRegions(SLAB, 'CURRENT', 0.95) as readonly DetectedRegion[],
  maxMaskAreaPercent: 8,
  minConfidence: 0.9,
  ...over,
});

beforeEach(() => {
  __setSharpForTesting(undefined);
});

describe('hashImage', () => {
  it('is stable and content-addressed', () => {
    expect(hashImage(BYTES)).toBe(hashImage(Buffer.from('fake-image-bytes')));
    expect(hashImage(BYTES)).not.toBe(hashImage(Buffer.from('other')));
    expect(hashImage(BYTES)).toHaveLength(64);
  });
});

describe('processImage — methods that do not alter pixels', () => {
  it('passes ORIGINAL straight through', async () => {
    const result = await processImage(request({ method: 'ORIGINAL' }));
    expect(result.status).toBe('READY');
    expect(result.processedBytes).toBeNull();
    expect(result.reasons).toEqual([]);
  });

  it('treats SOURCE_REDACTED as ready — the shop already did the work', async () => {
    const result = await processImage(request({ method: 'SOURCE_REDACTED' }));
    expect(result.status).toBe('READY');
    expect(result.processedBytes).toBeNull();
  });

  it('routes MANUAL_REVIEW to a human without touching the image', async () => {
    const result = await processImage(request({ method: 'MANUAL_REVIEW' }));
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.processedBytes).toBeNull();
  });

  it('does not need sharp for those paths', async () => {
    __setSharpForTesting(null);
    expect((await processImage(request({ method: 'ORIGINAL' }))).status).toBe('READY');
  });
});

describe('processImage — redaction never happens on an unsafe mask', () => {
  it('refuses when the mask would cover the card', async () => {
    const { factory, composited } = fakeSharp();
    __setSharpForTesting(factory as never);

    const card = cardRegion(SLAB);
    const result = await processImage(
      request({
        detections: [{ ...card, kind: 'CERT_NUMBER', source: 'OCR', confidence: 0.99 }],
      }),
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.processedBytes).toBeNull();
    expect(result.reasons.join(' ')).toMatch(/overlaps the card/);
    // The decisive part: no pixels were altered.
    expect(composited).toHaveLength(0);
  });

  it('refuses on low detection confidence', async () => {
    const { factory, composited } = fakeSharp();
    __setSharpForTesting(factory as never);

    const result = await processImage(
      request({ detections: templateRegions(SLAB, 'CURRENT', 0.3) }),
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reasons.join(' ')).toMatch(/below the 0.9 threshold/);
    expect(composited).toHaveLength(0);
  });

  it('refuses when nothing was detected', async () => {
    const { factory } = fakeSharp();
    __setSharpForTesting(factory as never);

    const result = await processImage(request({ detections: [] }));
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reasons.join(' ')).toMatch(/no regions were detected/);
  });

  it('refuses when the mask would cover too much of the frame', async () => {
    const { factory } = fakeSharp();
    __setSharpForTesting(factory as never);

    const result = await processImage(
      request({
        detections: [
          {
            x: 50,
            y: 70,
            width: 400,
            height: 200,
            kind: 'LABEL',
            source: 'TEMPLATE',
            confidence: 0.99,
          },
        ],
      }),
    );
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reasons.join(' ')).toMatch(/above the 8% limit/);
  });
});

describe('processImage — successful redaction still needs approval', () => {
  it('produces bytes but does not mark them ready', async () => {
    const { factory, composited } = fakeSharp();
    __setSharpForTesting(factory as never);

    const result = await processImage(request());

    expect(result.processedBytes).not.toBeNull();
    expect(composited).toHaveLength(1);
    // A redacted image is never publishable on the strength of the algorithm
    // alone; the database enforces the same rule.
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reasons.join(' ')).toMatch(/admin approval/);
  });

  it('composites one black overlay per detected region', async () => {
    const { factory, composited } = fakeSharp();
    __setSharpForTesting(factory as never);

    await processImage(request());
    expect(composited[0]).toHaveLength(2); // cert number + barcode
  });

  it('blurs each region separately rather than the whole image', async () => {
    const { factory, extracted } = fakeSharp();
    __setSharpForTesting(factory as never);

    await processImage(request({ method: 'BLUR' }));
    expect(extracted).toHaveLength(2);
  });

  it('crops below the label for CROP', async () => {
    const { factory, extracted } = fakeSharp();
    __setSharpForTesting(factory as never);

    await processImage(request({ method: 'CROP' }));
    const region = extracted[0] as { top: number; left: number };
    expect(region.left).toBe(0);
    expect(region.top).toBeGreaterThan(SLAB.y);
  });
});

describe('processImage — degrades honestly', () => {
  it('reports failure rather than crashing when sharp is unavailable', async () => {
    __setSharpForTesting(null);

    const result = await processImage(request());
    expect(result.status).toBe('FAILED');
    expect(result.processedBytes).toBeNull();
    expect(result.reasons.join(' ')).toMatch(/sharp is not available/);
  });

  it('fails when the image dimensions cannot be read', async () => {
    const { factory } = fakeSharp(0, 0);
    __setSharpForTesting(factory as never);

    const result = await processImage(request());
    expect(result.status).toBe('FAILED');
    expect(result.reasons.join(' ')).toMatch(/dimensions could not be read/);
  });

  it('clamps regions that run past the image edge', async () => {
    const { factory } = fakeSharp(500, 900);
    __setSharpForTesting(factory as never);

    const result = await processImage(
      request({
        detections: [
          {
            x: 480,
            y: 100,
            width: 200,
            height: 30,
            kind: 'CERT_NUMBER',
            source: 'TEMPLATE',
            confidence: 0.99,
          },
        ],
      }),
    );

    for (const region of result.regions) {
      expect(region.x + region.width).toBeLessThanOrEqual(500);
    }
  });
});
