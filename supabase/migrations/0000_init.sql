CREATE TYPE "public"."attribute_source" AS ENUM('structured_data', 'supplier_rule', 'title_parser', 'catalog_lookup', 'manual', 'ai_extraction', 'ai_inference', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."card_language" AS ENUM('JAPANESE', 'ENGLISH', 'CHINESE', 'KOREAN', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."customs_mode" AS ENUM('BUYER_PAID', 'SELLER_PAID', 'MARKETPLACE_COLLECTED', 'CARRIER_QUOTE_REQUIRED', 'MANUAL_REVIEW');--> statement-breakpoint
CREATE TYPE "public"."ebay_environment" AS ENUM('SANDBOX', 'PRODUCTION');--> statement-breakpoint
CREATE TYPE "public"."grading_company" AS ENUM('PSA', 'BGS', 'CGC', 'SGC', 'ARS', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."image_face" AS ENUM('FRONT', 'BACK', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."image_processing_method" AS ENUM('ORIGINAL', 'SOURCE_REDACTED', 'BLACK_MASK', 'BLUR', 'CROP', 'MANUAL_REVIEW');--> statement-breakpoint
CREATE TYPE "public"."image_processing_status" AS ENUM('PENDING', 'PROCESSING', 'READY', 'NEEDS_REVIEW', 'APPROVED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'PUBLISHED', 'OUT_OF_STOCK', 'ENDED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."log_level" AS ENUM('DEBUG', 'INFO', 'WARN', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."match_method" AS ENUM('AUTO', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."profit_scenario" AS ENUM('OPTIMISTIC', 'BASE', 'PESSIMISTIC');--> statement-breakpoint
CREATE TYPE "public"."psa_verdict" AS ENUM('CONFIRMED', 'REVIEW', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."stock_status" AS ENUM('IN_STOCK', 'OUT_OF_STOCK', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."sync_job_status" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."sync_job_type" AS ENUM('SUPPLIER_FULL_SYNC', 'SUPPLIER_STOCK_CHECK', 'SUPPLIER_PRICE_CHECK', 'IMAGE_PROCESSING', 'AI_GENERATION', 'MARKET_PRICE_REFRESH', 'EBAY_LISTING_SYNC', 'EBAY_METADATA_REFRESH');--> statement-breakpoint
CREATE TABLE "price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_product_id" uuid NOT NULL,
	"price_incl_tax_jpy" numeric(20, 6) NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_product_id" uuid NOT NULL,
	"stock_qty" integer,
	"stock_status" "stock_status" NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_product_attributes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_product_id" uuid NOT NULL,
	"field" text NOT NULL,
	"value" text,
	"source" "attribute_source" NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_product_attributes_uq" UNIQUE("supplier_product_id","field")
);
--> statement-breakpoint
CREATE TABLE "supplier_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"source_product_id" text NOT NULL,
	"canonical_url" text NOT NULL,
	"raw_title" text NOT NULL,
	"price_incl_tax_jpy" numeric(20, 6) NOT NULL,
	"stock_qty" integer,
	"stock_status" "stock_status" NOT NULL,
	"psa_verdict" "psa_verdict" DEFAULT 'REVIEW' NOT NULL,
	"psa_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parse_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parse_confidence" numeric(5, 4) DEFAULT '0' NOT NULL,
	"content_hash" text NOT NULL,
	"etag" text,
	"last_modified" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disappeared_at" timestamp with time zone,
	CONSTRAINT "supplier_products_supplier_source_uq" UNIQUE("supplier_id","source_product_id")
);
--> statement-breakpoint
CREATE TABLE "supplier_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"selectors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stock_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"category_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetch_interval_minutes" integer DEFAULT 360 NOT NULL,
	"max_pages_per_run" integer DEFAULT 20 NOT NULL,
	"max_concurrency" integer DEFAULT 1 NOT NULL,
	"min_request_interval_ms" integer DEFAULT 3000 NOT NULL,
	"safety_stock" integer DEFAULT 0 NOT NULL,
	"domestic_shipping_fee_jpy" numeric(20, 6) DEFAULT '0' NOT NULL,
	"handling_fee_jpy" numeric(20, 6) DEFAULT '0' NOT NULL,
	"lead_time_days" integer DEFAULT 3 NOT NULL,
	"reliability_score" numeric(5, 4) DEFAULT '1' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"adapter_healthy" boolean DEFAULT true NOT NULL,
	"adapter_health_checked_at" timestamp with time zone,
	"adapter_health_detail" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_settings_supplier_id_unique" UNIQUE("supplier_id")
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"trust_score" numeric(5, 2) DEFAULT '50' NOT NULL,
	"permission_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "catalog_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_name_ja" text NOT NULL,
	"card_name_en" text,
	"card_number" text,
	"set_code" text,
	"set_name" text,
	"rarity" text,
	"release_year" numeric(4, 0),
	"language" "card_language" NOT NULL,
	"grading_company" "grading_company" NOT NULL,
	"grade" numeric(3, 1) NOT NULL,
	"match_key" text NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_product_id" uuid NOT NULL,
	"catalog_product_id" uuid NOT NULL,
	"score" numeric(5, 4) NOT NULL,
	"signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_candidates_uq" UNIQUE("supplier_product_id","catalog_product_id")
);
--> statement-breakpoint
CREATE TABLE "product_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_product_id" uuid NOT NULL,
	"supplier_product_id" uuid NOT NULL,
	"match_score" numeric(5, 4) NOT NULL,
	"match_method" "match_method" NOT NULL,
	"match_signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"matched_by" text,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unmatched_at" timestamp with time zone,
	"unmatched_by" text,
	"unmatch_reason" text
);
--> statement-breakpoint
CREATE TABLE "image_assets" (
	"hash" text PRIMARY KEY NOT NULL,
	"storage_path" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"analysis" jsonb,
	"first_downloaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reference_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_processing_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"image_id" uuid NOT NULL,
	"method" "image_processing_method" NOT NULL,
	"status" "image_processing_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"detector_results" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_product_id" uuid NOT NULL,
	"original_image_url" text NOT NULL,
	"original_image_hash" text NOT NULL,
	"original_phash" text,
	"original_storage_path" text,
	"processed_image_url" text,
	"processed_storage_path" text,
	"processing_method" "image_processing_method" DEFAULT 'ORIGINAL' NOT NULL,
	"processing_status" "image_processing_status" DEFAULT 'PENDING' NOT NULL,
	"mask_coordinates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"processing_confidence" numeric(5, 4),
	"processing_error" text,
	"manually_approved_at" timestamp with time zone,
	"manually_approved_by" text,
	"face" "image_face" DEFAULT 'OTHER' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"width" integer,
	"height" integer,
	"bytes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_images_product_url_uq" UNIQUE("supplier_product_id","original_image_url")
);
--> statement-breakpoint
CREATE TABLE "ebay_aspect_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"marketplace_code" text NOT NULL,
	"category_id" text NOT NULL,
	"environment" "ebay_environment" NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ebay_aspect_policies_uq" UNIQUE("marketplace_code","category_id","environment")
);
--> statement-breakpoint
CREATE TABLE "ebay_condition_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"marketplace_code" text NOT NULL,
	"category_id" text NOT NULL,
	"environment" "ebay_environment" NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ebay_condition_policies_uq" UNIQUE("marketplace_code","category_id","environment")
);
--> statement-breakpoint
CREATE TABLE "ebay_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account" text NOT NULL,
	"environment" "ebay_environment" NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"access_token_enc" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ebay_credentials_uq" UNIQUE("account","environment")
);
--> statement-breakpoint
CREATE TABLE "market_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_product_id" uuid NOT NULL,
	"marketplace_id" uuid NOT NULL,
	"source" text NOT NULL,
	"currency" text NOT NULL,
	"sold_median" numeric(20, 6),
	"sold_min" numeric(20, 6),
	"sold_max" numeric(20, 6),
	"sold_count" integer,
	"sold_median_with_shipping" numeric(20, 6),
	"active_min" numeric(20, 6),
	"active_median" numeric(20, 6),
	"active_count" integer,
	"sample_window_days" integer,
	"outliers_excluded" integer,
	"is_sufficient" boolean DEFAULT false NOT NULL,
	"notes" text,
	"entered_by" text,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_product_id" uuid NOT NULL,
	"marketplace_id" uuid NOT NULL,
	"environment" "ebay_environment" DEFAULT 'SANDBOX' NOT NULL,
	"sku" text NOT NULL,
	"ebay_offer_id" text,
	"ebay_listing_id" text,
	"status" "listing_status" DEFAULT 'DRAFT' NOT NULL,
	"price_value" numeric(20, 6),
	"price_currency" text,
	"quantity" integer DEFAULT 0 NOT NULL,
	"title_en" text,
	"description_en" text,
	"item_specifics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ebay_payload" jsonb,
	"approved_payload_hash" text,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"published_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"eligibility_blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_listings_sku_uq" UNIQUE("marketplace_id","environment","sku"),
	CONSTRAINT "marketplace_listings_product_uq" UNIQUE("catalog_product_id","marketplace_id","environment")
);
--> statement-breakpoint
CREATE TABLE "marketplaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"country_code" text NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplaces_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "cost_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"marketplace_id" uuid,
	"category_fee_percent" numeric(8, 5) NOT NULL,
	"fixed_fee_per_order" numeric(20, 6) NOT NULL,
	"international_fee_percent" numeric(8, 5) DEFAULT '0' NOT NULL,
	"ad_rate_percent" numeric(8, 5) DEFAULT '0' NOT NULL,
	"fx_spread_percent" numeric(8, 5) DEFAULT '0' NOT NULL,
	"fx_buffer_percent" numeric(8, 5) DEFAULT '0' NOT NULL,
	"return_reserve_percent" numeric(8, 5) DEFAULT '0' NOT NULL,
	"packaging_cost" numeric(20, 6) DEFAULT '0' NOT NULL,
	"packaging_currency" text DEFAULT 'JPY' NOT NULL,
	"other_cost" numeric(20, 6) DEFAULT '0' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customs_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" text NOT NULL,
	"mode" "customs_mode" NOT NULL,
	"item_value_from" numeric(20, 6) DEFAULT '0' NOT NULL,
	"item_value_to" numeric(20, 6),
	"duty_rate_percent" numeric(8, 5),
	"import_tax_rate_percent" numeric(8, 5),
	"de_minimis_threshold" numeric(20, 6),
	"customs_brokerage_fee" numeric(20, 6) DEFAULT '0' NOT NULL,
	"fee_currency" text DEFAULT 'JPY' NOT NULL,
	"hs_code" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"source_note" text,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "profit_calculations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_product_id" uuid NOT NULL,
	"marketplace_id" uuid NOT NULL,
	"supplier_id" uuid,
	"scenario" "profit_scenario" NOT NULL,
	"purchase_price_jpy" numeric(20, 6) NOT NULL,
	"domestic_shipping_jpy" numeric(20, 6) NOT NULL,
	"supplier_handling_jpy" numeric(20, 6) NOT NULL,
	"selling_price" numeric(20, 6) NOT NULL,
	"selling_currency" text NOT NULL,
	"shipping_charged_to_buyer" numeric(20, 6) DEFAULT '0' NOT NULL,
	"fx_rate" numeric(20, 10) NOT NULL,
	"international_shipping_cost" numeric(20, 6) NOT NULL,
	"packaging_cost" numeric(20, 6) NOT NULL,
	"category_fee" numeric(20, 6) NOT NULL,
	"fixed_fee" numeric(20, 6) NOT NULL,
	"international_fee" numeric(20, 6) NOT NULL,
	"ad_fee" numeric(20, 6) NOT NULL,
	"fx_cost" numeric(20, 6) NOT NULL,
	"fx_buffer" numeric(20, 6) NOT NULL,
	"return_reserve" numeric(20, 6) NOT NULL,
	"insurance_cost" numeric(20, 6) NOT NULL,
	"signature_cost" numeric(20, 6) NOT NULL,
	"duty_cost" numeric(20, 6) NOT NULL,
	"import_tax_cost" numeric(20, 6) NOT NULL,
	"customs_brokerage_fee" numeric(20, 6) NOT NULL,
	"carrier_surcharge" numeric(20, 6) NOT NULL,
	"other_cost" numeric(20, 6) NOT NULL,
	"total_cost" numeric(20, 6) NOT NULL,
	"total_revenue" numeric(20, 6) NOT NULL,
	"profit" numeric(20, 6) NOT NULL,
	"profit_jpy" numeric(20, 6) NOT NULL,
	"margin_percent" numeric(8, 5) NOT NULL,
	"customs_mode" "customs_mode" NOT NULL,
	"settings_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" text NOT NULL,
	"carrier" text NOT NULL,
	"service" text NOT NULL,
	"weight_from_grams" integer DEFAULT 0 NOT NULL,
	"weight_to_grams" integer NOT NULL,
	"item_value_from" numeric(20, 6),
	"item_value_to" numeric(20, 6),
	"cost" numeric(20, 6) NOT NULL,
	"cost_currency" text DEFAULT 'JPY' NOT NULL,
	"buyer_charged" numeric(20, 6) DEFAULT '0' NOT NULL,
	"buyer_charged_currency" text DEFAULT 'USD' NOT NULL,
	"signature_option_cost" numeric(20, 6) DEFAULT '0' NOT NULL,
	"insurance_cost" numeric(20, 6) DEFAULT '0' NOT NULL,
	"carrier_surcharge" numeric(20, 6) DEFAULT '0' NOT NULL,
	"estimated_days" integer,
	"is_tracked" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"is_active" text DEFAULT 'true' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_email_uq" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "ai_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"schema_valid" jsonb,
	"confidence" numeric(5, 4),
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hallucination_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip_prefix" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "sync_job_type" NOT NULL,
	"supplier_id" uuid,
	"status" "sync_job_status" DEFAULT 'QUEUED' NOT NULL,
	"lock_key" text NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"level" "log_level" DEFAULT 'INFO' NOT NULL,
	"message" text NOT NULL,
	"context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_supplier_product_id_supplier_products_id_fk" FOREIGN KEY ("supplier_product_id") REFERENCES "public"."supplier_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_history" ADD CONSTRAINT "stock_history_supplier_product_id_supplier_products_id_fk" FOREIGN KEY ("supplier_product_id") REFERENCES "public"."supplier_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_product_attributes" ADD CONSTRAINT "supplier_product_attributes_supplier_product_id_supplier_products_id_fk" FOREIGN KEY ("supplier_product_id") REFERENCES "public"."supplier_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_settings" ADD CONSTRAINT "supplier_settings_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_candidates" ADD CONSTRAINT "match_candidates_supplier_product_id_supplier_products_id_fk" FOREIGN KEY ("supplier_product_id") REFERENCES "public"."supplier_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_candidates" ADD CONSTRAINT "match_candidates_catalog_product_id_catalog_products_id_fk" FOREIGN KEY ("catalog_product_id") REFERENCES "public"."catalog_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_matches" ADD CONSTRAINT "product_matches_catalog_product_id_catalog_products_id_fk" FOREIGN KEY ("catalog_product_id") REFERENCES "public"."catalog_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_matches" ADD CONSTRAINT "product_matches_supplier_product_id_supplier_products_id_fk" FOREIGN KEY ("supplier_product_id") REFERENCES "public"."supplier_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_processing_jobs" ADD CONSTRAINT "image_processing_jobs_image_id_product_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."product_images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_supplier_product_id_supplier_products_id_fk" FOREIGN KEY ("supplier_product_id") REFERENCES "public"."supplier_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_prices" ADD CONSTRAINT "market_prices_catalog_product_id_catalog_products_id_fk" FOREIGN KEY ("catalog_product_id") REFERENCES "public"."catalog_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_prices" ADD CONSTRAINT "market_prices_marketplace_id_marketplaces_id_fk" FOREIGN KEY ("marketplace_id") REFERENCES "public"."marketplaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_catalog_product_id_catalog_products_id_fk" FOREIGN KEY ("catalog_product_id") REFERENCES "public"."catalog_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_marketplace_id_marketplaces_id_fk" FOREIGN KEY ("marketplace_id") REFERENCES "public"."marketplaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_profiles" ADD CONSTRAINT "cost_profiles_marketplace_id_marketplaces_id_fk" FOREIGN KEY ("marketplace_id") REFERENCES "public"."marketplaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profit_calculations" ADD CONSTRAINT "profit_calculations_catalog_product_id_catalog_products_id_fk" FOREIGN KEY ("catalog_product_id") REFERENCES "public"."catalog_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profit_calculations" ADD CONSTRAINT "profit_calculations_marketplace_id_marketplaces_id_fk" FOREIGN KEY ("marketplace_id") REFERENCES "public"."marketplaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profit_calculations" ADD CONSTRAINT "profit_calculations_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_logs" ADD CONSTRAINT "sync_logs_job_id_sync_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."sync_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "price_history_product_time_idx" ON "price_history" USING btree ("supplier_product_id","observed_at");--> statement-breakpoint
CREATE INDEX "stock_history_product_time_idx" ON "stock_history" USING btree ("supplier_product_id","observed_at");--> statement-breakpoint
CREATE INDEX "supplier_product_attributes_field_idx" ON "supplier_product_attributes" USING btree ("field");--> statement-breakpoint
CREATE INDEX "supplier_products_supplier_idx" ON "supplier_products" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_products_stock_idx" ON "supplier_products" USING btree ("stock_status");--> statement-breakpoint
CREATE INDEX "supplier_products_verdict_idx" ON "supplier_products" USING btree ("psa_verdict");--> statement-breakpoint
CREATE INDEX "supplier_products_last_checked_idx" ON "supplier_products" USING btree ("last_checked_at");--> statement-breakpoint
CREATE INDEX "catalog_products_match_key_idx" ON "catalog_products" USING btree ("match_key");--> statement-breakpoint
CREATE INDEX "catalog_products_blocking_idx" ON "catalog_products" USING btree ("card_number","language","grading_company","grade");--> statement-breakpoint
CREATE INDEX "match_candidates_unresolved_idx" ON "match_candidates" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "product_matches_catalog_idx" ON "product_matches" USING btree ("catalog_product_id");--> statement-breakpoint
CREATE INDEX "product_matches_supplier_product_idx" ON "product_matches" USING btree ("supplier_product_id");--> statement-breakpoint
CREATE INDEX "image_assets_last_used_idx" ON "image_assets" USING btree ("last_used_at");--> statement-breakpoint
CREATE INDEX "image_processing_jobs_status_idx" ON "image_processing_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "product_images_hash_idx" ON "product_images" USING btree ("original_image_hash");--> statement-breakpoint
CREATE INDEX "product_images_status_idx" ON "product_images" USING btree ("processing_status");--> statement-breakpoint
CREATE INDEX "market_prices_product_idx" ON "market_prices" USING btree ("catalog_product_id","collected_at");--> statement-breakpoint
CREATE INDEX "market_prices_sufficient_idx" ON "market_prices" USING btree ("is_sufficient");--> statement-breakpoint
CREATE INDEX "marketplace_listings_status_idx" ON "marketplace_listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cost_profiles_active_idx" ON "cost_profiles" USING btree ("is_active","effective_from");--> statement-breakpoint
CREATE INDEX "customs_rules_lookup_idx" ON "customs_rules" USING btree ("country_code","is_active");--> statement-breakpoint
CREATE INDEX "profit_calculations_product_idx" ON "profit_calculations" USING btree ("catalog_product_id","calculated_at");--> statement-breakpoint
CREATE INDEX "profit_calculations_scenario_idx" ON "profit_calculations" USING btree ("scenario");--> statement-breakpoint
CREATE INDEX "shipping_rules_lookup_idx" ON "shipping_rules" USING btree ("country_code","is_active","priority");--> statement-breakpoint
CREATE INDEX "ai_generations_target_idx" ON "ai_generations" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "ai_generations_prompt_hash_idx" ON "ai_generations" USING btree ("prompt_hash");--> statement-breakpoint
CREATE INDEX "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor","created_at");--> statement-breakpoint
CREATE INDEX "sync_jobs_claim_idx" ON "sync_jobs" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "sync_jobs_supplier_idx" ON "sync_jobs" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "sync_logs_job_idx" ON "sync_logs" USING btree ("job_id","created_at");