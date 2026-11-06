CREATE TABLE "owner_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_sessions_token_hash_format" CHECK ("owner_sessions"."token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "seller_agent_grants" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"shop_id" uuid,
	"scopes" text[] NOT NULL,
	"share_data_consent_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_idempotency_key" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_agent_grants_hash_format" CHECK ("seller_agent_grants"."token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "seller_agent_grants_scope" CHECK (("seller_agent_grants"."shop_id" IS NULL AND "seller_agent_grants"."scopes" = ARRAY['create_shop']::text[]) OR
        ("seller_agent_grants"."shop_id" IS NOT NULL AND cardinality("seller_agent_grants"."scopes") > 0 AND
         "seller_agent_grants"."scopes" <@ ARRAY['read_shop', 'manage_catalog', 'manage_inventory', 'connect_paypal']::text[])),
	CONSTRAINT "seller_agent_grants_paypal_consent" CHECK (NOT ('connect_paypal' = ANY("seller_agent_grants"."scopes")) OR "seller_agent_grants"."share_data_consent_at" IS NOT NULL),
	CONSTRAINT "seller_agent_grants_consumed_key" CHECK (("seller_agent_grants"."consumed_at" IS NULL) = ("seller_agent_grants"."consumed_idempotency_key" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "seller_identity_attempt_windows" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"attempts" integer NOT NULL,
	CONSTRAINT "seller_identity_attempts_bounded" CHECK ("seller_identity_attempt_windows"."attempts" BETWEEN 0 AND 1000),
	CONSTRAINT "seller_identity_attempt_key_format" CHECK ("seller_identity_attempt_windows"."key_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "seller_identity_operations" (
	"idempotency_key" uuid PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"owner_id" uuid,
	"shop_id" uuid,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_identity_operations_kind" CHECK ("seller_identity_operations"."operation" IN ('register_owner', 'register_owner_shop', 'create_shop')),
	CONSTRAINT "seller_identity_operations_request_hash" CHECK ("seller_identity_operations"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "seller_identity_operations_result_shape" CHECK (("seller_identity_operations"."owner_id" IS NULL AND "seller_identity_operations"."shop_id" IS NULL) OR
        ("seller_identity_operations"."operation" = 'register_owner' AND "seller_identity_operations"."owner_id" IS NOT NULL AND "seller_identity_operations"."shop_id" IS NULL) OR
        ("seller_identity_operations"."operation" IN ('register_owner_shop', 'create_shop') AND "seller_identity_operations"."owner_id" IS NOT NULL AND "seller_identity_operations"."shop_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "seller_owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_owners_username_format" CHECK ("seller_owners"."username" ~ '^[a-z0-9_.-]{3,64}$'),
	CONSTRAINT "seller_owners_password_hash_format" CHECK (split_part("seller_owners"."password_hash", '$', 1) = 'scrypt' AND
        split_part("seller_owners"."password_hash", '$', 2) = '16384' AND
        split_part("seller_owners"."password_hash", '$', 3) = '8' AND
        split_part("seller_owners"."password_hash", '$', 4) = '1' AND
        split_part("seller_owners"."password_hash", '$', 5) ~ '^[A-Za-z0-9_-]{22}$' AND
        split_part("seller_owners"."password_hash", '$', 6) ~ '^[A-Za-z0-9_-]{43}$' AND
        split_part("seller_owners"."password_hash", '$', 7) = '')
);
--> statement-breakpoint
CREATE TABLE "shop_memberships" (
	"owner_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_memberships_owner_id_shop_id_pk" PRIMARY KEY("owner_id","shop_id"),
	CONSTRAINT "shop_memberships_owner_role" CHECK ("shop_memberships"."role" = 'owner')
);
--> statement-breakpoint
ALTER TABLE "owner_sessions" ADD CONSTRAINT "owner_sessions_owner_id_seller_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."seller_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_agent_grants" ADD CONSTRAINT "seller_agent_grants_owner_id_seller_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."seller_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_agent_grants" ADD CONSTRAINT "seller_agent_grants_membership_fk" FOREIGN KEY ("owner_id","shop_id") REFERENCES "public"."shop_memberships"("owner_id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_identity_operations" ADD CONSTRAINT "seller_identity_operations_owner_id_seller_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."seller_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_identity_operations" ADD CONSTRAINT "seller_identity_operations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_memberships" ADD CONSTRAINT "shop_memberships_owner_id_seller_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."seller_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_memberships" ADD CONSTRAINT "shop_memberships_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_sessions_owner_idx" ON "owner_sessions" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "seller_agent_grants_owner_idx" ON "seller_agent_grants" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "seller_identity_attempt_window_idx" ON "seller_identity_attempt_windows" USING btree ("window_started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_owners_username_unique" ON "seller_owners" USING btree (lower("username"));--> statement-breakpoint
CREATE INDEX "shop_memberships_shop_idx" ON "shop_memberships" USING btree ("shop_id");