CREATE TYPE "public"."booking_review_reason" AS ENUM('late_capture', 'captured_after_cancel');--> statement-breakpoint
CREATE TABLE "technician_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "technician_windows_weekday" CHECK ("technician_windows"."weekday" BETWEEN 1 AND 7),
	CONSTRAINT "technician_windows_within_day" CHECK ("technician_windows"."start_minute" >= 0 AND "technician_windows"."end_minute" <= 1440 AND "technician_windows"."end_minute" > "technician_windows"."start_minute")
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "service_price_minor" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "review_reason" "booking_review_reason";--> statement-breakpoint
ALTER TABLE "technician_windows" ADD CONSTRAINT "technician_windows_technician_shop_fk" FOREIGN KEY ("technician_id","shop_id") REFERENCES "public"."technicians"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "technician_windows_shop_id_idx" ON "technician_windows" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "bookings_held_expiry_idx" ON "bookings" USING btree ("hold_expires_at") WHERE "bookings"."status" = 'held';--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_price_positive" CHECK ("bookings"."service_price_minor" > 0);--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_review_states_reason" CHECK (("bookings"."status" = 'review_required') = ("bookings"."review_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_review_requires_capture" CHECK ("bookings"."status" <> 'review_required' OR "bookings"."deposit_capture_id" IS NOT NULL);