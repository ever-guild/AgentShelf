import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTemporaryDatabase } from "../../../test/database";
import { createProduct, createService, createShop } from "../../../test/fixtures";
import { quoteCheckout } from "../services/checkout-quote";
import { createDb, type Db } from "../db/client";
import { runMigrations } from "../db/migrate";
import { createSellerInventoryAdapter } from "./seller-adapter";
import { beginPhysicalOrderCapture, checkoutRequestFingerprint, createReservedPhysicalOrder, settlePhysicalOrderCapture } from "./physical-orders";

const actorId = "00000000-0000-4000-8000-000000000099";
let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;
let connection: ReturnType<typeof createDb>;
let db: Db;
let pool: Pool;
let stocks: ReturnType<typeof createSellerInventoryAdapter>;
let shopId = "";
let productId = "";

describe("physical order inventory adapter", () => {
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    await runMigrations(temporary.url);
    connection = createDb(temporary.url);
    db = connection.db;
    pool = new Pool({ connectionString: temporary.url });
    stocks = createSellerInventoryAdapter(pool);
  });

  beforeEach(async () => {
    const shop = await createShop(db);
    shopId = shop.id;
    const product = await createProduct(db, shopId);
    productId = product.id;
  });

  afterAll(async () => {
    await pool?.end();
    await connection?.close();
    await temporary?.drop();
  });

  async function prepare(onHand: number) {
    await stocks.setMode({ shopId, actorId }, {
      productId,
      mode: "tracked",
      onHand,
      idempotencyKey: "initial-stock-decision-01",
      reason: "Initial physical stock count",
    });
  }

  it("atomically stores order lines and an idempotent stock reservation", async () => {
    await prepare(2);
    const key = "physical-order-idempotency-01";
    const items = [{ productId, quantity: 1 }];
    const fingerprint = checkoutRequestFingerprint(items);
    const quote = await quoteCheckout(db, { items, idempotencyKey: key });
    const input = { quote, idempotencyKey: key, requestFingerprint: fingerprint, expiresAt: new Date(Date.now() + 60_000) };
    const [first, retry] = await Promise.all([
      createReservedPhysicalOrder(pool, input),
      createReservedPhysicalOrder(pool, input),
    ]);

    expect(first.orderId).toBe(retry.orderId);
    expect(first.reservationId).toBe(retry.reservationId);
    expect([first.reused, retry.reused].sort()).toEqual([false, true]);
    const captureClaims = await Promise.all([
      beginPhysicalOrderCapture(pool, first.orderId),
      beginPhysicalOrderCapture(pool, first.orderId),
    ]);
    expect(captureClaims.filter((claim) => claim.allowed)).toHaveLength(1);
    expect(captureClaims.filter((claim) => !claim.allowed)).toEqual([{ allowed: false, reason: "already_started" }]);
    await pool.query("UPDATE inventory_reservations SET expires_at=now()-interval '1 second' WHERE id=$1", [first.reservationId]);
    await expect(beginPhysicalOrderCapture(pool, first.orderId)).resolves.toMatchObject({ allowed: false, reason: "already_started" });
    const lateProof = { captureId: "physical-capture-late-0001", providerStatus: "COMPLETED" as const, capturedAt: new Date(), verified: true as const };
    await expect(settlePhysicalOrderCapture(pool, first.orderId, lateProof)).resolves.toBe("review_required");
    await expect(settlePhysicalOrderCapture(pool, first.orderId, lateProof)).resolves.toBe("review_required");
    await expect(settlePhysicalOrderCapture(pool, first.orderId, { ...lateProof, captureId: "physical-capture-other-0001" })).resolves.toBe("review_required");
    expect(await stocks.read({ shopId, actorId }, productId)).toMatchObject({ onHand: 2, reserved: 1, available: 1 });
    const payment = await pool.query<{ payment_status: string; paypal_capture_id: string }>("SELECT payment_status, paypal_capture_id FROM orders WHERE id=$1", [first.orderId]);
    expect(payment.rows[0]).toEqual({ payment_status: "review_required", paypal_capture_id: lateProof.captureId });
    const order = await pool.query<{ inventory_reservation_id: string; line_count: string }>(
      `SELECT o.inventory_reservation_id, count(l.id)::text AS line_count
       FROM orders o JOIN order_lines l ON l.order_id=o.id WHERE o.id=$1 GROUP BY o.inventory_reservation_id`,
      [first.orderId],
    );
    expect(order.rows).toEqual([{ inventory_reservation_id: first.reservationId, line_count: "1" }]);
    await expect(createReservedPhysicalOrder(pool, { ...input, requestFingerprint: "f".repeat(64) })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rolls back order rows when stock is insufficient and excludes service inventory", async () => {
    await prepare(0);
    const items = [{ productId, quantity: 1 }];
    const key = "physical-order-no-stock-01";
    const quote = await quoteCheckout(db, { items, idempotencyKey: key });
    await expect(createReservedPhysicalOrder(pool, {
      quote,
      idempotencyKey: key,
      requestFingerprint: checkoutRequestFingerprint(items),
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toMatchObject({ code: "INSUFFICIENT" });
    expect((await pool.query("SELECT id FROM orders WHERE idempotency_key=$1", [key])).rowCount).toBe(0);
    expect(await stocks.read({ shopId, actorId }, productId)).toMatchObject({ reserved: 0, available: 0 });

    const service = await createService(db, shopId);
    const serviceKey = "physical-order-service-01";
    await expect(quoteCheckout(db, { items: [{ productId: service.id, quantity: 1 }], idempotencyKey: serviceKey })).rejects.toMatchObject({ code: "PRODUCT_REQUIRES_BOOKING" });
  });
});
