ALTER TABLE "orders" ADD COLUMN "paypal_credential_ref" text;--> statement-breakpoint
UPDATE "orders" AS o
SET "paypal_credential_ref" = s."paypal_credential_ref"
FROM "shops" AS s
WHERE o."shop_id" = s."id" AND o."paypal_credential_ref" IS NULL;--> statement-breakpoint
