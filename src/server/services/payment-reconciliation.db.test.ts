import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";

import { setupMigratedDatabase } from "../../../test/database";
import { createOrder, createShop } from "../../../test/fixtures";
import {
  CLIENT_SECRET,
  MERCHANT_ID,
  createPaymentHarness,
  placeOrder,
  readOrder,
  type PaymentHarness,
} from "../../../test/payments";
import { orders, shops } from "../db/schema";
import { ServiceError } from "../errors";
import { beginPhysicalOrderCapture } from "../inventory/physical-orders";
import {
  reconcileForBuyer,
  reconcileOrder,
} from "./payment-reconciliation";

const getDb = setupMigratedDatabase();

let harness: PaymentHarness;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  harness = createPaymentHarness();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const reconcile = (orderId: string, options = {}) =>
  reconcileOrder(getDb(), orderId, harness.deps, options);

type Json = Record<string, unknown>;
const unit = (order: Json) => (order.purchase_units as Json[])[0];

describe("reconcileOrder", () => {
  it("leaves an order pending while PayPal waits for the buyer", async () => {
    const { orderId } = await placeOrder(getDb(), harness);

    const order = await reconcile(orderId);

    expect(order?.paymentStatus).toBe("pending");
    expect(harness.paypal.captureRequests()).toHaveLength(0);
    expect(harness.confirmed).toEqual([]);
  });

  it("captures an approved order and records its capture", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);

    const order = await reconcile(orderId);

    expect(order).toMatchObject({
      paymentStatus: "paid",
      paypalCaptureId: harness.paypal.captureIdOf(paypalOrderId),
    });
    expect(order?.paypalCaptureId).toBeTruthy();
    expect(harness.paypal.charges()).toBe(1);
    expect(harness.confirmed).toEqual([orderId]);
    const [capture] = harness.paypal.captureRequests();
    expect(harness.paypal.requestIdOf(capture)).toBe(`capture-${orderId}`);
  });

  it("uses the order's original PayPal credential after the shop mapping changes", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    const order = await readOrder(getDb(), orderId);
    await getDb().update(shops).set({ paypalCredentialRef: "RECONNECTED_SHOP" }).where(eq(shops.id, order.shopId));
    harness.paypal.approve(paypalOrderId);
    const provider = vi.fn(harness.deps.paypalFor);

    await reconcileOrder(getDb(), orderId, { ...harness.deps, paypalFor: provider });

    expect(provider).toHaveBeenCalledWith("TEST_SHOP", MERCHANT_ID);
    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
  });

  it("does not capture a platform order after the seller connection is no longer ready", async () => {
    const { orderId, paypalOrderId, shop } = await placeOrder(getDb(), harness);
    await getDb().update(orders).set({ paypalCredentialRef: "PAYPAL_PLATFORM" }).where(eq(orders.id, orderId));
    harness.paypal.approve(paypalOrderId);

    await reconcileOrder(getDb(), orderId, {
      ...harness.deps,
      paypalFor: (_credentialRef, merchantId) => harness.deps.paypalFor("TEST_SHOP", merchantId),
    });

    expect(harness.paypal.captureRequests()).toHaveLength(0);
    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("cancelled");
    const pool = (getDb() as unknown as { $client: Pool }).$client;
    const stock = await pool.query<{ reserved: number }>(
      "SELECT reserved FROM inventory_stock WHERE shop_id=$1 AND product_id=(SELECT product_id FROM order_lines WHERE order_id=$2 LIMIT 1)",
      [shop.id, orderId],
    );
    expect(stock.rows[0]?.reserved).toBe(0);
  });

  it("keeps an ambiguous capture hold when platform consent is revoked", async () => {
    const { orderId, paypalOrderId, shop } = await placeOrder(getDb(), harness);
    await getDb().update(orders).set({ paypalCredentialRef: "PAYPAL_PLATFORM" }).where(eq(orders.id, orderId));
    const pool = (getDb() as unknown as { $client: Pool }).$client;
    expect((await beginPhysicalOrderCapture(pool, orderId)).allowed).toBe(true);
    harness.paypal.approve(paypalOrderId);

    const order = await reconcileOrder(getDb(), orderId, {
      ...harness.deps,
      paypalFor: (_credentialRef, merchantId) => harness.deps.paypalFor("TEST_SHOP", merchantId),
    });

    expect(order?.paymentStatus).toBe("approved");
    expect(harness.paypal.captureRequests()).toHaveLength(0);
    const stock = await pool.query<{ reserved: number }>(
      "SELECT reserved FROM inventory_stock WHERE shop_id=$1 AND product_id=(SELECT product_id FROM order_lines WHERE order_id=$2 LIMIT 1)",
      [shop.id, orderId],
    );
    expect(stock.rows[0]?.reserved).toBe(1);
  });

  it("does not capture what PayPal has not reported as approved", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);

    for (const status of ["CREATED", "PAYER_ACTION_REQUIRED", "SAVED"]) {
      harness.paypal.nextRead({
        type: "change",
        change: (order) => ({ ...order, status }),
      });
      await reconcile(orderId);
    }

    expect(harness.paypal.captureRequests()).toHaveLength(0);
    expect(harness.paypal.charges()).toBe(0);
    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("pending");
    expect(paypalOrderId).toBeTruthy();
  });

  it("does nothing for an unknown order or one PayPal never acknowledged", async () => {
    const shop = await createShop(getDb());
    const unacknowledged = await createOrder(getDb(), shop.id);

    expect(
      await reconcile("99999999-9999-4999-8999-999999999999"),
    ).toBeUndefined();
    expect((await reconcile(unacknowledged.id))?.paymentStatus).toBe("pending");
    expect(harness.paypal.requests).toHaveLength(0);
  });

  it("reports a shop whose credentials are gone, and changes nothing", async () => {
    const { orderId } = await placeOrder(getDb(), harness);

    await expect(
      reconcileOrder(getDb(), orderId, {
        ...harness.deps,
        paypalFor: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_CONFIGURED" });
    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("pending");
  });
});

describe("approval is never payment", () => {
  it("keeps an approved order unpaid while its capture is unresolved", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: false });

    await expect(reconcile(orderId)).rejects.toBeInstanceOf(ServiceError);

    expect(await readOrder(getDb(), orderId)).toMatchObject({
      paymentStatus: "approved",
      paypalCaptureId: null,
    });
    expect(harness.confirmed).toEqual([]);
  });

  it("keeps a pending capture unpaid until PayPal completes it", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "capture_status", status: "PENDING" });

    const pending = await reconcile(orderId);

    expect(pending).toMatchObject({
      paymentStatus: "approved",
      paypalCaptureId: harness.paypal.captureIdOf(paypalOrderId),
    });
    expect(harness.confirmed).toEqual([]);

    harness.paypal.setCaptureStatus(paypalOrderId, "COMPLETED");
    const paid = await reconcile(orderId);

    expect(paid?.paymentStatus).toBe("paid");
    expect(harness.paypal.charges()).toBe(1);
    expect(harness.confirmed).toEqual([orderId]);
  });
});

