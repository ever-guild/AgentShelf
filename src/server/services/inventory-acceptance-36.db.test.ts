import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTemporaryDatabase } from "../../../test/database";
import { createProduct, createShop } from "../../../test/fixtures";
import { createPaymentHarness } from "../../../test/payments";
import { createDb, type Db } from "../db/client";
import { runMigrations } from "../db/migrate";
import { createSellerInventoryAdapter } from "../inventory/seller-adapter";
import { createCheckout } from "./checkout";
import { reconcileOrder } from "./payment-reconciliation";

// Independent acceptance checks for #36 findings 2, 3 and 5. Each case asserts the order row, the
// reservation row and the stock level together, against the fake PayPal provider.
const actorId = "00000000-0000-4000-8000-000000000099";
let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;
let connection: ReturnType<typeof createDb>;
let db: Db;
let pool: Pool;
let harness: ReturnType<typeof createPaymentHarness>;
let productId = "";
let shopId = "";

async function place() {
  const checkout = await createCheckout(db, { items: [{ productId, quantity: 1 }], idempotencyKey: randomUUID() }, harness.deps);
  const result = await pool.query<{ id: string; paypal_order_id: string; inventory_reservation_id: string }>(
    "SELECT id, paypal_order_id, inventory_reservation_id FROM orders WHERE id=$1",
    [checkout.orderId],
  );
  return { orderId: result.rows[0].id, paypalOrderId: result.rows[0].paypal_order_id, reservationId: result.rows[0].inventory_reservation_id };
}

async function state(orderId: string, reservationId: string) {
  const order = await pool.query<{ payment_status: string }>("SELECT payment_status FROM orders WHERE id=$1", [orderId]);
  const reservation = await pool.query<{ state: string }>("SELECT state FROM inventory_reservations WHERE id=$1", [reservationId]);
  const stock = await createSellerInventoryAdapter(pool).read({ actorId, shopId }, productId);
  return {
    order: order.rows[0].payment_status,
    reservation: reservation.rows[0].state,
    stock: { onHand: stock.onHand, reserved: stock.reserved, available: stock.available },
  };
}

describe("#36 acceptance: purchase reconciliation keeps order, reservation and stock consistent", () => {
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
    await createSellerInventoryAdapter(pool).setMode({ actorId, shopId }, {
      productId, mode: "tracked", onHand: 1, idempotencyKey: `acceptance-36-${randomUUID()}`, reason: "Acceptance stock",
    });
  });

  afterAll(async () => {
    await pool?.end();
    await connection?.close();
    await temporary?.drop();
  });

  it("F3: concurrent retries after a lost capture response charge once and commit stock once", async () => {
    const order = await place();
    harness.paypal.approve(order.paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: false });
    await expect(reconcileOrder(db, order.orderId, harness.deps)).rejects.toMatchObject({ code: "PAYMENT_UNAVAILABLE" });

    const results = await Promise.allSettled([
      reconcileOrder(db, order.orderId, harness.deps),
      reconcileOrder(db, order.orderId, harness.deps),
      reconcileOrder(db, order.orderId, harness.deps),
    ]);

    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(harness.paypal.charges()).toBe(1);
    expect(new Set(harness.paypal.captureRequests().map((request) => harness.paypal.requestIdOf(request)))).toEqual(new Set([`capture-${order.orderId}`]));
    expect(await state(order.orderId, order.reservationId)).toEqual({ order: "paid", reservation: "committed", stock: { onHand: 0, reserved: 0, available: 0 } });
  });

  it.each([
    {
      status: 409,
      name: "RESOURCE_CONFLICT",
      issues: ["PREVIOUS_REQUEST_IN_PROGRESS"],
      readAfterConflict: "APPROVED",
    },
    {
      status: 422,
      name: "UNPROCESSABLE_ENTITY",
      issues: ["PREVIOUS_REQUEST_IN_PROGRESS"],
      readAfterConflict: "APPROVED",
    },
    {
      status: 422,
      name: "RESOURCE_CONFLICT",
      issues: [],
      readAfterConflict: "VOIDED",
    },
  ])(
    "F3: same-ID retry conflict $status/$name keeps the allocation when a capture may still be running",
    async ({ status, name, issues, readAfterConflict }) => {
      const order = await place();
      harness.paypal.approve(order.paypalOrderId);
      harness.paypal.nextCapture({ type: "timeout", captured: false });
      await expect(reconcileOrder(db, order.orderId, harness.deps)).rejects.toMatchObject({ code: "PAYMENT_UNAVAILABLE" });

      harness.paypal.nextCapture({
        type: "respond",
        status,
        body: {
          name,
          message: "A previous request on this resource is currently in progress.",
          details: issues.map((issue) => ({ issue })),
        },
      });
      if (readAfterConflict === "VOIDED") {
        // The order read can lag an in-progress capture; it must not turn the conflict into
        // verified-unpaid evidence that releases the reservation.
        harness.paypal.nextRead({ type: "change", change: (paypalOrder) => paypalOrder });
        harness.paypal.nextRead({
          type: "change",
          change: (paypalOrder) => ({ ...paypalOrder, status: "VOIDED" }),
        });
      }
      await expect(reconcileOrder(db, order.orderId, harness.deps)).rejects.toMatchObject({ code: "PAYMENT_UNAVAILABLE" });

      // The first request may still complete at PayPal, so the allocation must remain held.
      expect(await state(order.orderId, order.reservationId)).toEqual({
        order: "approved", reservation: "capture_pending", stock: { onHand: 1, reserved: 1, available: 0 },
      });

      const settled = await reconcileOrder(db, order.orderId, harness.deps);
      expect(settled?.paymentStatus).toBe("paid");
      expect(harness.paypal.charges()).toBe(1);
      expect(await state(order.orderId, order.reservationId)).toEqual({ order: "paid", reservation: "committed", stock: { onHand: 0, reserved: 0, available: 0 } });
    },
  );

  it("F2: repeated buyer cancellations release the hold exactly once", async () => {
    const order = await place();

    await reconcileOrder(db, order.orderId, harness.deps, { buyerCancelled: true });
    await Promise.all([
      reconcileOrder(db, order.orderId, harness.deps, { buyerCancelled: true }),
      reconcileOrder(db, order.orderId, harness.deps, { buyerCancelled: true }),
    ]);

    expect(harness.paypal.captureRequests()).toHaveLength(0);
    expect(await state(order.orderId, order.reservationId)).toEqual({ order: "cancelled", reservation: "released", stock: { onHand: 1, reserved: 0, available: 1 } });
  });

  it("F2/F3: a cancel return racing a live capture never releases the in-flight allocation", async () => {
    const order = await place();
    harness.paypal.approve(order.paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: true });

    await Promise.allSettled([
      reconcileOrder(db, order.orderId, harness.deps),
      reconcileOrder(db, order.orderId, harness.deps, { buyerCancelled: true }),
    ]);
    await reconcileOrder(db, order.orderId, harness.deps).catch(() => undefined);

    expect(harness.paypal.charges()).toBe(1);
    expect(await state(order.orderId, order.reservationId)).toEqual({ order: "paid", reservation: "committed", stock: { onHand: 0, reserved: 0, available: 0 } });
  });
});
