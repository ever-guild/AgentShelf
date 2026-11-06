CREATE TABLE "paypal_merchant_connection_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"connection_id" uuid,
	"seller_merchant_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_merchant_connection_webhook_event_id_length" CHECK (length("paypal_merchant_connection_webhook_events"."event_id") BETWEEN 1 AND 200),
	CONSTRAINT "paypal_merchant_connection_webhook_seller_merchant_id_format" CHECK ("paypal_merchant_connection_webhook_events"."seller_merchant_id" ~ '^[A-Za-z0-9_-]{3,128}$')
);
--> statement-breakpoint
CREATE TABLE "paypal_merchant_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"status" text NOT NULL,
	"tracking_id" text NOT NULL,
	"request_key_hash" text NOT NULL,
	"consented_by_owner_id" uuid NOT NULL,
	"share_data_consent_at" timestamp with time zone NOT NULL,
	"referral_self_url" text,
	"seller_merchant_id" text,
	"status_evidence" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_merchant_connections_tracking_id_unique" UNIQUE("tracking_id"),
	CONSTRAINT "paypal_merchant_connections_shop_request_key_unique" UNIQUE("shop_id","request_key_hash"),
	CONSTRAINT "paypal_merchant_connections_status" CHECK ("paypal_merchant_connections"."status" IN ('pending', 'ready', 'revoked', 'error')),
	CONSTRAINT "paypal_merchant_connections_tracking_id_format" CHECK ("paypal_merchant_connections"."tracking_id" ~ '^[A-Za-z0-9_-]{40,64}$'),
	CONSTRAINT "paypal_merchant_connections_request_key_hash_format" CHECK ("paypal_merchant_connections"."request_key_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "paypal_merchant_connections_seller_merchant_id_format" CHECK ("paypal_merchant_connections"."seller_merchant_id" IS NULL OR "paypal_merchant_connections"."seller_merchant_id" ~ '^[A-Za-z0-9_-]{3,128}$'),
	CONSTRAINT "paypal_merchant_connections_status_evidence_object" CHECK ("paypal_merchant_connections"."status_evidence" IS NULL OR jsonb_typeof("paypal_merchant_connections"."status_evidence") = 'object'),
	CONSTRAINT "paypal_merchant_connections_error_code" CHECK ("paypal_merchant_connections"."error_code" IS NULL OR "paypal_merchant_connections"."error_code" IN ('referral_rejected', 'provider_outcome_unknown', 'status_unavailable'))
);
--> statement-breakpoint
ALTER TABLE "paypal_merchant_connection_webhook_events" ADD CONSTRAINT "paypal_merchant_connection_webhook_events_connection_id_paypal_merchant_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."paypal_merchant_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_merchant_connections" ADD CONSTRAINT "paypal_merchant_connections_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_merchant_connections" ADD CONSTRAINT "paypal_merchant_connections_consent_owner_membership_fk" FOREIGN KEY ("consented_by_owner_id","shop_id") REFERENCES "public"."shop_memberships"("owner_id","shop_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paypal_merchant_connection_events_merchant_received_idx" ON "paypal_merchant_connection_webhook_events" USING btree ("seller_merchant_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "paypal_merchant_connections_one_active_per_shop" ON "paypal_merchant_connections" USING btree ("shop_id") WHERE "paypal_merchant_connections"."status" IN ('pending', 'ready') OR ("paypal_merchant_connections"."status" = 'error' AND ("paypal_merchant_connections"."error_code" = 'status_unavailable' OR "paypal_merchant_connections"."referral_self_url" IS NOT NULL));--> statement-breakpoint
CREATE INDEX "paypal_merchant_connections_shop_latest" ON "paypal_merchant_connections" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "paypal_merchant_connections_active_merchant_unique" ON "paypal_merchant_connections" USING btree ("seller_merchant_id") WHERE "paypal_merchant_connections"."status" IN ('pending', 'ready') AND "paypal_merchant_connections"."seller_merchant_id" IS NOT NULL;