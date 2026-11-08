import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTemporaryDatabase } from "../../../test/database";
import { createProduct, createShop } from "../../../test/fixtures";
import { createPaymentHarness } from "../../../test/payments";
import { createDb, type Db } from "../db/client";
import { runMigrations } from "../db/migrate";
import { createCheckout } from "./checkout";
import { createSellerInventoryAdapter } from "../inventory/seller-adapter";
import { beginPhysicalOrderCapture, closePhysicalOrderAfterVerifiedUnpaid } from "../inventory/physical-orders";
import { reconcileOrder } from "./payment-reconciliation";

let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;
let connection: ReturnType<typeof createDb>;
let db: Db;
let pool: Pool;
let harness: ReturnType<typeof createPaymentHarness>;
let productId = "";
let shopId = "";

describe("physical inventory payment reconciliation", () => {
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    await runMigrations(temporary.url);
    connection = createDb(temporary.url);
    db = connection.db;
    pool = new Pool({ connectionString: temporary.url });
  });

  beforeEach(async () => {
    process.env.APP_ORIGIN = "https://shop.example";
    harness = createPaymentHarness();
    const shop = await createShop(db);
    shopId = shop.id;
    const product = await createProduct(db, shop.id, { priceMinor: 990 });
    productId = product.id;
    await createSellerInventoryAdapter(pool).setMode(
      { actorId: "00000000-0000-4000-8000-000000000099", shopId },
      {
        productId,
        mode: "tracked",
        onHand: 1,
        idempotencyKey: "reconcile-stock-count-01",
        reason: "Initial stock for payment test",
      },
    );
  });

  afterAll(async () => {
    await pool?.end();
    await connection?.close();
    await temporary?.drop();
  });

  async function place() {
    const checkout = await createCheckout(db, {
      items: [{ productId, quantity: 1 }],
      idempotencyKey: randomUUID(),
    }, harness.deps);
    const result = await pool.query<{ paypal_order_id: string; id: string; inventory_reservation_id: string; payee_merchant_id: string }>(
      "SELECT id, paypal_order_id, inventory_reservation_id, payee_merchant_id FROM orders WHERE id=$1",
      [checkout.orderId],
    );
    return { orderId: result.rows[0].id, paypalOrderId: result.rows[0].paypal_order_id, reservationId: result.rows[0].inventory_reservation_id, merchantId: result.rows[0].payee_merchant_id };
  }

  it("does not capture an approved PayPal order after its stock hold expires", async () => {
    const order = await place();
    await pool.query("UPDATE inventory_reservations SET expires_at='2026-11-06T09:00:00Z' WHERE id=$1", [order.reservationId]);
    harness.paypal.approve(order.paypalOrderId);

    const settled = await reconcileOrder(db, order.orderId, harness.deps);

    expect(settled?.paymentStatus).toBe("cancelled");
    expect(harness.paypal.captureRequests()).toHaveLength(0);
    expect(await createSellerInventoryAdapter(pool).read({ actorId: "00000000-0000-4000-8000-000000000099", shopId }, productId)).toMatchObject({ onHand: 1, reserved: 0, available: 1 });
  });

  it("retries an ambiguous capture with the same PayPal request ID while its allocation is live", async () => {
    const order = await place();
    harness.paypal.approve(order.paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: false });

    await expect(reconcileOrder(db, order.orderId, harness.deps)).rejects.toMatchObject({ code: "PAYMENT_UNAVAILABLE" });
    expect(harness.paypal.captureRequests()).toHaveLength(1);
    expect(await createSellerInventoryAdapter(pool).read({ actorId: "00000000-0000-4000-8000-000000000099", shopId }, productId)).toMatchObject({ onHand: 1, reserved: 1, available: 0 });

    const settled = await reconcileOrder(db, order.orderId, harness.deps);

    const captureRequests = harness.paypal.captureRequests();
    expect(settled?.paymentStatus).toBe("paid");
    expect(captureRequests).toHaveLength(2);
    expect(captureRequests.map((request) => harness.paypal.requestIdOf(request))).toEqual([
      `capture-${order.orderId}`,
      `capture-${order.orderId}`,
    ]);
    expect(harness.paypal.charges()).toBe(1);
    expect(await createSellerInventoryAdapter(pool).read({ actorId: "00000000-0000-4000-8000-000000000099", shopId }, productId)).toMatchObject({ onHand: 0, reserved: 0, available: 0 });
  });

  it("keeps an ambiguous capture held for review after its allocation expires", async () => {
    const order = await place();
    harness.paypal.approve(order.paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: false });

    await expect(reconcileOrder(db, order.orderId, harness.deps)).rejects.toMatchObject({ code: "PAYMENT_UNAVAILABLE" });
    expect(harness.paypal.captureRequests()).toHaveLength(1);
    await pool.query("UPDATE inventory_reservations SET expires_at='2026-11-06T09:00:00Z' WHERE id=$1", [order.reservationId]);

    const retried = await reconcileOrder(db, order.orderId, harness.deps);

    expect(retried?.paymentStatus).toBe("review_required");
    expect(harness.paypal.captureRequests()).toHaveLength(1);
    expect(await createSellerInventoryAdapter(pool).read({ actorId: "00000000-0000-4000-8000-000000000099", shopId }, productId)).toMatchObject({ onHand: 1, reserved: 1, available: 0 });
    const reservation = await pool.query<{ state: string }>("SELECT state FROM inventory_reservations WHERE id=$1", [order.reservationId]);
    expect(reservation.rows[0].state).toBe("capture_pending");

    const paypal = harness.deps.paypalFor("TEST_SHOP", order.merchantId);
    await paypal!.captureOrder({ id: order.paypalOrderId, paypalRequestId: `capture-${order.orderId}`, body: {} });
    const lateCaptureId = harness.paypal.captureIdOf(order.paypalOrderId);

    const lateResult = await reconcileOrder(db, order.orderId, harness.deps);

    expect(lateResult?.paymentStatus).toBe("review_required");
    expect(harness.paypal.captureRequests()).toHaveLength(2);
    expect(await createSellerInventoryAdapter(pool).read({ actorId: "00000000-0000-4000-8000-000000000099", shopId }, productId)).toMatchObject({ onHand: 1, reserved: 1, available: 0 });
    const lateReservation = await pool.query<{ state: string; capture_id: string | null }>("SELECT state, capture_id FROM inventory_reservations WHERE id=$1", [order.reservationId]);
    expect(lateReservation.rows[0]).toEqual({ state: "review_required", capture_id: lateCaptureId });
    const lateOrder = await pool.query<{ payment_status: string; paypal_capture_id: string | null }>("SELECT payment_status, paypal_capture_id FROM orders WHERE id=$1", [order.orderId]);
    expect(lateOrder.rows[0]).toEqual({ payment_status: "review_required", paypal_capture_id: lateCaptureId });
  });

  it("releases stock when PayPal confirms a buyer-cancelled purchase is still unpaid", async () => {
    const order = await place();

    const cancelled = await reconcileOrder(db, order.orderId, harness.deps, { buyerCancelled: true });

    expect(cancelled?.paymentStatus).toBe("cancelled");
    expect(harness.paypal.captureRequests()).toHaveLength(0);
    expect(await createSellerInventoryAdapter(pool).read({ actorId: "00000000-0000-4000-8000-000000000099", shopId }, productId)).toMatchObject({ onHand: 1, reserved: 0, available: 1 });
    const reservation = await pool.query<{ state: string; release_reason: string }>("SELECT state, release_reason FROM inventory_reservations WHERE id=$1", [order.reservationId]);
    expect(reservation.rows[0]).toEqual({ state: "released", release_reason: "verified_cancelled" });
  });

  it("does not release an ambiguous capture when a buyer returns through the cancel link", async () => {
    const order = await place();
    await expect(beginPhysicalOrderCapture(pool, order.orderId)).resolves.toMatchObject({ allowed: true });

    const unchanged = await reconcileOrder(db, order.orderId, harness.deps, { buyerCancelled: true });

    expect(unchanged?.paymentStatus).toBe("pending");
    expect(harness.paypal.captureRequests()).toHaveLength(0);
    expect(await createSellerInventoryAdapter(pool).read({ actorId: "00000000-0000-4000-8000-000000000099", shopId }, productId)).toMatchObject({ onHand: 1, reserved: 1, available: 0 });
    const reservation = await pool.query<{ state: string }>("SELECT state FROM inventory_reservations WHERE id=$1", [order.reservationId]);
    expect(reservation.rows[0].state).toBe("capture_pending");
  });

  it("sends an approved legacy purchase without an allocation to review without capturing", async () => {
    const order = await place();
    expect(await closePhysicalOrderAfterVerifiedUnpaid(pool, order.orderId, "verified_unpaid", "failed")).toBe(true);
    await pool.query("UPDATE orders SET inventory_reservation_id=NULL, payment_status='pending' WHERE id=$1", [order.orderId]);
    harness.paypal.approve(order.paypalOrderId);

    const reviewed = await reconcileOrder(db, order.orderId, harness.deps);

    expect(reviewed?.paymentStatus).toBe("review_required");
    expect(harness.paypal.captureRequests()).toHaveLength(0);
    expect(harness.paypal.charges()).toBe(0);
    expect(await createSellerInventoryAdapter(pool).read({ actorId: "00000000-0000-4000-8000-000000000099", shopId }, productId)).toMatchObject({ onHand: 1, reserved: 0, available: 1 });
  });

  it("records a late completed capture for review without overselling or replacing capture evidence", async () => {
    const order = await place();
    await expect(beginPhysicalOrderCapture(pool, order.orderId)).resolves.toMatchObject({ allowed: true });
    await pool.query("UPDATE inventory_reservations SET expires_at='2026-11-06T09:00:00Z' WHERE id=$1", [order.reservationId]);
    harness.paypal.approve(order.paypalOrderId);
    const paypal = harness.deps.paypalFor("TEST_SHOP", order.merchantId);
    // This simulates the provider completing a capture that was already in flight when its hold expired.
    await paypal!.captureOrder({ id: order.paypalOrderId, paypalRequestId: `capture-${order.orderId}`, body: {} });

    const settled = await reconcileOrder(db, order.orderId, harness.deps);
    const stock = await createSellerInventoryAdapter(pool).read({ actorId: "00000000-0000-4000-8000-000000000099", shopId }, productId);
    const saved = await pool.query<{ state: string; capture_id: string | null }>("SELECT state, capture_id FROM inventory_reservations WHERE id=$1", [order.reservationId]);
    const payment = await pool.query<{ payment_status: string; paypal_capture_id: string | null }>("SELECT payment_status, paypal_capture_id FROM orders WHERE id=$1", [order.orderId]);

    expect(settled?.paymentStatus).toBe("review_required");
    expect(stock).toMatchObject({ onHand: 1, reserved: 1, available: 0 });
    expect(saved.rows[0]).toMatchObject({ state: "review_required", capture_id: expect.any(String) });
    expect(payment.rows[0]).toMatchObject({ payment_status: "review_required", paypal_capture_id: saved.rows[0].capture_id });
  });
});
