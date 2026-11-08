import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import {
  createOrder,
  createProduct,
  createShop,
  setTestTrackedStock,
} from "../../../test/fixtures";
import {
  createPaymentHarness,
  placeOrder,
  readOrder,
  type PaymentHarness,
} from "../../../test/payments";
import { inventoryReservations, inventoryStock, orders } from "../db/schema";
import { createCheckout } from "./checkout";
import { sweepOpenOrders } from "./order-sweep";

const getDb = setupMigratedDatabase();

let harness: PaymentHarness;

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  vi.spyOn(console, "error").mockImplementation(() => {});
  harness = createPaymentHarness();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const sweep = (batch?: number) => sweepOpenOrders(getDb(), harness.deps, batch);

function age(orderId: string, createdAgo: string, checkedAgo?: string) {
  return getDb()
    .update(orders)
    .set({
      createdAt: sql`now() - ${createdAgo}::interval`,
      lastCheckedAt: checkedAgo ? sql`now() - ${checkedAgo}::interval` : null,
    })
    .where(eq(orders.id, orderId));
}

describe("sweepOpenOrders", () => {
  it("releases an expired physical reservation only after PayPal verifies it is unpaid", async () => {
    const { orderId, product } = await placeOrder(getDb(), harness);
    const order = await readOrder(getDb(), orderId);
    await getDb()
      .update(inventoryReservations)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(inventoryReservations.id, order.inventoryReservationId!));
    await age(orderId, "73 hours");

    await sweep();

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("cancelled");
    const [reservation] = await getDb()
      .select({ state: inventoryReservations.state, releaseReason: inventoryReservations.releaseReason })
      .from(inventoryReservations)
      .where(eq(inventoryReservations.id, order.inventoryReservationId!));
    const [stock] = await getDb()
      .select({ onHand: inventoryStock.onHand, reserved: inventoryStock.reserved })
      .from(inventoryStock)
      .where(eq(inventoryStock.productId, product.id));
    expect(reservation).toMatchObject({ state: "released", releaseReason: "verified_expired_unpaid" });
    expect(stock).toMatchObject({ onHand: 100, reserved: 0 });
    expect(harness.paypal.charges()).toBe(0);
  });

  it("keeps an expired physical reservation held when PayPal cannot resolve the order", async () => {
    const { orderId, product } = await placeOrder(getDb(), harness);
    const order = await readOrder(getDb(), orderId);
    await getDb()
      .update(inventoryReservations)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(inventoryReservations.id, order.inventoryReservationId!));
    await age(orderId, "73 hours");
    harness.paypal.nextRead({ type: "timeout" });

    await sweep();

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("review_required");
    const [reservation] = await getDb()
      .select({ state: inventoryReservations.state })
      .from(inventoryReservations)
      .where(eq(inventoryReservations.id, order.inventoryReservationId!));
    const [stock] = await getDb()
      .select({ onHand: inventoryStock.onHand, reserved: inventoryStock.reserved })
      .from(inventoryStock)
      .where(eq(inventoryStock.productId, product.id));
    expect(reservation.state).toBe("reserved");
    expect(stock).toMatchObject({ onHand: 100, reserved: 1 });
    expect(harness.paypal.charges()).toBe(0);
  });

  it("captures for a buyer who approved and never came back", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    await age(orderId, "10 minutes");

    expect(await sweep()).toBe(1);

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
    expect(harness.paypal.charges()).toBe(1);
    expect(harness.confirmed).toEqual([orderId]);
  });

  it("retries an ambiguous capture with the same key after PayPal confirms approval", async () => {
    const { orderId, paypalOrderId, product } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: false });
    await age(orderId, "10 minutes");
    await sweep();
    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("approved");
    expect(harness.paypal.captureRequests()).toHaveLength(1);
    expect(harness.paypal.charges()).toBe(0);

    await age(orderId, "20 minutes", "10 minutes");
    await sweep();

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
    const captureRequests = harness.paypal.captureRequests();
    expect(captureRequests).toHaveLength(2);
    expect(captureRequests.map(harness.paypal.requestIdOf)).toEqual([
      `capture-${orderId}`,
      `capture-${orderId}`,
    ]);
    expect(harness.paypal.charges()).toBe(1);
    const [reservation] = await getDb()
      .select({ state: inventoryReservations.state })
      .from(inventoryReservations)
      .where(eq(inventoryReservations.id, (await readOrder(getDb(), orderId)).inventoryReservationId!));
    const [stock] = await getDb()
      .select({ onHand: inventoryStock.onHand, reserved: inventoryStock.reserved })
      .from(inventoryStock)
      .where(eq(inventoryStock.productId, product.id));
    expect(reservation.state).toBe("committed");
    expect(stock).toMatchObject({ onHand: 99, reserved: 0 });
  });

  it("keeps stock held when the same-key capture retry remains ambiguous", async () => {
    const { orderId, paypalOrderId, product } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: false });
    await age(orderId, "10 minutes");
    await sweep();

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("approved");
    expect(harness.paypal.captureRequests()).toHaveLength(1);
    expect(harness.paypal.charges()).toBe(0);

    harness.paypal.nextCapture({ type: "timeout", captured: false });
    await age(orderId, "20 minutes", "10 minutes");
    await sweep();

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("approved");
    const captureRequests = harness.paypal.captureRequests();
    expect(captureRequests).toHaveLength(2);
    expect(captureRequests.map(harness.paypal.requestIdOf)).toEqual([
      `capture-${orderId}`,
      `capture-${orderId}`,
    ]);
    expect(harness.paypal.charges()).toBe(0);
    const order = await readOrder(getDb(), orderId);
    const [reservation] = await getDb()
      .select({ state: inventoryReservations.state })
      .from(inventoryReservations)
      .where(eq(inventoryReservations.id, order.inventoryReservationId!));
    const [stock] = await getDb()
      .select({ onHand: inventoryStock.onHand, reserved: inventoryStock.reserved })
      .from(inventoryStock)
      .where(eq(inventoryStock.productId, product.id));
    expect(reservation.state).toBe("capture_pending");
    expect(stock).toMatchObject({ onHand: 100, reserved: 1 });
  });

  it("settles a verified completed capture after its response was lost", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: true });
    await age(orderId, "10 minutes");
    await sweep();

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
    expect(harness.paypal.charges()).toBe(1);
    expect(harness.paypal.captureRequests()).toHaveLength(1);
    expect(harness.confirmed).toEqual([orderId]);

    await age(orderId, "20 minutes", "10 minutes");
    expect(await sweep()).toBe(0);
    expect(harness.paypal.captureRequests()).toHaveLength(1);
    expect(harness.confirmed).toEqual([orderId]);
  });

  it("leaves a new order alone while it is in the buyer's hands", async () => {
    await placeOrder(getDb(), harness);

    expect(await sweep()).toBe(0);

    expect(harness.paypal.readRequests()).toHaveLength(0);
  });

  it("asks less often as an order ages", async () => {
    const { orderId } = await placeOrder(getDb(), harness);

    await age(orderId, "30 minutes", "4 minutes");
    expect(await sweep()).toBe(0);
    await age(orderId, "30 minutes", "6 minutes");
    expect(await sweep()).toBe(1);

    // One day old: an interval of two hours, not five minutes.
    await age(orderId, "24 hours", "1 hour");
    expect(await sweep()).toBe(0);
    await age(orderId, "24 hours", "3 hours");
    expect(await sweep()).toBe(1);
  });

  it("does not look at the same order twice in a row", async () => {
    const { orderId } = await placeOrder(getDb(), harness);
    await age(orderId, "10 minutes");

    expect(await sweep()).toBe(1);
    expect(await sweep()).toBe(0);
  });

  it("looks at a bounded batch, oldest check first", async () => {
    const placed: Awaited<ReturnType<typeof placeOrder>>[] = [];
    for (let index = 0; index < 3; index += 1) {
      placed.push(
        await placeOrder(getDb(), harness, {
          paypalMerchantId: `SWEEPMERCHANT${index}`,
        }),
      );
    }
    await age(placed[0].orderId, "1 hour", "30 minutes");
    await age(placed[1].orderId, "1 hour");
    await age(placed[2].orderId, "1 hour", "40 minutes");

    expect(await sweep(2)).toBe(2);

    const checkedAfter = async (index: number) =>
      (await readOrder(getDb(), placed[index].orderId)).lastCheckedAt;
    const [first, second, third] = await Promise.all([
      checkedAfter(0),
      checkedAfter(1),
      checkedAfter(2),
    ]);
    const recent = (date: Date | null) =>
      date !== null && Date.now() - date.getTime() < 60_000;
    expect([recent(first), recent(second), recent(third)]).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("keeps going when one order cannot be settled", async () => {
    const first = await placeOrder(getDb(), harness);
    const second = await placeOrder(getDb(), harness, {
      paypalMerchantId: "OTHERMERCHANT1",
    });
    harness.paypal.approve(second.paypalOrderId);
    await age(first.orderId, "10 minutes", "9 minutes");
    await age(second.orderId, "10 minutes", "8 minutes");
    harness.paypal.nextRead({ type: "timeout" });

    expect(await sweep()).toBe(2);

    expect((await readOrder(getDb(), second.orderId)).paymentStatus).toBe("paid");
  });

  it("does not touch settled orders", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    await age(orderId, "10 minutes");
    await sweep();
    const reads = harness.paypal.readRequests().length;
    await age(orderId, "1 hour", "1 hour");

    for (const paymentStatus of [
      "paid",
      "failed",
      "cancelled",
      "review_required",
    ] as const) {
      await getDb().update(orders).set({ paymentStatus });
      expect(await sweep()).toBe(0);
    }

    expect(harness.paypal.readRequests()).toHaveLength(reads);
  });

  it("does not change an order's public updatedAt just by checking it", async () => {
    const { orderId } = await placeOrder(getDb(), harness);
    await age(orderId, "10 minutes");
    const { updatedAt } = await readOrder(getDb(), orderId);

    await sweep();

    const after = await readOrder(getDb(), orderId);
    expect(after.lastCheckedAt).not.toBeNull();
    expect(after.updatedAt).toEqual(updatedAt);
  });
});

