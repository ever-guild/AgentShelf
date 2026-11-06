CREATE TABLE "seller_owner_paypal_identities" (
	"provider" text DEFAULT 'paypal_sandbox' NOT NULL,
	"subject_hash" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"display_name" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_owner_paypal_identities_provider_subject_hash_pk" PRIMARY KEY("provider","subject_hash"),
	CONSTRAINT "seller_owner_paypal_identity_provider" CHECK ("seller_owner_paypal_identities"."provider" = 'paypal_sandbox'),
	CONSTRAINT "seller_owner_paypal_identity_subject_hash" CHECK ("seller_owner_paypal_identities"."subject_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "seller_owner_paypal_identity_display_name" CHECK ("seller_owner_paypal_identities"."display_name" IS NULL OR length("seller_owner_paypal_identities"."display_name") <= 160),
	CONSTRAINT "seller_owner_paypal_identity_email" CHECK ("seller_owner_paypal_identities"."email" IS NULL OR length("seller_owner_paypal_identities"."email") <= 320)
);
--> statement-breakpoint
CREATE TABLE "seller_paypal_login_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"browser_binding_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_paypal_login_state_hash" CHECK ("seller_paypal_login_states"."state_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "seller_paypal_login_binding_hash" CHECK ("seller_paypal_login_states"."browser_binding_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "seller_owners" DROP CONSTRAINT "seller_owners_password_hash_format";--> statement-breakpoint
ALTER TABLE "seller_owners" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "seller_owner_paypal_identities" ADD CONSTRAINT "seller_owner_paypal_identities_owner_id_seller_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."seller_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_owner_paypal_identity_owner_unique" ON "seller_owner_paypal_identities" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "seller_paypal_login_states_expiry_idx" ON "seller_paypal_login_states" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "seller_owners" ADD CONSTRAINT "seller_owners_password_hash_format" CHECK ("seller_owners"."password_hash" IS NULL OR (split_part("seller_owners"."password_hash", '$', 1) = 'scrypt' AND
        split_part("seller_owners"."password_hash", '$', 2) = '16384' AND
        split_part("seller_owners"."password_hash", '$', 3) = '8' AND
        split_part("seller_owners"."password_hash", '$', 4) = '1' AND
        split_part("seller_owners"."password_hash", '$', 5) ~ '^[A-Za-z0-9_-]{22}$' AND
        split_part("seller_owners"."password_hash", '$', 6) ~ '^[A-Za-z0-9_-]{43}$' AND
        split_part("seller_owners"."password_hash", '$', 7) = ''));