describe("an unknown capture outcome", () => {
  it("is settled by reading the order when the answer was lost", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: true });

    const order = await reconcile(orderId);

    expect(order?.paymentStatus).toBe("paid");
    expect(harness.paypal.charges()).toBe(1);
  });

  it("keeps a live stock hold when capture outcome is unknown and does not resend capture", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: false });
    await expect(reconcile(orderId)).rejects.toBeInstanceOf(ServiceError);

    const order = await reconcile(orderId);

    expect(order?.paymentStatus).toBe("approved");
    expect(harness.paypal.charges()).toBe(0);
    expect(harness.paypal.captureRequests()).toHaveLength(1);
  });

  it("stays open when PayPal cannot even be read after the capture", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: true });
    harness.paypal.nextRead({ type: "change", change: (order) => order });
    harness.paypal.nextRead({ type: "timeout" });

    await expect(reconcile(orderId)).rejects.toBeInstanceOf(ServiceError);
    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("approved");

    expect((await reconcile(orderId))?.paymentStatus).toBe("paid");
    expect(harness.paypal.charges()).toBe(1);
    expect(harness.confirmed).toEqual([orderId]);
  });

  it("does not repeat a capture PayPal already made", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    await reconcile(orderId);
    await getDb().update(orders).set({
      paymentStatus: "approved",
      paypalCaptureId: null,
    });
    // A stale read shows the order as approved, so a new request reaches PayPal and is refused.
    harness.paypal.nextRead({
      type: "change",
      change: (order) => ({ ...order, status: "APPROVED" }),
    });
    harness.paypal.nextCapture({
      type: "respond",
      status: 422,
      body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] },
    });

    const order = await reconcile(orderId);

    expect(order?.paymentStatus).toBe("paid");
    expect(harness.paypal.charges()).toBe(1);
  });
});

