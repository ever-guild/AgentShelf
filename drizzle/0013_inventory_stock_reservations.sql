CREATE TABLE "inventory_adjustments" (
	"shop_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"result_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_adjustments_shop_id_idempotency_key_pk" PRIMARY KEY("shop_id","idempotency_key"),
	CONSTRAINT "inventory_adjustments_idempotency_key_length" CHECK (length("inventory_adjustments"."idempotency_key") BETWEEN 16 AND 128),
	CONSTRAINT "inventory_adjustments_request_hash_length" CHECK (length("inventory_adjustments"."request_hash") = 64),
	CONSTRAINT "inventory_adjustments_result_version" CHECK ("inventory_adjustments"."result_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"shop_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"quantity_delta" integer,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"version_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_audit_shop_idempotency_key_unique" UNIQUE("shop_id","idempotency_key"),
	CONSTRAINT "inventory_audit_event_type" CHECK ("inventory_audit"."event_type" IN ('mode_set', 'adjusted')),
	CONSTRAINT "inventory_audit_reason_length" CHECK (length("inventory_audit"."reason") BETWEEN 3 AND 500),
	CONSTRAINT "inventory_audit_version_after" CHECK ("inventory_audit"."version_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_reservation_lines" (
	"reservation_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "inventory_reservation_lines_reservation_id_product_id_pk" PRIMARY KEY("reservation_id","product_id"),
	CONSTRAINT "inventory_reservation_lines_quantity_positive" CHECK ("inventory_reservation_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"capture_id" text,
	"release_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reservations_capture_id_unique" UNIQUE("capture_id"),
	CONSTRAINT "inventory_reservations_shop_idempotency_key_unique" UNIQUE("shop_id","idempotency_key"),
	CONSTRAINT "inventory_reservations_id_shop_id_unique" UNIQUE("id","shop_id"),
	CONSTRAINT "inventory_reservations_idempotency_key_length" CHECK (length("inventory_reservations"."idempotency_key") BETWEEN 16 AND 128),
	CONSTRAINT "inventory_reservations_request_hash_length" CHECK (length("inventory_reservations"."request_hash") = 64),
	CONSTRAINT "inventory_reservations_state" CHECK ("inventory_reservations"."state" IN ('reserved', 'capture_pending', 'committed', 'released', 'review_required')),
	CONSTRAINT "inventory_reservations_committed_capture" CHECK (("inventory_reservations"."state" = 'committed' AND "inventory_reservations"."capture_id" IS NOT NULL) OR "inventory_reservations"."state" <> 'committed'),
	CONSTRAINT "inventory_reservations_released_reason" CHECK ("inventory_reservations"."state" <> 'released' OR "inventory_reservations"."release_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "inventory_stock" (
	"shop_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"on_hand" integer,
	"reserved" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stock_shop_id_product_id_pk" PRIMARY KEY("shop_id","product_id"),
	CONSTRAINT "inventory_stock_mode" CHECK ("inventory_stock"."mode" IN ('tracked', 'untracked')),
	CONSTRAINT "inventory_stock_reserved" CHECK ("inventory_stock"."reserved" BETWEEN 0 AND 1000000),
	CONSTRAINT "inventory_stock_version" CHECK ("inventory_stock"."version" >= 0),
	CONSTRAINT "inventory_stock_quantities" CHECK (("inventory_stock"."mode" = 'tracked' AND "inventory_stock"."on_hand" IS NOT NULL AND "inventory_stock"."on_hand" >= "inventory_stock"."reserved" AND "inventory_stock"."on_hand" <= 1000000) OR
        ("inventory_stock"."mode" = 'untracked' AND "inventory_stock"."on_hand" IS NULL AND "inventory_stock"."reserved" = 0))
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "inventory_reservation_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservation_lines" ADD CONSTRAINT "inventory_reservation_lines_reservation_id_shop_id_inventory_reservations_id_shop_id_fk" FOREIGN KEY ("reservation_id","shop_id") REFERENCES "public"."inventory_reservations"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservation_lines" ADD CONSTRAINT "inventory_reservation_lines_shop_id_product_id_inventory_stock_shop_id_product_id_fk" FOREIGN KEY ("shop_id","product_id") REFERENCES "public"."inventory_stock"("shop_id","product_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_product_id_shop_id_products_id_shop_id_fk" FOREIGN KEY ("product_id","shop_id") REFERENCES "public"."products"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_reservations_expiry_idx" ON "inventory_reservations" USING btree ("expires_at") WHERE "inventory_reservations"."state" = 'reserved';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_inventory_reservation_shop_fk" FOREIGN KEY ("inventory_reservation_id","shop_id") REFERENCES "public"."inventory_reservations"("id","shop_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_inventory_reservation_id_unique" ON "orders" USING btree ("inventory_reservation_id") WHERE "orders"."inventory_reservation_id" IS NOT NULL;--> statement-breakpoint
-- Inventory audit rows are append-only; manual stock edits must remain reviewable.
CREATE FUNCTION inventory_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory audit rows are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inventory_audit_immutable_trigger
  BEFORE UPDATE OR DELETE ON inventory_audit
  FOR EACH ROW EXECUTE FUNCTION inventory_audit_immutable();
--> statement-breakpoint
