CREATE TYPE "public"."search_terms_status" AS ENUM('pending', 'indexed', 'failed');--> statement-breakpoint
CREATE TABLE "product_search_terms" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"status" "search_terms_status" DEFAULT 'pending' NOT NULL,
	"source_hash" text,
	"terms" text[] DEFAULT '{}'::text[] NOT NULL,
	"place_terms" text[] DEFAULT '{}'::text[] NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"model" text,
	"prompt_version" text,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_search_terms_attempts" CHECK ("product_search_terms"."attempts" >= 0),
	CONSTRAINT "product_search_terms_bounded" CHECK (cardinality("product_search_terms"."terms") <= 60 AND cardinality("product_search_terms"."place_terms") <= 12),
	CONSTRAINT "product_search_terms_indexed_is_complete" CHECK ("product_search_terms"."status" <> 'indexed' OR (
        "product_search_terms"."source_hash" IS NOT NULL
        AND "product_search_terms"."model" IS NOT NULL
        AND "product_search_terms"."prompt_version" IS NOT NULL
        AND "product_search_terms"."indexed_at" IS NOT NULL
      )),
	CONSTRAINT "product_search_terms_only_indexed_has_terms" CHECK ("product_search_terms"."status" = 'indexed' OR (cardinality("product_search_terms"."terms") = 0 AND cardinality("product_search_terms"."place_terms") = 0))
);
--> statement-breakpoint
ALTER TABLE "search_events" ADD COLUMN "search_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "search_events" ADD COLUMN "kind" "product_kind";--> statement-breakpoint
ALTER TABLE "search_events" ADD COLUMN "attribution_words" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "search_events" ADD COLUMN "attribution_product_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "search_events" ADD COLUMN "degraded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_search_terms" ADD CONSTRAINT "product_search_terms_product_shop_fk" FOREIGN KEY ("product_id","shop_id") REFERENCES "public"."products"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_search_terms_due_idx" ON "product_search_terms" USING btree ("next_attempt_at");--> statement-breakpoint
ALTER TABLE "search_events" ADD CONSTRAINT "search_events_attributed_only_on_a_miss" CHECK ("search_events"."attributed_shop_id" IS NULL OR "search_events"."result_count" = 0);--> statement-breakpoint
ALTER TABLE "search_events" ADD CONSTRAINT "search_events_basis_needs_a_shop" CHECK ("search_events"."attributed_shop_id" IS NOT NULL OR (
        cardinality("search_events"."attribution_words") = 0 AND cardinality("search_events"."attribution_product_ids") = 0
      ));