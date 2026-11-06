import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import { createOrder, createShop } from "../../../test/fixtures";
import {
  createPaymentHarness,
  placeOrder,
  readOrder,
  type PaymentHarness,
} from "../../../test/payments";
import { orders } from "../db/schema";
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
  it("captures for a buyer who approved and never came back", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    await age(orderId, "10 minutes");

    expect(await sweep()).toBe(1);

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
    expect(harness.paypal.charges()).toBe(1);
    expect(harness.confirmed).toEqual([orderId]);
  });

  it("settles a capture whose outcome was lost, without charging twice", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: false });
    await age(orderId, "10 minutes");
    await sweep();
    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("approved");

    await age(orderId, "20 minutes", "10 minutes");
    await sweep();

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
    expect(harness.paypal.charges()).toBe(1);
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
  it("cancels an order nobody ever approved", async () => {
    const { orderId } = await placeOrder(getDb(), harness);
    await age(orderId, "73 hours");

    await sweep();

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("cancelled");
    expect(harness.paypal.charges()).toBe(0);
  });

  it("cancels it even if PayPal no longer knows the order", async () => {
    const { orderId } = await placeOrder(getDb(), harness);
    await age(orderId, "73 hours");
    harness.paypal.nextRead({
      type: "respond",
      status: 404,
      body: { name: "RESOURCE_NOT_FOUND" },
    });

    await sweep();

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("cancelled");
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

  it("fails an order PayPal never acknowledged, whose link reached nobody", async () => {
    const shop = await createShop(getDb());
    const old = await createOrder(getDb(), shop.id);
    const recent = await createOrder(getDb(), shop.id);
    await age(old.id, "73 hours");

    await sweep();

    expect((await readOrder(getDb(), old.id)).paymentStatus).toBe("failed");
    expect((await readOrder(getDb(), recent.id)).paymentStatus).toBe("pending");
  });
});
