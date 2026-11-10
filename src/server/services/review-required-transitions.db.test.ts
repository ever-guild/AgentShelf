import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import {
  WEBHOOK_ID,
  createPaymentHarness,
  placeOrder,
  readOrder,
  type PaymentHarness,
} from "../../../test/payments";
import { webhookReceipts } from "../db/schema";
import { reconcileForBuyer, reconcileOrder } from "./payment-reconciliation";
import { getOrderStatus } from "./order-status";
import { handlePayPalWebhook } from "./paypal-webhook";

// Issue #19 diagnosis: which paths take a purchase from cancelled to review_required, and with
// which evidence. review_required alone does not prove a capture exists.
const getDb = setupMigratedDatabase();
let harness: PaymentHarness;
let n = 0;

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  vi.spyOn(console, "error").mockImplementation(() => {});
  harness = createPaymentHarness();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const poolOf = () => (getDb() as unknown as { $client: Pool }).$client;

async function snapshot(orderId: string, shopId: string, productId: string) {
  const pool = poolOf();
  const order = await pool.query<{ payment_status: string; paypal_capture_id: string | null; inventory_reservation_id: string }>(
    "SELECT payment_status, paypal_capture_id, inventory_reservation_id FROM orders WHERE id=$1",
    [orderId],
  );
  const reservation = await pool.query<{ state: string; capture_id: string | null; release_reason: string | null }>(
    "SELECT state, capture_id, release_reason FROM inventory_reservations WHERE id=$1",
    [order.rows[0].inventory_reservation_id],
  );
  const stock = await pool.query<{ on_hand: number; reserved: number }>(
    "SELECT on_hand, reserved FROM inventory_stock WHERE shop_id=$1 AND product_id=$2",
    [shopId, productId],
  );
  const receipts = await getDb().select().from(webhookReceipts).where(eq(webhookReceipts.orderId, orderId));
  return {
    status: order.rows[0].payment_status,
    captureId: order.rows[0].paypal_capture_id,
    reservation: reservation.rows[0],
    stock: { onHand: Number(stock.rows[0].on_hand), reserved: Number(stock.rows[0].reserved) },
    receipts: receipts.map((r) => ({ type: r.eventType, status: r.status })),
  };
}

// Hold expired while PayPal still waits for the buyer: the sweep/return closes it as cancelled.
async function expireAndCancel() {
  const placed = await placeOrder(getDb(), harness);
  await poolOf().query(
    "UPDATE inventory_reservations SET expires_at='2026-11-06T09:00:00Z' WHERE id=(SELECT inventory_reservation_id FROM orders WHERE id=$1)",
    [placed.orderId],
  );
  const closed = await reconcileOrder(getDb(), placed.orderId, harness.deps);
  expect(closed?.paymentStatus).toBe("cancelled");
  return { ...placed, productId: placed.product.id, shopId: placed.shop.id };
}

function approvedWebhook(shopSlug: string, paypalOrderId: string) {
  n += 1;
  const raw = JSON.stringify({
    id: `WH-REVIEW-REQ-${n}`,
    event_type: "CHECKOUT.ORDER.APPROVED",
    resource_type: "checkout-order",
    create_time: "2026-11-10T13:05:00Z",
    resource: { id: paypalOrderId, status: "APPROVED" },
  }, null, 3);
  return handlePayPalWebhook(
    getDb(),
    { shopSlug, rawBody: raw, headers: harness.paypal.signDelivery(WEBHOOK_ID, raw) },
    harness.deps,
  );
}

