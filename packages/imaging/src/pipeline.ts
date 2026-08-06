import { createHash } from 'node:crypto';
import {
  checkMaskSafety,
  clampToBounds,
  consensusRegions,
  type DetectedRegion,
  type LabelGeneration,
  type Rect,
  type Size,
} from './geometry';

/**
 * Image processing pipeline.
 *
 * sharp is imported lazily. The geometry and decision logic above is pure and
 * runs anywhere; only the final pixel operation needs a native binary, and
 * keeping that at the edge means the part that decides *whether* to mask can be
 * tested exhaustively without one.
 *
 * The default is to change nothing. eBay's picture policy forbids overlays that
 * obscure the item and expects graded-card photos to show the grading company's
 * mark, and redacting the certification number sits in the untested gap between
 * those two rules — so ORIGINAL is what production uses until that question is
 * answered in writing. See docs/design/00-proposal.md section 4.
 */

export type ProcessingMethod =
  'ORIGINAL' | 'SOURCE_REDACTED' | 'BLACK_MASK' | 'BLUR' | 'CROP' | 'MANUAL_REVIEW';

export type ProcessingStatus = 'READY' | 'NEEDS_REVIEW' | 'FAILED';

export interface ProcessingRequest {
  imageBytes: Buffer;
  method: ProcessingMethod;
  /** Slab bounding box in image coordinates. */
  slab: Rect;
  generation?: LabelGeneration;
  /** Everything the detectors found. Combined here, not before. */
  detections: readonly DetectedRegion[];
  maxMaskAreaPercent: number;
  minConfidence: number;
}

export interface ProcessingResult {
  status: ProcessingStatus;
  method: ProcessingMethod;
  /** Null when nothing was produced — the original is then used unchanged. */
  processedBytes: Buffer | null;
  regions: DetectedRegion[];
  confidence: number;
  maskAreaPercent: number;
  /** Why this needs a human, if it does. */
  reasons: string[];
}