describe("a capture PayPal refuses", () => {
  it("keeps the live allocation when the buyer can retry with another instrument", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({
      type: "respond",
      status: 422,
      body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] },
    });

    const order = await reconcile(orderId);

    expect(order?.paymentStatus).toBe("approved");
    expect(harness.paypal.charges()).toBe(0);
    expect(harness.confirmed).toEqual([]);
  });

  it("fails the order when the capture itself comes back declined", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "capture_status", status: "DECLINED" });

    const order = await reconcile(orderId);

    expect(order).toMatchObject({
      paymentStatus: "failed",
      paypalCaptureId: harness.paypal.captureIdOf(paypalOrderId),
    });
    expect(harness.confirmed).toEqual([]);
  });

  it("captures after the buyer approves again with another instrument", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({
      type: "respond",
      status: 422,
      body: { details: [{ issue: "INSTRUMENT_DECLINED" }] },
    });
    await reconcile(orderId);

    const order = await reconcile(orderId);

    expect(order?.paymentStatus).toBe("paid");
    expect(harness.paypal.charges()).toBe(1);
  });
});

describe("an order that does not match what was stored", () => {
  const cases: [string, (order: Json) => Json][] = [
    [
      "another recipient",
      (order) => {
        unit(order).payee = { merchant_id: "ATTACKERMERCHANT" };
        return order;
      },
    ],
    [
      "another amount",
      (order) => {
        unit(order).amount = { currency_code: "EUR", value: "0.01" };
        return order;
      },
    ],
    [
      "another currency",
      (order) => {
        unit(order).amount = { currency_code: "USD", value: "9.90" };
        return order;
      },
    ],
    [
      "another reference",
      (order) => {
        unit(order).reference_id = "someone-elses-order";
        return order;
      },
    ],
    ["another intent", (order) => ({ ...order, intent: "AUTHORIZE" })],
    [
      "a capture of a different amount",
      (order) => {
        unit(order).payments = {
          captures: [
            {
              id: "CAPTUREX",
              status: "COMPLETED",
              amount: { currency_code: "EUR", value: "0.01" },
            },
          ],
        };
        return { ...order, status: "COMPLETED" };
      },
    ],
    [
      "two captures",
      (order) => {
        const capture = {
          status: "COMPLETED",
          amount: { currency_code: "EUR", value: "9.90" },
        };
        unit(order).payments = {
          captures: [
            { ...capture, id: "CAPTUREA" },
            { ...capture, id: "CAPTUREB" },
          ],
        };
        return { ...order, status: "COMPLETED" };
      },
    ],
    [
      "a completed order with no capture",
      (order) => ({ ...order, status: "COMPLETED" }),
    ],
  ];

  it.each(cases)("goes to review on %s, never paid", async (_name, change) => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextRead({ type: "change", change });

    const order = await reconcile(orderId);

    expect(order?.paymentStatus).toBe("review_required");
    expect(harness.paypal.captureRequests()).toHaveLength(0);
    expect(harness.confirmed).toEqual([]);
  });

  it("stays in review without asking PayPal again", async () => {
    const { orderId } = await placeOrder(getDb(), harness);
    harness.paypal.nextRead({
      type: "change",
      change: (order) => ({ ...order, intent: "AUTHORIZE" }),
    });
    await reconcile(orderId);
    const reads = harness.paypal.readRequests().length;

    const order = await reconcile(orderId);

    expect(order?.paymentStatus).toBe("review_required");
    expect(harness.paypal.readRequests()).toHaveLength(reads);
  });

  it("goes to review when PayPal reports a different capture than the stored one", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    await reconcile(orderId);
    const stored = harness.paypal.captureIdOf(paypalOrderId);
    harness.paypal.nextRead({
      type: "change",
      change: (order) => {
        const payments = unit(order).payments as { captures: Json[] };
        payments.captures[0].id = "ANOTHERCAPTURE";
        return order;
      },
    });

    const order = await reconcile(orderId);

    expect(order).toMatchObject({
      paymentStatus: "review_required",
      paypalCaptureId: stored,
    });
  });
});

