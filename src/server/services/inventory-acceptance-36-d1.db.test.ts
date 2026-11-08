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

// Independent acceptance of the #36 D1 fix: a same-ID capture conflict must keep the unit away
// from a second buyer, and the in-flight capture that later completes is settled exactly once.
const actorId = "00000000-0000-4000-8000-000000000099";
let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;
let connection: ReturnType<typeof createDb>;
let db: Db;
let pool: Pool;
let harness: ReturnType<typeof createPaymentHarness>;
let productId = "";
let shopId = "";

const checkout = () => createCheckout(db, { items: [{ productId, quantity: 1 }], idempotencyKey: randomUUID() }, harness.deps);

async function state(orderId: string) {
  const order = await pool.query<{ payment_status: string; paypal_capture_id: string | null; inventory_reservation_id: string }>(
    "SELECT payment_status, paypal_capture_id, inventory_reservation_id FROM orders WHERE id=$1",
    [orderId],
  );
  const reservation = await pool.query<{ state: string; capture_id: string | null }>(
    "SELECT state, capture_id FROM inventory_reservations WHERE id=$1",
    [order.rows[0].inventory_reservation_id],
  );
  const stock = await createSellerInventoryAdapter(pool).read({ actorId, shopId }, productId);
  return {
    order: order.rows[0].payment_status,
    orderCapture: order.rows[0].paypal_capture_id,
    reservation: reservation.rows[0].state,
    reservationCapture: reservation.rows[0].capture_id,
    stock: { onHand: stock.onHand, reserved: stock.reserved, available: stock.available, version: stock.version },
  };
}

describe("#36 D1 acceptance: in-progress capture conflicts", () => {
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
    productId = (await createProduct(db, shop.id, { priceMinor: 990 })).id;
    await createSellerInventoryAdapter(pool).setMode({ actorId, shopId }, {
      productId, mode: "tracked", onHand: 1, idempotencyKey: `acceptance-d1-${randomUUID()}`, reason: "Acceptance stock",
    });
  });

  afterAll(async () => {
    await pool?.end();
    await connection?.close();
    await temporary?.drop();
  });

  it.each([
    { status: 409, name: "RESOURCE_CONFLICT", issues: [] as string[] },
    { status: 422, name: "RESOURCE_CONFLICT", issues: [] as string[] },
    { status: 422, name: "UNPROCESSABLE_ENTITY", issues: ["PREVIOUS_REQUEST_IN_PROGRESS"] },
  ])("$status/$name: no second buyer gets the unit and the late capture settles once", async ({ status, name, issues }) => {
    const first = await checkout();
    const paypalOrderId = (await pool.query<{ paypal_order_id: string; payee_merchant_id: string }>(
      "SELECT paypal_order_id, payee_merchant_id FROM orders WHERE id=$1", [first.orderId],
    )).rows[0];
    harness.paypal.approve(paypalOrderId.paypal_order_id);
    harness.paypal.nextCapture({ type: "timeout", captured: false });
    await expect(reconcileOrder(db, first.orderId, harness.deps)).rejects.toMatchObject({ code: "PAYMENT_UNAVAILABLE" });
    harness.paypal.nextCapture({ type: "respond", status, body: { name, message: "In progress", details: issues.map((issue) => ({ issue })) } });
    await expect(reconcileOrder(db, first.orderId, harness.deps)).rejects.toMatchObject({ code: "PAYMENT_UNAVAILABLE" });

    // The unit stays allocated to the first buyer.
    await expect(checkout()).rejects.toMatchObject({ code: "PRODUCT_UNAVAILABLE" });
    expect(await state(first.orderId)).toMatchObject({
      order: "approved", reservation: "capture_pending", stock: { onHand: 1, reserved: 1, available: 0 },
    });

    // The earlier same-ID request completes at PayPal; webhook, buyer return and sweep all reconcile.
    await harness.deps.paypalFor("TEST_SHOP", paypalOrderId.payee_merchant_id)!.captureOrder({
      id: paypalOrderId.paypal_order_id, paypalRequestId: `capture-${first.orderId}`, body: {},
    });
    const captureId = harness.paypal.captureIdOf(paypalOrderId.paypal_order_id);
    await Promise.all([
      reconcileOrder(db, first.orderId, harness.deps),
      reconcileOrder(db, first.orderId, harness.deps),
    ]);
    await reconcileOrder(db, first.orderId, harness.deps);

    expect(harness.paypal.charges()).toBe(1);
    expect(harness.confirmed).toEqual([first.orderId]);
    expect(await state(first.orderId)).toEqual({
      order: "paid", orderCapture: captureId, reservation: "committed", reservationCapture: captureId,
      // Version 0 -> 1 on reservation -> 2 on the single commit.
      stock: { onHand: 0, reserved: 0, available: 0, version: 2 },
    });
  });
});