describe("after three days", () => {
  it("fails an unpaid booking deposit nobody approved", async () => {
    const shop = await createShop(getDb());
    const orderId = (await createOrder(getDb(), shop.id, { kind: "booking_deposit" })).id;
    await age(orderId, "73 hours");

    await sweep();

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("failed");
    expect(harness.paypal.charges()).toBe(0);
  });

  it("fails an unpaid booking deposit even if PayPal no longer knows it", async () => {
    const shop = await createShop(getDb());
    const orderId = (await createOrder(getDb(), shop.id, { kind: "booking_deposit" })).id;
    await age(orderId, "73 hours");
    harness.paypal.nextRead({
      type: "respond",
      status: 404,
      body: { name: "RESOURCE_NOT_FOUND" },
    });

    await sweep();

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("failed");
  });

  it("still pays an order PayPal reports as approved", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    await age(orderId, "73 hours");

    await sweep();

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
  });

  it("sends an approved order with no verified outcome to a person", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    await getDb()
      .update(orders)
      .set({ paymentStatus: "approved" })
      .where(eq(orders.id, orderId));
    await age(orderId, "73 hours");
    harness.paypal.nextRead({ type: "timeout" });

    await sweep();

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("review_required");
    expect(harness.paypal.charges()).toBe(0);

    await age(orderId, "74 hours", "1 day");
    expect(await sweep()).toBe(0);
  });

  it("reviews a physical order with an unknown create result and preserves its reservation", async () => {
    const shop = await createShop(getDb(), { paypalMerchantId: "SWEEPMERCHANTUNKNOWN" });
    const product = await createProduct(getDb(), shop.id);
    await setTestTrackedStock(getDb(), shop.id, product.id, 1);
    const idempotencyKey = `sweep-unknown-${randomUUID()}`;
    harness.paypal.nextOrder({ type: "timeout", orderCreated: true });

    await expect(
      createCheckout(
        getDb(),
        { items: [{ productId: product.id, quantity: 1 }], idempotencyKey },
        harness.deps,
      ),
    ).rejects.toMatchObject({ code: "PAYMENT_TIMEOUT" });
    const [created] = await getDb()
      .select()
      .from(orders)
      .where(eq(orders.idempotencyKey, idempotencyKey));
    await getDb()
      .update(inventoryReservations)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(inventoryReservations.id, created.inventoryReservationId!));
    await age(created.id, "73 hours");

    await sweep();

    expect((await readOrder(getDb(), created.id)).paymentStatus).toBe("review_required");
    const [reservation] = await getDb()
      .select({ state: inventoryReservations.state })
      .from(inventoryReservations)
      .where(eq(inventoryReservations.id, created.inventoryReservationId!));
    const [stock] = await getDb()
      .select({ onHand: inventoryStock.onHand, reserved: inventoryStock.reserved })
      .from(inventoryStock)
      .where(eq(inventoryStock.productId, product.id));
    expect(reservation.state).toBe("reserved");
    expect(stock).toMatchObject({ onHand: 1, reserved: 1 });
    expect(harness.paypal.charges()).toBe(0);
  });

  it("fails a booking deposit with no PayPal order after the existing timeout", async () => {
    const shop = await createShop(getDb());
    const old = await createOrder(getDb(), shop.id, { kind: "booking_deposit" });
    const recent = await createOrder(getDb(), shop.id, { kind: "booking_deposit" });
    await age(old.id, "73 hours");

    await sweep();

    expect((await readOrder(getDb(), old.id)).paymentStatus).toBe("failed");
    expect((await readOrder(getDb(), recent.id)).paymentStatus).toBe("pending");
  });
});