describe("a paid order", () => {
  it("is never captured again, whatever a later read says", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    await reconcile(orderId);
    const captures = harness.paypal.captureRequests().length;
    harness.paypal.nextRead({
      type: "change",
      change: (order) => ({ ...order, status: "APPROVED" }),
    });

    const order = await reconcile(orderId);

    expect(order?.paymentStatus).toBe("paid");
    expect(harness.paypal.captureRequests()).toHaveLength(captures);
    expect(harness.paypal.charges()).toBe(1);
  });

  it("confirms the payment once, however often it is reconciled", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await reconcile(orderId);
    }

    expect(harness.confirmed).toEqual([orderId]);
  });

  it("goes to review when PayPal reports a refund", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    await reconcile(orderId);
    harness.paypal.setCaptureStatus(paypalOrderId, "REFUNDED");

    const order = await reconcile(orderId);

    expect(order).toMatchObject({
      paymentStatus: "review_required",
      paypalCaptureId: harness.paypal.captureIdOf(paypalOrderId),
    });
  });

  it.each([
    ["reversed by a void", "VOIDED"],
    ["reported as a refused capture", "DECLINED"],
  ])("goes to review when %s", async (_name, change) => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    await reconcile(orderId);
    if (change === "VOIDED") {
      harness.paypal.void(paypalOrderId);
    } else {
      harness.paypal.setCaptureStatus(paypalOrderId, change);
    }

    expect((await reconcile(orderId))?.paymentStatus).toBe("review_required");
  });
});

describe("the payment-confirmed hook", () => {
  it("runs in the transaction that marks the order paid", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    const statusSeenByHook: string[] = [];

    await reconcileOrder(getDb(), orderId, {
      ...harness.deps,
      onPhysicalPaymentConfirmed: async (client, currentOrderId) => {
        const row = await client.query<{ payment_status: string }>("SELECT payment_status FROM orders WHERE id=$1", [currentOrderId]);
        statusSeenByHook.push(row.rows[0].payment_status, "paid");
      },
    });

    expect(statusSeenByHook).toEqual(["paid", "paid"]);
  });

  it("undoes paid if it fails, and the next attempt runs it again", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    let fail = true;
    const deps = {
      ...harness.deps,
      onPhysicalPaymentConfirmed: async (...args: Parameters<NonNullable<typeof harness.deps.onPhysicalPaymentConfirmed>>) => {
        if (fail) {
          throw new Error("booking could not be confirmed");
        }
        await harness.deps.onPhysicalPaymentConfirmed?.(...args);
      },
    };

    await expect(reconcileOrder(getDb(), orderId, deps)).rejects.toThrow();
    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("approved");

    fail = false;
    await reconcileOrder(getDb(), orderId, deps);

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
    expect(harness.confirmed).toEqual([orderId]);
    expect(harness.paypal.charges()).toBe(1);
  });
});

describe("concurrent reconciliations", () => {
  it("charge once and confirm once", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);

    await Promise.allSettled(
      Array.from({ length: 6 }, () => reconcile(orderId)),
    );
    await reconcile(orderId);

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
    expect(harness.paypal.charges()).toBe(1);
    expect(harness.confirmed).toEqual([orderId]);
  });
});

