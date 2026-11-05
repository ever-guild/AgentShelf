CREATE TYPE "public"."booking_status" AS ENUM('held', 'confirmed', 'expired', 'cancelled', 'review_required');--> statement-breakpoint
CREATE TYPE "public"."import_job_status" AS ENUM('queued', 'running', 'needs_review', 'failed', 'completed');--> statement-breakpoint
CREATE TYPE "public"."import_source_kind" AS ENUM('photo', 'csv');--> statement-breakpoint
CREATE TYPE "public"."order_kind" AS ENUM('purchase', 'booking_deposit');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'approved', 'paid', 'cancelled', 'failed', 'review_required');--> statement-breakpoint
CREATE TYPE "public"."product_availability" AS ENUM('available', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."product_kind" AS ENUM('product', 'service');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('draft', 'published', 'unpublished');--> statement-breakpoint
CREATE TYPE "public"."search_event_origin" AS ENUM('observed', 'fixture');--> statement-breakpoint
CREATE TYPE "public"."webhook_receipt_status" AS ENUM('received', 'processed', 'ignored', 'failed');--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" "booking_status" DEFAULT 'held' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"hold_expires_at" timestamp with time zone NOT NULL,
	"deposit_capture_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "bookings_ends_after_start" CHECK ("bookings"."ends_at" > "bookings"."starts_at"),
	CONSTRAINT "bookings_confirmed_requires_capture" CHECK ("bookings"."status" <> 'confirmed' OR "bookings"."deposit_capture_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"source_kind" "import_source_kind" NOT NULL,
	"status" "import_job_status" DEFAULT 'queued' NOT NULL,
	"source_ref" text,
	"workflow_run_id" text,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_jobs_workflow_run_id_unique" UNIQUE("workflow_run_id"),
	CONSTRAINT "import_jobs_id_shop_id_unique" UNIQUE("id","shop_id")
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"title" text NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"quantity" integer NOT NULL,
	"line_total_minor" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_lines_order_id_product_id_unique" UNIQUE("order_id","product_id"),
	CONSTRAINT "order_lines_unit_price_positive" CHECK ("order_lines"."unit_price_minor" > 0),
	CONSTRAINT "order_lines_quantity_positive" CHECK ("order_lines"."quantity" > 0),
	CONSTRAINT "order_lines_total_matches" CHECK ("order_lines"."line_total_minor" = "order_lines"."unit_price_minor" * "order_lines"."quantity")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" "order_kind" NOT NULL,
	"payment_status" "payment_status" DEFAULT 'pending' NOT NULL,
	"currency" text NOT NULL,
	"total_minor" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"payee_merchant_id" text NOT NULL,
	"paypal_order_id" text,
	"paypal_capture_id" text,
	"approval_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "orders_paypal_order_id_unique" UNIQUE("paypal_order_id"),
	CONSTRAINT "orders_paypal_capture_id_unique" UNIQUE("paypal_capture_id"),
	CONSTRAINT "orders_id_shop_id_unique" UNIQUE("id","shop_id"),
	CONSTRAINT "orders_id_paypal_capture_id_unique" UNIQUE("id","paypal_capture_id"),
	CONSTRAINT "orders_currency_format" CHECK ("orders"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "orders_total_positive" CHECK ("orders"."total_minor" > 0),
	CONSTRAINT "orders_paid_requires_capture" CHECK ("orders"."payment_status" <> 'paid' OR "orders"."paypal_capture_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" "product_kind" NOT NULL,
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price_minor" integer,
	"availability" "product_availability" DEFAULT 'available' NOT NULL,
	"service_duration_minutes" integer,
	"deposit_minor" integer,
	"paypal_product_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_paypal_product_id_unique" UNIQUE("paypal_product_id"),
	CONSTRAINT "products_id_shop_id_unique" UNIQUE("id","shop_id"),
	CONSTRAINT "products_title_not_blank" CHECK (btrim("products"."title") <> ''),
	CONSTRAINT "products_price_positive" CHECK ("products"."price_minor" IS NULL OR "products"."price_minor" > 0),
	CONSTRAINT "products_published_requires_price" CHECK ("products"."status" <> 'published' OR "products"."price_minor" IS NOT NULL),
	CONSTRAINT "products_service_fields_only_on_services" CHECK ("products"."kind" = 'service' OR ("products"."service_duration_minutes" IS NULL AND "products"."deposit_minor" IS NULL)),
	CONSTRAINT "products_published_service_requires_terms" CHECK ("products"."kind" <> 'service' OR "products"."status" <> 'published' OR ("products"."service_duration_minutes" IS NOT NULL AND "products"."deposit_minor" IS NOT NULL)),
	CONSTRAINT "products_service_duration_positive" CHECK ("products"."service_duration_minutes" IS NULL OR "products"."service_duration_minutes" > 0),
	CONSTRAINT "products_deposit_within_price" CHECK ("products"."deposit_minor" IS NULL OR ("products"."deposit_minor" > 0 AND "products"."deposit_minor" <= "products"."price_minor"))
);
--> statement-breakpoint
CREATE TABLE "search_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query_normalized" text NOT NULL,
	"location" text,
	"max_price_minor" integer,
	"currency" text,
	"result_count" integer NOT NULL,
	"matched_product_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"attributed_shop_id" uuid,
	"origin" "search_event_origin" DEFAULT 'observed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_events_query_length" CHECK (char_length("search_events"."query_normalized") BETWEEN 1 AND 200),
	CONSTRAINT "search_events_result_count" CHECK ("search_events"."result_count" >= 0),
	CONSTRAINT "search_events_max_price" CHECK ("search_events"."max_price_minor" IS NULL OR "search_events"."max_price_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"location" text,
	"currency" text NOT NULL,
	"timezone" text NOT NULL,
	"paypal_credential_ref" text NOT NULL,
	"paypal_merchant_id" text,
	"seller_access_code_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shops_slug_unique" UNIQUE("slug"),
	CONSTRAINT "shops_paypal_merchant_id_unique" UNIQUE("paypal_merchant_id"),
	CONSTRAINT "shops_slug_format" CHECK ("shops"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "shops_currency_format" CHECK ("shops"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "shops_paypal_credential_ref_format" CHECK ("shops"."paypal_credential_ref" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "technicians" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "technicians_id_shop_id_unique" UNIQUE("id","shop_id"),
	CONSTRAINT "technicians_shop_id_name_unique" UNIQUE("shop_id","name")
);
--> statement-breakpoint
CREATE TABLE "webhook_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"resource_id" text,
	"shop_id" uuid,
	"order_id" uuid,
	"status" "webhook_receipt_status" DEFAULT 'received' NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_receipts_provider_event_id_unique" UNIQUE("provider_event_id"),
	CONSTRAINT "webhook_receipts_order_requires_shop" CHECK ("webhook_receipts"."order_id" IS NULL OR "webhook_receipts"."shop_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_shop_fk" FOREIGN KEY ("service_id","shop_id") REFERENCES "public"."products"("id","shop_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_technician_shop_fk" FOREIGN KEY ("technician_id","shop_id") REFERENCES "public"."technicians"("id","shop_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_order_shop_fk" FOREIGN KEY ("order_id","shop_id") REFERENCES "public"."orders"("id","shop_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_order_capture_fk" FOREIGN KEY ("order_id","deposit_capture_id") REFERENCES "public"."orders"("id","paypal_capture_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_shop_fk" FOREIGN KEY ("order_id","shop_id") REFERENCES "public"."orders"("id","shop_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_product_shop_fk" FOREIGN KEY ("product_id","shop_id") REFERENCES "public"."products"("id","shop_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_events" ADD CONSTRAINT "search_events_attributed_shop_id_shops_id_fk" FOREIGN KEY ("attributed_shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technicians" ADD CONSTRAINT "technicians_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_receipts" ADD CONSTRAINT "webhook_receipts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_receipts" ADD CONSTRAINT "webhook_receipts_order_shop_fk" FOREIGN KEY ("order_id","shop_id") REFERENCES "public"."orders"("id","shop_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_shop_id_starts_at_idx" ON "bookings" USING btree ("shop_id","starts_at");--> statement-breakpoint
CREATE INDEX "import_jobs_shop_id_created_at_idx" ON "import_jobs" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_shop_id_created_at_idx" ON "orders" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "products_shop_id_status_idx" ON "products" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "search_events_created_at_idx" ON "search_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "search_events_attributed_shop_id_created_at_idx" ON "search_events" USING btree ("attributed_shop_id","created_at");