describe("cancelled to review_required (issue #19)", () => {
  it("expiry-cancel with no later activity stays cancelled, stock restored, nothing captured", async () => {
    const o = await expireAndCancel();
    const s = await snapshot(o.orderId, o.shopId, o.productId);
    expect(s).toMatchObject({
      status: "cancelled",
      captureId: null,
      reservation: { state: "released", capture_id: null, release_reason: "verified_expired_unpaid" },
      stock: { onHand: 100, reserved: 0 },
      receipts: [],
    });
    expect(harness.paypal.captureRequests()).toHaveLength(0);
  });

  it("get_order_status is a stored read: cancelled stays cancelled and PayPal is not asked", async () => {
    const o = await expireAndCancel();
    const reads = harness.paypal.readRequests().length;
    harness.paypal.approve(o.paypalOrderId);

    const status = await getOrderStatus(getDb(), { orderId: o.orderId, statusToken: o.statusToken });

    expect(status.paymentStatus).toBe("cancelled");
    expect(harness.paypal.readRequests()).toHaveLength(reads);
    expect((await readOrder(getDb(), o.orderId)).paymentStatus).toBe("cancelled");
  });

  it("late buyer approval after expiry-cancel, seen by a verified webhook, goes to review WITHOUT a capture", async () => {
    const o = await expireAndCancel();
    harness.paypal.approve(o.paypalOrderId);

    expect(await approvedWebhook(o.shop.slug, o.paypalOrderId)).toBe(200);

    const s = await snapshot(o.orderId, o.shop.id, o.product.id);
    expect(s.status).toBe("review_required");
    expect(s.captureId).toBeNull();
    expect(s.reservation).toMatchObject({ state: "released", capture_id: null });
    expect(s.stock).toEqual({ onHand: 100, reserved: 0 });
    expect(s.receipts).toEqual([{ type: "CHECKOUT.ORDER.APPROVED", status: "processed" }]);
    expect(harness.paypal.captureRequests()).toHaveLength(0);
    expect(harness.paypal.charges()).toBe(0);
  });

  it("the same late approval found through the buyer return is also review WITHOUT a capture", async () => {
    const o = await expireAndCancel();
    harness.paypal.approve(o.paypalOrderId);

    expect(await reconcileForBuyer(getDb(), { orderId: o.orderId, statusToken: o.statusToken }, harness.deps)).toBe(true);

    const s = await snapshot(o.orderId, o.shop.id, o.product.id);
    expect(s).toMatchObject({ status: "review_required", captureId: null, stock: { onHand: 100, reserved: 0 } });
    expect(harness.paypal.charges()).toBe(0);
  });

  it("an unreadable order lookup changes nothing, and the repeated reconciliation then reaches review without a capture", async () => {
    const o = await expireAndCancel();
    harness.paypal.approve(o.paypalOrderId);
    harness.paypal.nextRead({ type: "timeout" });

    await expect(reconcileOrder(getDb(), o.orderId, harness.deps)).rejects.toMatchObject({ code: "PAYMENT_UNAVAILABLE" });
    expect((await readOrder(getDb(), o.orderId)).paymentStatus).toBe("cancelled");

    const second = await reconcileOrder(getDb(), o.orderId, harness.deps);
    expect(second?.paymentStatus).toBe("review_required");
    expect(second?.paypalCaptureId).toBeNull();
    expect(harness.paypal.captureRequests()).toHaveLength(0);
  });

  it("review_required without a capture is not re-read: repeated reconciliation asks PayPal nothing", async () => {
    const o = await expireAndCancel();
    harness.paypal.approve(o.paypalOrderId);
    await reconcileOrder(getDb(), o.orderId, harness.deps);
    const reads = harness.paypal.readRequests().length;

    const again = await reconcileOrder(getDb(), o.orderId, harness.deps);

    expect(again?.paymentStatus).toBe("review_required");
    expect(harness.paypal.readRequests()).toHaveLength(reads);
  });

  it("a capture that completed after the cancel is recorded as evidence and review, never as paid", async () => {
    const o = await expireAndCancel();
    harness.paypal.approve(o.paypalOrderId);
    const paypal = harness.deps.paypalFor("TEST_SHOP", (await readOrder(getDb(), o.orderId)).payeeMerchantId);
    await paypal!.captureOrder({ id: o.paypalOrderId, paypalRequestId: `capture-${o.orderId}`, body: {} });
    const captureId = harness.paypal.captureIdOf(o.paypalOrderId);

    const settled = await reconcileOrder(getDb(), o.orderId, harness.deps);

    expect(settled?.paymentStatus).toBe("review_required");
    const s = await snapshot(o.orderId, o.shop.id, o.product.id);
    expect(s.captureId).toBe(captureId);
    expect(s.reservation).toMatchObject({ state: "review_required", capture_id: captureId });
    expect(harness.confirmed).toEqual([]);
    // Not asserted here: whether the unit stays sellable. See the separate red candidate.
  });
});