describe("the buyer cancelling", () => {
  it("cancels an order PayPal agrees was not approved", async () => {
    const { orderId } = await placeOrder(getDb(), harness);

    const order = await reconcile(orderId, { buyerCancelled: true });

    expect(order?.paymentStatus).toBe("cancelled");
    expect(harness.paypal.captureRequests()).toHaveLength(0);
  });

  it("does not stop an order PayPal reports as approved", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);

    const order = await reconcile(orderId, { buyerCancelled: true });

    expect(order?.paymentStatus).toBe("paid");
  });

  it("gives way if the buyer goes back and approves", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    await reconcile(orderId, { buyerCancelled: true });

    harness.paypal.approve(paypalOrderId);
    const order = await reconcile(orderId);

    expect(order?.paymentStatus).toBe("paid");
    expect(harness.paypal.charges()).toBe(1);
  });

  it.each(["approved", "paid"] as const)(
    "does not undo an order already %s, even if a stale read shows no approval",
    async (paymentStatus) => {
      const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
      harness.paypal.approve(paypalOrderId);
      await reconcile(orderId);
      await getDb().update(orders).set({ paymentStatus });
      harness.paypal.nextRead({
        type: "change",
        change: (order) => ({ ...order, status: "PAYER_ACTION_REQUIRED" }),
      });

      const order = await reconcile(orderId, { buyerCancelled: true });

      expect(order?.paymentStatus).toBe(paymentStatus);
    },
  );

  it("cancels an order PayPal has voided", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.void(paypalOrderId);

    expect((await reconcile(orderId))?.paymentStatus).toBe("cancelled");
  });
});

describe("reconcileForBuyer", () => {
  const forBuyer = (input: unknown, options = {}) =>
    reconcileForBuyer(getDb(), input, harness.deps, options);

  it("settles the order for the holder of its capability", async () => {
    const { orderId, statusToken, paypalOrderId } = await placeOrder(
      getDb(),
      harness,
    );
    harness.paypal.approve(paypalOrderId);

    expect(await forBuyer({ orderId, statusToken })).toBe(true);

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
  });

  it("does nothing for an order identifier alone or a wrong capability", async () => {
    const first = await placeOrder(getDb(), harness);
    const second = await placeOrder(getDb(), harness, {
      paypalMerchantId: "OTHERMERCHANT1",
    });
    harness.paypal.approve(first.paypalOrderId);
    const requests = harness.paypal.requests.length;

    for (const input of [
      { orderId: first.orderId },
      { orderId: first.orderId, statusToken: null },
      { orderId: first.orderId, statusToken: second.statusToken },
      { orderId: first.orderId, statusToken: "x".repeat(43) },
      { orderId: "not-a-uuid", statusToken: first.statusToken },
      {},
      null,
    ]) {
      expect(await forBuyer(input)).toBe(false);
    }

    expect(harness.paypal.requests).toHaveLength(requests);
    expect((await readOrder(getDb(), first.orderId)).paymentStatus).toBe("pending");
  });

  it("leaves the order for later if PayPal cannot be reached", async () => {
    const { orderId, statusToken, paypalOrderId } = await placeOrder(
      getDb(),
      harness,
    );
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextRead({ type: "timeout" });

    expect(await forBuyer({ orderId, statusToken })).toBe(true);

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("pending");
  });

  it("logs short provider codes, and no credentials or merchant identifiers", async () => {
    const { orderId, statusToken, paypalOrderId } = await placeOrder(
      getDb(),
      harness,
    );
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({
      type: "respond",
      status: 422,
      body: {
        name: "UNPROCESSABLE_ENTITY",
        debug_id: "debug-id-456",
        details: [
          {
            issue: "INSTRUMENT_DECLINED",
            description: `Payee ${MERCHANT_ID} refused`,
          },
        ],
      },
    });

    await forBuyer({ orderId, statusToken });

    expect(consoleError).toHaveBeenCalledWith("PayPal capture failed", {
      orderId,
      kind: "rejected",
      status: 422,
      name: "UNPROCESSABLE_ENTITY",
      debugId: "debug-id-456",
      issues: ["INSTRUMENT_DECLINED"],
    });
    const logged = JSON.stringify(consoleError.mock.calls);
    for (const secret of [MERCHANT_ID, CLIENT_SECRET, "fake-access-token", "Bearer"]) {
      expect(logged).not.toContain(secret);
    }
  });
});
