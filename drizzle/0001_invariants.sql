-- Invariants that drizzle's schema builder cannot express. Written by hand.

-- A technician cannot have two live claims on overlapping time, however many requests race.
-- Expired, cancelled and review-required rows no longer claim the slot.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_technician_no_overlap"
  EXCLUDE USING gist (
    "technician_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE ("status" IN ('held', 'confirmed'));
--> statement-breakpoint

-- Order lines are snapshots: never updated, never deleted.
CREATE FUNCTION reject_order_line_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'order_lines rows are immutable snapshots'
    USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'order_lines_immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_lines_immutable
  BEFORE UPDATE OR DELETE ON "order_lines"
  FOR EACH ROW EXECUTE FUNCTION reject_order_line_change();
--> statement-breakpoint

-- What an order charges, and to whom, is fixed at creation. Only its payment state and
-- provider identifiers may change afterwards.
CREATE FUNCTION reject_order_terms_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (NEW.shop_id, NEW.kind, NEW.currency, NEW.total_minor, NEW.payee_merchant_id,
      NEW.idempotency_key, NEW.request_fingerprint)
     IS DISTINCT FROM
     (OLD.shop_id, OLD.kind, OLD.currency, OLD.total_minor, OLD.payee_merchant_id,
      OLD.idempotency_key, OLD.request_fingerprint) THEN
    RAISE EXCEPTION 'order terms are immutable'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'orders_terms_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER orders_terms_immutable
  BEFORE UPDATE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION reject_order_terms_change();