export function hashImage(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function processImage(request: ProcessingRequest): Promise<ProcessingResult> {
  const { method } = request;

  // Neither of these touches the pixels: ORIGINAL uses the file as supplied,
  // SOURCE_REDACTED means the partner shop already redacted it for us.
  if (method === 'ORIGINAL' || method === 'SOURCE_REDACTED') {
    return {
      status: 'READY',
      method,
      processedBytes: null,
      regions: [],
      confidence: 1,
      maskAreaPercent: 0,
      reasons: [],
    };
  }

  if (method === 'MANUAL_REVIEW') {
    return {
      status: 'NEEDS_REVIEW',
      method,
      processedBytes: null,
      regions: [],
      confidence: 0,
      maskAreaPercent: 0,
      reasons: ['this image was routed to manual review by configuration'],
    };
  }

  const sharpModule = await loadSharp();
  if (!sharpModule) {
    return {
      status: 'FAILED',
      method,
      processedBytes: null,
      regions: [],
      confidence: 0,
      maskAreaPercent: 0,
      reasons: ['sharp is not available in this environment, so no image was altered'],
    };
  }

  const metadata = await sharpModule(request.imageBytes).metadata();
  const imageSize: Size = { width: metadata.width ?? 0, height: metadata.height ?? 0 };
  if (imageSize.width === 0 || imageSize.height === 0) {
    return {
      status: 'FAILED',
      method,
      processedBytes: null,
      regions: [],
      confidence: 0,
      maskAreaPercent: 0,
      reasons: ['the image dimensions could not be read'],
    };
  }

  const regions = consensusRegions(request.detections).map((r) => ({
    ...r,
    ...clampToBounds(r, imageSize),
  }));

  const safety = checkMaskSafety({
    regions,
    slab: request.slab,
    imageSize,
    generation: request.generation,
    maxMaskAreaPercent: request.maxMaskAreaPercent,
    minConfidence: request.minConfidence,
  });

  // The pixels are only touched once the safety check has passed. A failed
  // check produces a review item, never a best-effort mask.
  if (!safety.safe) {
    return {
      status: 'NEEDS_REVIEW',
      method,
      processedBytes: null,
      regions,
      confidence: safety.lowestConfidence,
      maskAreaPercent: safety.totalMaskAreaPercent,
      reasons: safety.failures,
    };
  }

  const processedBytes = await applyMethod(sharpModule, request, regions, imageSize);

  return {
    // Even a technically successful redaction is not publishable on its own:
    // an admin approves each one. The database enforces this too.
    status: 'NEEDS_REVIEW',
    method,
    processedBytes,
    regions,
    confidence: safety.lowestConfidence,
    maskAreaPercent: safety.totalMaskAreaPercent,
    reasons: ['redacted images require explicit admin approval before listing'],
  };
}

async function applyMethod(
  sharpModule: SharpFactory,
  request: ProcessingRequest,
  regions: readonly DetectedRegion[],
  imageSize: Size,
): Promise<Buffer> {
  const image = sharpModule(request.imageBytes);

  switch (request.method) {
    case 'BLACK_MASK': {
      const overlays = regions.map((region) => ({
        input: {
          create: {
            width: Math.max(1, Math.round(region.width)),
            height: Math.max(1, Math.round(region.height)),
            channels: 4 as const,
            background: { r: 0, g: 0, b: 0, alpha: 1 },
          },
        },
        left: Math.round(region.x),
        top: Math.round(region.y),
      }));
      return image.composite(overlays).toBuffer();
    }

    case 'BLUR': {
      // Blur each region separately and composite it back, rather than
      // blurring the whole image and masking through it — the latter leaks
      // detail at region edges.
      const patches = await Promise.all(
        regions.map(async (region) => ({
          input: await sharpModule(request.imageBytes)
            .extract({
              left: Math.round(region.x),
              top: Math.round(region.y),
              width: Math.max(1, Math.round(region.width)),
              height: Math.max(1, Math.round(region.height)),
            })
            // Proportional to region size: a fixed radius under-blurs a large
            // barcode and destroys a small one.
            .blur(Math.max(8, Math.round(Math.min(region.width, region.height) / 3)))
            .toBuffer(),
          left: Math.round(region.x),
          top: Math.round(region.y),
        })),
      );
      return image.composite(patches).toBuffer();
    }

    case 'CROP': {
      // Crop away the label band, keeping the card. Note this removes the
      // grading company's mark, which eBay expects to be visible on a graded
      // card — the eligibility engine treats CROP accordingly.
      const lowestRegionBottom = regions.reduce(
        (max, r) => Math.max(max, r.y + r.height),
        request.slab.y,
      );
      const top = Math.round(lowestRegionBottom);
      return image
        .extract({
          left: 0,
          top,
          width: imageSize.width,
          height: Math.max(1, imageSize.height - top),
        })
        .toBuffer();
    }

    default:
      throw new Error(`applyMethod does not handle ${request.method}`);
  }
}

// --- sharp loading ---------------------------------------------------------

type SharpFactory = (input: Buffer) => {
  metadata(): Promise<{ width?: number; height?: number }>;
  composite(overlays: unknown[]): { toBuffer(): Promise<Buffer> };
  extract(region: { left: number; top: number; width: number; height: number }): {
    blur(sigma: number): { toBuffer(): Promise<Buffer> };
    toBuffer(): Promise<Buffer>;
  };
};

let sharpCache: SharpFactory | null | undefined;

/**
 * Load sharp on first use.
 *
 * It is a native module, and a worker that cannot load it should report that
 * clearly rather than crashing on import — the rest of the sync pipeline still
 * works without image redaction.
 */
async function loadSharp(): Promise<SharpFactory | null> {
  if (sharpCache !== undefined) return sharpCache;
  try {
    const mod = (await import('sharp')) as unknown as { default: SharpFactory };
    sharpCache = mod.default;
  } catch {
    sharpCache = null;
  }
  return sharpCache;
}

/** Test seam: force the loader's answer. */
export function __setSharpForTesting(factory: SharpFactory | null | undefined): void {
  sharpCache = factory;
}
