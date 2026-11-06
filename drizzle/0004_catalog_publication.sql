CREATE TYPE "public"."catalog_sync_status" AS ENUM('pending', 'synced', 'failed', 'not_configured');--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "description_en" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "description_lv" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "paypal_sync_status" "catalog_sync_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "paypal_sync_error" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "paypal_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "import_job_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "import_position" integer;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_import_job_shop_fk" FOREIGN KEY ("import_job_id","shop_id") REFERENCES "public"."import_jobs"("id","shop_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_import_job_id_position_unique" UNIQUE("import_job_id","import_position");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_import_source_complete" CHECK (("products"."import_job_id" IS NULL) = ("products"."import_position" IS NULL));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_synced_requires_record" CHECK ("products"."paypal_sync_status" <> 'synced' OR ("products"."paypal_product_id" IS NOT NULL AND "products"."paypal_synced_at" IS NOT NULL));