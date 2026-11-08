import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import type { CheckoutQuote } from "../services/checkout-quote";
import { InventoryError } from "./postgres";
import { beginInventoryCaptureInTransaction, commitReservationInTransaction, releaseReservationInTransaction, reserveInventoryInTransaction, type InventoryCapturePermit } from "./postgres";

export type ReservedPhysicalOrder = Readonly<{
  orderId: string;
  reservationId: string;
  shopId: string;
  currency: string;
  totalMinor: number;
  expiresAt: Date;
  reused: boolean;
}>;

export type PhysicalCaptureGate =
  | InventoryCapturePermit
  | { allowed: true; reason: "retry" }
  | { allowed: false; reason: "missing_reservation" | "ambiguous_expired" };
export type PhysicalRefusalDisposition = "rearmed" | "expired" | "terminal";

export async function assertPhysicalOrderAllocationLive(pool: Pool, orderId: string, now = new Date()): Promise<void> {
  const result = await pool.query<{ state: string; expires_at: Date }>(
    `SELECT r.state, r.expires_at FROM orders o
     JOIN inventory_reservations r ON r.id=o.inventory_reservation_id AND r.shop_id=o.shop_id
     WHERE o.id=$1 AND o.kind='purchase'`,
    [orderId],
  );
  if (!result.rowCount || result.rows[0].state !== "reserved" || result.rows[0].expires_at <= now) {
    throw new InventoryError("REVIEW_REQUIRED", "This checkout no longer has a live stock allocation.");
  }
}

function validateQuote(quote: CheckoutQuote): void {
  if (!quote.shopId || !quote.payeeMerchantId || !quote.paypalCredentialRef || !/^[A-Z]{3}$/.test(quote.currency)) {
    throw new InventoryError("INVALID", "A complete server-resolved physical checkout quote is required.");
  }
  if (!Number.isSafeInteger(quote.totalMinor) || quote.totalMinor <= 0 || quote.lines.length === 0 || quote.lines.length > 50) {
    throw new InventoryError("INVALID", "The physical checkout quote is invalid.");
  }
  const ids = new Set<string>();
  let total = 0;
  for (const line of quote.lines) {
    if (!line.productId || ids.has(line.productId) || !Number.isSafeInteger(line.quantity) || line.quantity <= 0 || !Number.isSafeInteger(line.unitPriceMinor) || line.unitPriceMinor <= 0 || !Number.isSafeInteger(line.lineTotalMinor) || line.lineTotalMinor !== line.unitPriceMinor * line.quantity || !Number.isSafeInteger(total + line.lineTotalMinor)) {
      throw new InventoryError("INVALID", "The physical checkout quote contains an invalid line.");
    }
    ids.add(line.productId);
    total += line.lineTotalMinor;
  }
  if (total !== quote.totalMinor) throw new InventoryError("INVALID", "The physical checkout quote total does not match its lines.");
}

async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Looks up the immutable order-to-reservation link and claims the live capture attempt. */
export async function beginPhysicalOrderCapture(pool: Pool, orderId: string, now = new Date()): Promise<PhysicalCaptureGate> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ shop_id: string; inventory_reservation_id: string | null }>(
      "SELECT shop_id, inventory_reservation_id FROM orders WHERE id=$1 AND kind='purchase' FOR UPDATE",
      [orderId],
    );
    if (!result.rowCount || !result.rows[0].inventory_reservation_id) return { allowed: false, reason: "missing_reservation" };
    return beginInventoryCaptureInTransaction(client, result.rows[0].shop_id, result.rows[0].inventory_reservation_id, now);
  });
}

/**
 * Reclaims a timed-out physical capture request only after the caller has just verified that
 * PayPal still reports the order as approved. The fixed PayPal-Request-Id makes this retry
 * idempotent. Once the allocation expires, the outcome is ambiguous and stock stays held for
 * review; expiry alone is never evidence that the provider did not capture.
 */
