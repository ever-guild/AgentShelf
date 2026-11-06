CREATE TYPE "public"."import_row_status" AS ENUM('pending', 'accepted', 'removed');--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"source_ref" text NOT NULL,
	"status" "import_row_status" DEFAULT 'pending' NOT NULL,
	"title" text,
	"kind" "product_kind",
	"price_text" text,
	"price_minor" integer,
	"currency" text,
	"service_duration_minutes" integer,
	"deposit_minor" integer,
	"description" text,
	"description_en" text,
	"description_lv" text,
	"source_warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_rows_job_id_position_unique" UNIQUE("job_id","position"),
	CONSTRAINT "import_rows_position_not_negative" CHECK ("import_rows"."position" >= 0),
	CONSTRAINT "import_rows_price_positive" CHECK ("import_rows"."price_minor" IS NULL OR "import_rows"."price_minor" > 0),
	CONSTRAINT "import_rows_currency_format" CHECK ("import_rows"."currency" IS NULL OR "import_rows"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "import_rows_duration_positive" CHECK ("import_rows"."service_duration_minutes" IS NULL OR "import_rows"."service_duration_minutes" > 0),
	CONSTRAINT "import_rows_deposit_positive" CHECK ("import_rows"."deposit_minor" IS NULL OR "import_rows"."deposit_minor" > 0),
	CONSTRAINT "import_rows_accepted_is_complete" CHECK ("import_rows"."status" <> 'accepted' OR (
        "import_rows"."title" IS NOT NULL AND btrim("import_rows"."title") <> ''
        AND "import_rows"."kind" IS NOT NULL
        AND "import_rows"."price_minor" IS NOT NULL
        AND "import_rows"."currency" IS NOT NULL
      )),
	CONSTRAINT "import_rows_accepted_service_has_terms" CHECK ("import_rows"."status" <> 'accepted' OR "import_rows"."kind" <> 'service' OR (
        "import_rows"."service_duration_minutes" IS NOT NULL
        AND "import_rows"."deposit_minor" IS NOT NULL
        AND "import_rows"."deposit_minor" <= "import_rows"."price_minor"
      )),
	CONSTRAINT "import_rows_accepted_product_has_no_service_terms" CHECK ("import_rows"."status" <> 'accepted' OR "import_rows"."kind" <> 'product' OR (
        "import_rows"."service_duration_minutes" IS NULL AND "import_rows"."deposit_minor" IS NULL
      ))
);
--> statement-breakpoint
CREATE TABLE "import_sources" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"media_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_sources_media_type" CHECK ("import_sources"."media_type" IN ('image/jpeg', 'image/png', 'image/webp'))
);
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "run_token" uuid;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_job_shop_fk" FOREIGN KEY ("job_id","shop_id") REFERENCES "public"."import_jobs"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_sources" ADD CONSTRAINT "import_sources_job_shop_fk" FOREIGN KEY ("job_id","shop_id") REFERENCES "public"."import_jobs"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_sources_expires_at_idx" ON "import_sources" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "import_jobs_status_idx" ON "import_jobs" USING btree ("status");--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_attempts_not_negative" CHECK ("import_jobs"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_running_holds_lease" CHECK ("import_jobs"."status" <> 'running' OR ("import_jobs"."run_token" IS NOT NULL AND "import_jobs"."lease_expires_at" IS NOT NULL));