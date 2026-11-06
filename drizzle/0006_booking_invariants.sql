-- Booking rules that drizzle's schema builder cannot express. Written by hand.

-- One technician's working windows cannot overlap on a weekday, so a slot is offered once.
ALTER TABLE "technician_windows"
  ADD CONSTRAINT "technician_windows_no_overlap"
  EXCLUDE USING gist (
    "technician_id" WITH =,
    "weekday" WITH =,
    int4range("start_minute", "end_minute", '[)') WITH &&
  );
--> statement-breakpoint

-- A closed order keeps no time. Every write that cancels or fails an order, wherever it comes from,
-- releases the hold in the same transaction. A confirmed booking is not touched, and a capture that
-- arrives after this goes to review.
CREATE FUNCTION release_hold_of_closed_order() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  UPDATE "bookings"
    SET "status" = 'cancelled', "updated_at" = now()
    WHERE "order_id" = NEW."id" AND "status" = 'held';
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER orders_release_hold
  AFTER UPDATE OF "payment_status" ON "orders"
  FOR EACH ROW
  WHEN (
    NEW."payment_status" IN ('cancelled', 'failed')
    AND OLD."payment_status" IS DISTINCT FROM NEW."payment_status"
  )
  EXECUTE FUNCTION release_hold_of_closed_order();