export async function retryPhysicalOrderCapture(pool: Pool, orderId: string, now = new Date()): Promise<PhysicalCaptureGate> {
  return withTransaction(pool, async (client) => {
    const order = await client.query<{
      shop_id: string;
      inventory_reservation_id: string | null;
      payment_status: string;
    }>(
      "SELECT shop_id, inventory_reservation_id, payment_status FROM orders WHERE id=$1 AND kind='purchase' FOR UPDATE",
      [orderId],
    );
    if (!order.rowCount || !order.rows[0].inventory_reservation_id) {
      return { allowed: false, reason: "missing_reservation" };
    }
    if (!["pending", "approved"].includes(order.rows[0].payment_status)) {
      return { allowed: false, reason: "terminal" };
    }

    const reservation = await client.query<{ state: string; expires_at: Date }>(
      "SELECT state, expires_at FROM inventory_reservations WHERE shop_id=$1 AND id=$2 FOR UPDATE",
      [order.rows[0].shop_id, order.rows[0].inventory_reservation_id],
    );
    if (!reservation.rowCount || reservation.rows[0].state !== "capture_pending") {
      return { allowed: false, reason: "terminal" };
    }
    if (reservation.rows[0].expires_at <= now) {
      return { allowed: false, reason: "ambiguous_expired" };
    }
    return { allowed: true, reason: "retry" };
  });
}

