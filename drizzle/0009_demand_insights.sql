CREATE TABLE "demand_insights" (
	"shop_id" uuid NOT NULL,
	"period_days" integer NOT NULL,
	"snapshot" text NOT NULL,
	"window_start_date" text NOT NULL,
	"window_end_date" text NOT NULL,
	"unmet_searches" integer NOT NULL,
	"items" jsonb NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"written_at" timestamp with time zone NOT NULL,
	CONSTRAINT "demand_insights_shop_id_period_days_pk" PRIMARY KEY("shop_id","period_days"),
	CONSTRAINT "demand_insights_period" CHECK ("demand_insights"."period_days" IN (7, 30, 60)),
	CONSTRAINT "demand_insights_counts" CHECK ("demand_insights"."unmet_searches" > 0)
);
--> statement-breakpoint
CREATE TABLE "seller_ai_calls" (
	"shop_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"calls" integer NOT NULL,
	CONSTRAINT "seller_ai_calls_shop_id_hour_pk" PRIMARY KEY("shop_id","hour"),
	CONSTRAINT "seller_ai_calls_positive" CHECK ("seller_ai_calls"."calls" > 0)
);
--> statement-breakpoint
ALTER TABLE "demand_insights" ADD CONSTRAINT "demand_insights_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_ai_calls" ADD CONSTRAINT "seller_ai_calls_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;