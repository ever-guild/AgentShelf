import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import {
  createBooking,
  createOrder,
  createService,
  createShop,
  createTechnician,
  hoursAfterNoon,
  NOON,
} from "../../../test/fixtures";
import {
  createPaymentHarness,
  placeOrder,
  readOrder,
  type PaymentHarness,
} from "../../../test/payments";
import { issueOrderStatusToken } from "../auth/order-status-token";
import { getOrderStatusResult } from "../contracts/commerce";
import { orders } from "../db/schema";
import { ServiceError, type ServiceErrorCode } from "../errors";
import { getOrderStatus } from "./order-status";
import { reconcileOrder } from "./payment-reconciliation";

const getDb = setupMigratedDatabase();

let harness: PaymentHarness;

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  harness = createPaymentHarness();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function codeOf(attempt: Promise<unknown>): Promise<ServiceErrorCode> {
  const error = await attempt.then(
    () => {
      throw new Error("Expected the read to fail");
    },
    (rejection) => rejection,
  );
  if (!(error instanceof ServiceError)) {
    throw error;
  }
  return error.code;
}

describe("getOrderStatus", () => {
  it("returns the exact public shape for a pending order", async () => {
    const { orderId, statusToken } = await placeOrder(getDb(), harness);

    const status = await getOrderStatus(getDb(), { orderId, statusToken });

    const { updatedAt } = await readOrder(getDb(), orderId);
    expect(status).toEqual({
      orderId,
      paymentStatus: "pending",
      totalMinor: 990,
      currency: "EUR",
      booking: null,
      updatedAt: updatedAt.toISOString(),
    });
  });

  it("reports an approved order as approved, never paid", async () => {
    const { orderId, statusToken, paypalOrderId } = await placeOrder(
      getDb(),
      harness,
    );
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: false });
    await reconcileOrder(getDb(), orderId, harness.deps).catch(() => {});

    const status = await getOrderStatus(getDb(), { orderId, statusToken });

    expect(status.paymentStatus).toBe("approved");
  });

  it("reports a verified payment as paid, with the stored amount", async () => {
    const { orderId, statusToken, paypalOrderId } = await placeOrder(
      getDb(),
      harness,
    );
    harness.paypal.approve(paypalOrderId);
    await reconcileOrder(getDb(), orderId, harness.deps);

    expect(await getOrderStatus(getDb(), { orderId, statusToken })).toMatchObject({
      paymentStatus: "paid",
      totalMinor: 990,
      currency: "EUR",
    });
  });

  it.each(["cancelled", "failed", "review_required"] as const)(
    "reports %s as stored",
    async (paymentStatus) => {
      const { orderId, statusToken } = await placeOrder(getDb(), harness);
      await getDb()
        .update(orders)
        .set({ paymentStatus })
        .where(eq(orders.id, orderId));

      const status = await getOrderStatus(getDb(), { orderId, statusToken });

      expect(status.paymentStatus).toBe(paymentStatus);
    },
  );

  it("cannot be read with an identifier alone", async () => {
    const first = await placeOrder(getDb(), harness);
    const second = await placeOrder(getDb(), harness, {
      paypalMerchantId: "OTHERMERCHANT1",
    });
    const unavailable = "ORDER_STATUS_UNAVAILABLE";

    expect(
      await codeOf(
        getOrderStatus(getDb(), {
          orderId: first.orderId,
          statusToken: second.statusToken,
        }),
      ),
    ).toBe(unavailable);
    expect(
      await codeOf(
        getOrderStatus(getDb(), {
          orderId: first.orderId,
          statusToken: `${first.statusToken.slice(0, -1)}x`,
        }),
      ),
    ).toBe(unavailable);
    expect(
      await codeOf(
        getOrderStatus(getDb(), {
          orderId: first.orderId,
          statusToken: "x".repeat(43),
        }),
      ),
    ).toBe(unavailable);
  });

  it("gives the same answer for a missing order and a wrong capability", async () => {
    const { orderId } = await placeOrder(getDb(), harness);
    const missing = "99999999-9999-4999-8999-999999999999";

    const errors = await Promise.all([
      getOrderStatus(getDb(), {
        orderId: missing,
        statusToken: issueOrderStatusToken(missing),
      }).catch((error: ServiceError) => error.toJSON()),
      getOrderStatus(getDb(), {
        orderId,
        statusToken: "x".repeat(43),
      }).catch((error: ServiceError) => error.toJSON()),
    ]);

    expect(errors[0]).toEqual(errors[1]);
    expect(errors[0]).toEqual({
      code: "ORDER_STATUS_UNAVAILABLE",
      message: expect.any(String),
    });
    expect(JSON.stringify(errors)).not.toContain(orderId);
  });

  it("keeps malformed input as a distinct error", async () => {
    expect(
      await codeOf(getOrderStatus(getDb(), { orderId: "not-a-uuid", statusToken: "x" })),
    ).toBe("INVALID_INPUT");
    const { orderId, statusToken } = await placeOrder(getDb(), harness);
    expect(
      await codeOf(
        getOrderStatus(getDb(), { orderId, statusToken, shopId: "x" }),
      ),
    ).toBe("INVALID_INPUT");
  });

  it("returns only that order's booking, in the shop's timezone", async () => {
    const shop = await createShop(getDb(), { timezone: "Europe/Riga" });
    const service = await createService(getDb(), shop.id);
    const technician = await createTechnician(getDb(), shop.id);
    const order = await createOrder(getDb(), shop.id, { kind: "booking_deposit" });
    const booking = await createBooking(getDb(), shop.id, service.id, technician.id, {
      orderId: order.id,
    });

    const status = await getOrderStatus(getDb(), {
      orderId: order.id,
      statusToken: issueOrderStatusToken(order.id),
    });

    expect(status.booking).toEqual({
      bookingId: booking.id,
      status: "held",
      startsAt: NOON.toISOString(),
      endsAt: hoursAfterNoon(1).toISOString(),
      expiresAt: hoursAfterNoon(-1).toISOString(),
      timezone: "Europe/Riga",
    });
  });

  it("exposes nothing beyond the public contract", async () => {
    const { orderId, statusToken, paypalOrderId } = await placeOrder(
      getDb(),
      harness,
    );
    harness.paypal.approve(paypalOrderId);
    await reconcileOrder(getDb(), orderId, harness.deps);

    const status = await getOrderStatus(getDb(), { orderId, statusToken });

    expect(Object.keys(status).sort()).toEqual(
      Object.keys(getOrderStatusResult.shape).sort(),
    );
    const { paypalCaptureId, payeeMerchantId } = await readOrder(getDb(), orderId);
    const text = JSON.stringify(status);
    for (const hidden of [paypalCaptureId, payeeMerchantId, paypalOrderId]) {
      expect(text).not.toContain(String(hidden));
    }
  });

  it("never asks PayPal and never changes the order", async () => {
    const { orderId, statusToken, paypalOrderId } = await placeOrder(
      getDb(),
      harness,
    );
    harness.paypal.approve(paypalOrderId);
    const before = await readOrder(getDb(), orderId);
    const requests = harness.paypal.requests.length;

    await getOrderStatus(getDb(), { orderId, statusToken });
    await getOrderStatus(getDb(), { orderId, statusToken: "x".repeat(43) }).catch(
      () => {},
    );

    expect(harness.paypal.requests).toHaveLength(requests);
    expect(await readOrder(getDb(), orderId)).toEqual(before);
  });
});