/** Allows review-state reconciliation to read a previously started provider capture, never start one. */
export async function hasUnresolvedPhysicalCapture(pool: Pool, orderId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM orders o
     JOIN inventory_reservations r ON r.id=o.inventory_reservation_id AND r.shop_id=o.shop_id
     WHERE o.id=$1 AND o.kind='purchase' AND r.state='capture_pending'`,
    [orderId],
  );
  return result.rows.length > 0;
}

/**
 * Closes a purchase only after the caller has a verified provider result that is unpaid.
 * The order status and stock release share a transaction; ambiguous provider outcomes must not
 * call this function.
 */
export async function closePhysicalOrderAfterVerifiedUnpaid(
  pool: Pool,
  orderId: string,
  outcome: "verified_unpaid" | "verified_cancelled" | "verified_expired_unpaid",
  finalStatus: "failed" | "cancelled",
  captureAttemptFinal = false,
  now = new Date(),
  captureId?: string,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ shop_id: string; inventory_reservation_id: string | null; kind: string; payment_status: string }>(
      "SELECT shop_id, inventory_reservation_id, kind, payment_status FROM orders WHERE id=$1 FOR UPDATE",
      [orderId],
    );
    if (!result.rowCount || result.rows[0].kind !== "purchase") return false;
    const order = result.rows[0];
    if (["paid", "review_required"].includes(order.payment_status)) return false;
    if (order.inventory_reservation_id) {
      const reservation = await client.query<{ state: string; expires_at: Date }>(
        "SELECT state, expires_at FROM inventory_reservations WHERE shop_id=$1 AND id=$2 FOR UPDATE",
        [order.shop_id, order.inventory_reservation_id],
      );
      if (!reservation.rowCount) throw new InventoryError("NOT_FOUND", "Inventory reservation was not found.");
      if (reservation.rows[0].state === "capture_pending" && !captureAttemptFinal) return false;
      if (["committed", "review_required"].includes(reservation.rows[0].state)) return false;
      if (outcome === "verified_expired_unpaid" && (reservation.rows[0].state !== "reserved" || reservation.rows[0].expires_at > now)) return false;
      await releaseReservationInTransaction(client, order.shop_id, order.inventory_reservation_id, outcome);
    }
    await client.query(
      "UPDATE orders SET payment_status=$2, paypal_capture_id=coalesce(paypal_capture_id,$3), updated_at=now() WHERE id=$1 AND payment_status <> 'paid'",
      [orderId, finalStatus, captureId ?? null],
    );
    return true;
  });
}

/**
 * A provider rejection such as INSTRUMENT_DECLINED confirms that no capture record was created.
 * It can reopen a still-live allocation for the buyer's next funding choice, but never after expiry.
 */
export async function rearmPhysicalOrderAfterVerifiedRefusal(pool: Pool, orderId: string, now = new Date()): Promise<PhysicalRefusalDisposition> {
  return withTransaction(pool, async (client) => {
    const orderResult = await client.query<{ shop_id: string; inventory_reservation_id: string | null; kind: string; payment_status: string }>(
      "SELECT shop_id, inventory_reservation_id, kind, payment_status FROM orders WHERE id=$1 FOR UPDATE",
      [orderId],
    );
    if (!orderResult.rowCount || orderResult.rows[0].kind !== "purchase" || !orderResult.rows[0].inventory_reservation_id) return "terminal";
    const order = orderResult.rows[0];
    if (["paid", "review_required"].includes(order.payment_status)) return "terminal";
    const reservationId = order.inventory_reservation_id;
    if (!reservationId) return "terminal";
    const reservation = await client.query<{ state: string; expires_at: Date }>(
      "SELECT state, expires_at FROM inventory_reservations WHERE shop_id=$1 AND id=$2 FOR UPDATE",
      [order.shop_id, reservationId],
    );
    if (!reservation.rowCount) return "terminal";
    const state = reservation.rows[0].state;
    if (state === "reserved" && reservation.rows[0].expires_at > now) {
      await client.query("UPDATE orders SET payment_status='approved', updated_at=now() WHERE id=$1", [orderId]);
      return "rearmed";
    }
    if (state === "capture_pending" && reservation.rows[0].expires_at > now) {
      await client.query(
        "UPDATE inventory_reservations SET state='reserved', updated_at=now() WHERE shop_id=$1 AND id=$2 AND state='capture_pending'",
        [order.shop_id, reservationId],
      );
      await client.query("UPDATE orders SET payment_status='approved', updated_at=now() WHERE id=$1", [orderId]);
      return "rearmed";
    }
    if (["reserved", "capture_pending"].includes(state) && reservation.rows[0].expires_at <= now) {
      await releaseReservationInTransaction(client, order.shop_id, reservationId, "verified_expired_unpaid");
      await client.query("UPDATE orders SET payment_status='cancelled', updated_at=now() WHERE id=$1", [orderId]);
      return "expired";
    }
    return "terminal";
  });
}

/** Atomically settles provider evidence and stock before marking a physical purchase paid. */
export async function settlePhysicalOrderCapture(
  pool: Pool,
  orderId: string,
  proof: { captureId: string; providerStatus: "COMPLETED"; capturedAt: Date; verified: true },
  onCommitted?: (client: PoolClient, orderId: string) => Promise<void>,
): Promise<"paid" | "review_required"> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{
      shop_id: string;
      kind: string;
      payment_status: string;
      paypal_capture_id: string | null;
      inventory_reservation_id: string | null;
    }>(
      `SELECT shop_id, kind, payment_status, paypal_capture_id, inventory_reservation_id
       FROM orders WHERE id=$1 FOR UPDATE`,
      [orderId],
    );
    if (!result.rowCount || result.rows[0].kind !== "purchase") throw new InventoryError("NOT_FOUND", "Physical order was not found.");
    const order = result.rows[0];
    if (!proof.captureId.trim() || proof.captureId.length > 256 || proof.providerStatus !== "COMPLETED" || proof.verified !== true || !(proof.capturedAt instanceof Date) || Number.isNaN(proof.capturedAt.getTime())) {
      throw new InventoryError("INVALID", "Verified capture identity and provider timestamp are required.");
    }
    if (order.paypal_capture_id && order.paypal_capture_id !== proof.captureId) {
      await client.query("UPDATE orders SET payment_status='review_required', updated_at=now() WHERE id=$1", [orderId]);
      return "review_required";
    }
    if (order.payment_status === "paid") return "paid";
    if (order.payment_status === "review_required" && order.paypal_capture_id === proof.captureId) return "review_required";
    if (!order.inventory_reservation_id) {
      await client.query(
        "UPDATE orders SET payment_status='review_required', paypal_capture_id=coalesce(paypal_capture_id,$2), updated_at=now() WHERE id=$1",
        [orderId, proof.captureId],
      );
      return "review_required";
    }
    const reservation = await commitReservationInTransaction(client, order.shop_id, order.inventory_reservation_id, proof);
    const status = reservation.state === "committed" ? "paid" : "review_required";
    await client.query(
      "UPDATE orders SET payment_status=$2, paypal_capture_id=coalesce(paypal_capture_id,$3), updated_at=now() WHERE id=$1",
      [orderId, status, proof.captureId],
    );
    if (status === "paid") await onCommitted?.(client, orderId);
    return status;
  });
}

/**
 * Persists a purchase order, immutable line snapshots, and its stock allocation atomically.
 * It does not create or capture a PayPal order. The caller must still enforce the payment
 * capture gate through the inventory reservation before asking the provider to capture.
 */
export async function createReservedPhysicalOrder(
  pool: Pool,
  input: { quote: CheckoutQuote; idempotencyKey: string; requestFingerprint: string; expiresAt: Date },
): Promise<ReservedPhysicalOrder> {
  const { quote, idempotencyKey, requestFingerprint, expiresAt } = input;
  validateQuote(quote);
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey) || !/^[a-f0-9]{64}$/.test(requestFingerprint) || Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
    throw new InventoryError("INVALID", "The checkout idempotency key, fingerprint, or reservation expiry is invalid.");
  }
  return withTransaction(pool, async (client) => {
    // Orders have a globally unique idempotency key, so serialize globally, not per shop.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [idempotencyKey]);
    const existing = await client.query<{
      id: string;
      shop_id: string;
      request_fingerprint: string;
      inventory_reservation_id: string | null;
      reservation_expires_at: Date | null;
      currency: string;
      total_minor: number;
    }>(
      `SELECT o.id, o.shop_id, o.request_fingerprint, o.inventory_reservation_id,
              r.expires_at AS reservation_expires_at, o.currency, o.total_minor
       FROM orders o
       LEFT JOIN inventory_reservations r ON r.id=o.inventory_reservation_id AND r.shop_id=o.shop_id
       WHERE o.idempotency_key=$1 FOR UPDATE OF o`,
      [idempotencyKey],
    );
    if (existing.rowCount) {
      const order = existing.rows[0];
      if (order.request_fingerprint !== requestFingerprint || order.shop_id !== quote.shopId) {
        throw new InventoryError("CONFLICT", "Idempotency key was already used for another checkout.");
      }
      if (!order.inventory_reservation_id) {
        throw new InventoryError("REVIEW_REQUIRED", "This existing order has no physical stock allocation and needs reconciliation.");
      }
      return {
        orderId: order.id,
        reservationId: order.inventory_reservation_id,
        shopId: order.shop_id,
        currency: order.currency,
        totalMinor: Number(order.total_minor),
        expiresAt: order.reservation_expires_at ?? expiresAt,
        reused: true,
      };
    }

    if (checkoutRequestFingerprint(quote.lines) !== requestFingerprint) {
      throw new InventoryError("INVALID", "The checkout fingerprint does not match the quoted physical cart.");
    }

    const reservation = await reserveInventoryInTransaction(client, quote.shopId, idempotencyKey, quote.lines.map(({ productId, quantity }) => ({ productId, quantity })), expiresAt);
    const orderId = randomUUID();
    await client.query(
      `INSERT INTO orders
       (id, shop_id, kind, currency, total_minor, idempotency_key, request_fingerprint, payee_merchant_id, paypal_credential_ref, inventory_reservation_id)
       VALUES ($1,$2,'purchase',$3,$4,$5,$6,$7,$8,$9)`,
      [orderId, quote.shopId, quote.currency, quote.totalMinor, idempotencyKey, requestFingerprint, quote.payeeMerchantId, quote.paypalCredentialRef, reservation.id],
    );
    for (const line of quote.lines) {
      await client.query(
        `INSERT INTO order_lines (order_id, shop_id, product_id, title, unit_price_minor, quantity, line_total_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orderId, quote.shopId, line.productId, line.title, line.unitPriceMinor, line.quantity, line.lineTotalMinor],
      );
    }
    return {
      orderId,
      reservationId: reservation.id,
      shopId: quote.shopId,
      currency: quote.currency,
      totalMinor: quote.totalMinor,
      expiresAt,
      reused: false,
    };
  });
}

export function checkoutRequestFingerprint(items: readonly { productId: string; quantity: number }[]): string {
  const normalized = items.map((item) => [item.productId, item.quantity] as const).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
