import { relations, sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { imageFaceEnum, imageProcessingMethodEnum, imageProcessingStatusEnum } from './enums';
import { supplierProducts } from './suppliers';

/**
 * Images.
 *
 * The original is never overwritten. Original and processed live in separate
 * columns because a redaction that turns out to be wrong — a mask over the card
 * instead of the label — must be recoverable without going back to the partner
 * shop for the file.
 *
 * `originalImageHash` is the deduplication key. Two shops listing the same card
 * often serve the same photograph; hashing on first download means we fetch it
 * once, which is the difference between a considerate crawler and a nuisance.
 */
export const productImages = pgTable(
  'product_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierProductId: uuid('supplier_product_id')
      .notNull()
      .references(() => supplierProducts.id, { onDelete: 'cascade' }),

    originalImageUrl: text('original_image_url').notNull(),
    /** SHA-256 of the bytes. Exact-duplicate detection. */
    originalImageHash: text('original_image_hash').notNull(),
    /** Perceptual hash. Catches re-encoded or resized copies of one photo. */
    originalPhash: text('original_phash'),
    /** Supabase Storage path of the cached original. */
    originalStoragePath: text('original_storage_path'),

    processedImageUrl: text('processed_image_url'),
    processedStoragePath: text('processed_storage_path'),
    processingMethod: imageProcessingMethodEnum('processing_method').notNull().default('ORIGINAL'),
    processingStatus: imageProcessingStatusEnum('processing_status').notNull().default('PENDING'),
    /**
     * Detected regions, each with which detector found it and how sure it was:
     * [{x, y, w, h, kind: 'CERT_NUMBER'|'BARCODE', source, confidence}]
     */
    maskCoordinates: jsonb('mask_coordinates')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Agreement across the geometric, barcode and OCR detectors. */
    processingConfidence: numeric('processing_confidence', { precision: 5, scale: 4 }),
    processingError: text('processing_error'),

    /**
     * A human looked at the processed image and accepted it. Required before
     * any non-ORIGINAL image is allowed near a production listing.
     */
    manuallyApprovedAt: timestamp('manually_approved_at', { withTimezone: true }),
    manuallyApprovedBy: text('manually_approved_by'),

    face: imageFaceEnum('face').notNull().default('OTHER'),
    displayOrder: integer('display_order').notNull().default(0),
    width: integer('width'),
    height: integer('height'),
    bytes: integer('bytes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('product_images_product_url_uq').on(t.supplierProductId, t.originalImageUrl),
    index('product_images_hash_idx').on(t.originalImageHash),
    index('product_images_status_idx').on(t.processingStatus),
  ],
);

/**
 * A durable cache keyed by content hash, independent of any product.
 *
 * Without this, deleting a supplier_product would lose the knowledge that we
 * already downloaded and analysed that exact file.
 */
export const imageAssets = pgTable(
  'image_assets',
  {
    hash: text('hash').primaryKey(),
    storagePath: text('storage_path').notNull(),
    contentType: text('content_type').notNull(),
    bytes: integer('bytes').notNull(),
    width: integer('width'),
    height: integer('height'),
    /** Cached detector output, so a re-run does not redo the vision work. */
    analysis: jsonb('analysis'),
    firstDownloadedAt: timestamp('first_downloaded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    referenceCount: integer('reference_count').notNull().default(1),
  },
  (t) => [index('image_assets_last_used_idx').on(t.lastUsedAt)],
);

export const imageProcessingJobs = pgTable(
  'image_processing_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    imageId: uuid('image_id')
      .notNull()
      .references(() => productImages.id, { onDelete: 'cascade' }),
    method: imageProcessingMethodEnum('method').notNull(),
    status: imageProcessingStatusEnum('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    /** Raw output of each detector, retained so a bad mask can be diagnosed. */
    detectorResults: jsonb('detector_results'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('image_processing_jobs_status_idx').on(t.status)],
);

export const productImagesRelations = relations(productImages, ({ one, many }) => ({
  supplierProduct: one(supplierProducts, {
    fields: [productImages.supplierProductId],
    references: [supplierProducts.id],
  }),
  jobs: many(imageProcessingJobs),
}));
