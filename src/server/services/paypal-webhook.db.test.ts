import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import {
  WEBHOOK_ID,
  MERCHANT_ID,
  createPaymentHarness,
  placeOrder,
  readOrder,
  type PaymentHarness,
} from "../../../test/payments";
import {
  orders,
  paypalMerchantConnections,
  sellerOwners,
  shopMemberships,
  shops,
  webhookReceipts,
} from "../db/schema";
import { PLATFORM_PAYPAL_CREDENTIAL_REF, createPayPalProvider } from "../paypal/orders";
import { reconcileForBuyer } from "./payment-reconciliation";
import { handlePayPalWebhook, handlePlatformPayPalWebhook } from "./paypal-webhook";

const getDb = setupMigratedDatabase();

let harness: PaymentHarness;
let eventNumber = 0;
const PLATFORM_WEBHOOK_ID = "WH-PLATFORM-PAYMENTS";
const PLATFORM_ENV = {
  PAYPAL_PLATFORM_CLIENT_ID: "sandbox-platform-client-id",
  PAYPAL_PLATFORM_CLIENT_SECRET: "sandbox-platform-client-secret",
  PAYPAL_PARTNER_ATTRIBUTION_ID: "AGENT_SHELF_BN_CODE",
};
let platformDeps: PaymentHarness["deps"];

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  vi.stubEnv("PAYPAL_PLATFORM_PAYMENT_WEBHOOK_ID", PLATFORM_WEBHOOK_ID);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  harness = createPaymentHarness();
  platformDeps = {
    ...harness.deps,
    paypalFor: createPayPalProvider(PLATFORM_ENV, harness.paypal.adapter),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Json = Record<string, unknown>;

function approvedEvent(paypalOrderId: string, extra: Json = {}): Json {
  eventNumber += 1;
  return {
    id: `WH-APPROVED-${eventNumber}`,
    event_type: "CHECKOUT.ORDER.APPROVED",
    resource_type: "checkout-order",
    create_time: "2026-11-06T10:00:00Z",
    resource: { id: paypalOrderId, status: "APPROVED", ...extra },
  };
}

function captureEvent(
  paypalOrderId: string,
  eventType = "PAYMENT.CAPTURE.COMPLETED",
): Json {
  eventNumber += 1;
  return {
    id: `WH-CAPTURE-${eventNumber}`,
    event_type: eventType,
    resource_type: "capture",
    create_time: "2026-11-06T10:00:01Z",
    resource: {
      id: "SOMECAPTUREID",
      status: "COMPLETED",
      amount: { currency_code: "EUR", value: "9.90" },
      supplementary_data: { related_ids: { order_id: paypalOrderId } },
    },
  };
}

// Pretty-printed on purpose: verifying must use these exact bytes, not a re-serialized copy.
const rawOf = (event: Json) => JSON.stringify(event, null, 3);

function deliver(
  shopSlug: string,
  event: Json,
  headers?: Headers,
  rawBody = rawOf(event),
) {
  return handlePayPalWebhook(
    getDb(),
    {
      shopSlug,
      rawBody,
      headers: headers ?? harness.paypal.signDelivery(WEBHOOK_ID, rawBody),
    },
    harness.deps,
  );
}

function deliverPlatform(event: Json, headers?: Headers, rawBody = rawOf(event)) {
  return handlePlatformPayPalWebhook(getDb(), {
    rawBody,
    headers: headers ?? harness.paypal.signDelivery(PLATFORM_WEBHOOK_ID, rawBody),
  }, platformDeps);
}

async function markPlatformOrder(
  orderId: string,
  options: { revoke?: boolean } = {},
) {
  const order = await readOrder(getDb(), orderId);
  await getDb().update(orders)
    .set({ paypalCredentialRef: PLATFORM_PAYPAL_CREDENTIAL_REF })
    .where(eq(orders.id, orderId));
  if (!options.revoke) return;

  const ownerId = randomUUID();
  const now = new Date("2026-11-06T12:00:00Z");
  await getDb().update(shops)
    .set({ paypalCredentialRef: "UNCONFIGURED", paypalMerchantId: null })
    .where(eq(shops.id, order.shopId));
  await getDb().insert(sellerOwners).values({
    id: ownerId,
    username: `owner-${randomUUID().slice(0, 8)}`,
    passwordHash: `scrypt$16384$8$1$${"A".repeat(22)}$${"B".repeat(43)}`,
  });
  await getDb().insert(shopMemberships).values({ ownerId, shopId: order.shopId });
  await getDb().insert(paypalMerchantConnections).values({
    shopId: order.shopId,
    consentedByOwnerId: ownerId,
    shareDataConsentAt: new Date(now.getTime() - 60_000),
    status: "revoked",
    trackingId: `${randomUUID().replaceAll("-", "")}${randomUUID().slice(0, 8)}`,
    requestKeyHash: randomUUID().replaceAll("-", "").repeat(2),
    sellerMerchantId: order.payeeMerchantId,
    createdAt: now,
    updatedAt: now,
  });
}

const receipts = () => getDb().select().from(webhookReceipts);

describe("a verified event", () => {
  it("settles its order and records the delivery", async () => {
    const { shop, orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    const event = approvedEvent(paypalOrderId);

    expect(await deliver(shop.slug, event)).toBe(200);

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
    expect(harness.paypal.charges()).toBe(1);
    expect(await receipts()).toEqual([
      expect.objectContaining({
        providerEventId: event.id,
        eventType: "CHECKOUT.ORDER.APPROVED",
        resourceId: paypalOrderId,
        shopId: shop.id,
        orderId,
        status: "processed",
        processedAt: expect.any(Date),
      }),
    ]);
  });

  it("verifies against the seller's subscription, with the bytes as received", async () => {
    const { shop, paypalOrderId } = await placeOrder(getDb(), harness);
    const raw = rawOf(approvedEvent(paypalOrderId));

    expect(await deliver(shop.slug, {}, undefined, raw)).toBe(200);

    const [request] = harness.paypal.verifyRequests();
    expect(request.data).toContain(`"webhook_id":"${WEBHOOK_ID}"`);
    expect(request.data).toContain(raw);
    expect(new URL(request.url).origin).toBe("https://api-m.sandbox.paypal.com");
  });

  it("only points at an order: what it claims cannot make that order paid", async () => {
    const { shop, orderId, paypalOrderId } = await placeOrder(getDb(), harness);

    // PayPal really signed this, but its own order still waits for the buyer.
    expect(await deliver(shop.slug, captureEvent(paypalOrderId))).toBe(200);

    expect(await readOrder(getDb(), orderId)).toMatchObject({
      paymentStatus: "pending",
      paypalCaptureId: null,
    });
    expect(harness.confirmed).toEqual([]);
  });

  it("cannot mark paid an order whose amount does not match", async () => {
    const { shop, orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextRead({
      type: "change",
      change: (order) => {
        (order.purchase_units as Json[])[0].amount = {
          currency_code: "EUR",
          value: "0.01",
        };
        return order;
      },
    });

    expect(await deliver(shop.slug, approvedEvent(paypalOrderId))).toBe(200);

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("review_required");
    expect(harness.paypal.charges()).toBe(0);
    expect(harness.confirmed).toEqual([]);
  });

  it("cannot mark paid an order for the wrong merchant", async () => {
    const { shop, orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextRead({
      type: "change",
      change: (order) => {
        (order.purchase_units as Json[])[0].payee = {
          merchant_id: "ATTACKERMERCHANT",
        };
        return order;
      },
    });

    expect(await deliver(shop.slug, approvedEvent(paypalOrderId))).toBe(200);

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("review_required");
    expect(harness.paypal.captureRequests()).toHaveLength(0);
  });

  it("finds its order by our own ID when it names no PayPal order", async () => {
    const { shop, orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    const event = captureEvent(paypalOrderId);
    const resource = event.resource as Json;
    delete resource.supplementary_data;
    resource.custom_id = orderId;

    expect(await deliver(shop.slug, event)).toBe(200);

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
  });

  it("keeps identifiers only, never the payer", async () => {
    const { shop, paypalOrderId } = await placeOrder(getDb(), harness);
    const event = approvedEvent(paypalOrderId, {
      payer: {
        email_address: "synthetic-buyer@example.com",
        name: { given_name: "Synthetic", surname: "Buyer" },
      },
      purchase_units: [{ shipping: { address: { address_line_1: "1 Synthetic Street" } } }],
    });

    await deliver(shop.slug, event);

    const [receipt] = await receipts();
    const stored = JSON.stringify(receipt.payload);
    expect(stored).toContain(paypalOrderId);
    expect(stored).not.toMatch(/synthetic-buyer|Synthetic|address_line/);
  });
});

describe("a delivery that cannot be trusted", () => {
  it("is rejected with a forged signature, and changes nothing", async () => {
    const { shop, orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    const raw = rawOf(captureEvent(paypalOrderId));
    const headers = harness.paypal.signDelivery(WEBHOOK_ID, raw);
    headers.set("paypal-transmission-sig", "forged");

    expect(await deliver(shop.slug, {}, headers, raw)).toBe(400);

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("pending");
    expect(await receipts()).toEqual([]);
    expect(harness.paypal.readRequests()).toHaveLength(0);
  });

  it("is rejected when the body was changed after signing", async () => {
    const { shop, orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    const headers = harness.paypal.signDelivery(
      WEBHOOK_ID,
      rawOf(approvedEvent(paypalOrderId)),
    );

    expect(
      await deliver(shop.slug, approvedEvent(paypalOrderId), headers),
    ).toBe(400);
    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("pending");
  });

  it("is rejected when signed for another subscription", async () => {
    const { shop, paypalOrderId } = await placeOrder(getDb(), harness);
    const raw = rawOf(approvedEvent(paypalOrderId));

    expect(
      await deliver(
        shop.slug,
        {},
        harness.paypal.signDelivery("WH-ANOTHER-APP", raw),
        raw,
      ),
    ).toBe(400);
  });

  it("is rejected if PayPal gives any other verification answer", async () => {
    const { shop, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.nextVerify({
      type: "respond",
      status: 200,
      body: { verification_status: "FAILURE" },
    });

    expect(await deliver(shop.slug, approvedEvent(paypalOrderId))).toBe(400);
  });

  it.each([
    "paypal-auth-algo",
    "paypal-cert-url",
    "paypal-transmission-id",
    "paypal-transmission-sig",
    "paypal-transmission-time",
  ])("is rejected without the %s header, before asking PayPal", async (name) => {
    const { shop, paypalOrderId } = await placeOrder(getDb(), harness);
    const requests = harness.paypal.requests.length;
    const raw = rawOf(approvedEvent(paypalOrderId));
    const headers = harness.paypal.signDelivery(WEBHOOK_ID, raw);
    headers.delete(name);

    expect(await deliver(shop.slug, {}, headers, raw)).toBe(400);

    expect(harness.paypal.requests).toHaveLength(requests);
  });

  it.each([
    ["no JSON", "not json"],
    ["JSON that is not an event", "[1,2]"],
    ["an event with no type", JSON.stringify({ id: "WH-1", resource: {} })],
    ["an event with no resource", JSON.stringify({ id: "WH-1", event_type: "X" })],
    // Spliced into the verification request, this must not be able to change its fields.
    [
      "a body that would break out of the request",
      '{"id":"WH-1","event_type":"X","resource":{}},"webhook_id":"OTHER"',
    ],
  ])("is rejected with %s, before asking PayPal", async (_name, raw) => {
    const { shop } = await placeOrder(getDb(), harness);
    const requests = harness.paypal.requests.length;

    expect(
      await deliver(
        shop.slug,
        {},
        harness.paypal.signDelivery(WEBHOOK_ID, raw),
        raw,
      ),
    ).toBe(400);

    expect(harness.paypal.requests).toHaveLength(requests);
  });

  it("gets 404 for a shop that does not exist", async () => {
    const { paypalOrderId } = await placeOrder(getDb(), harness);

    expect(await deliver("no-such-shop", approvedEvent(paypalOrderId))).toBe(404);
  });
});

describe("when the event cannot be handled yet", () => {
  it("asks PayPal to repeat it if this shop has no webhook configured", async () => {
    const { shop, paypalOrderId } = await placeOrder(getDb(), harness);
    const paypalFor = harness.deps.paypalFor;
    const event = approvedEvent(paypalOrderId);
    const raw = rawOf(event);

    const status = await handlePayPalWebhook(
      getDb(),
      {
        shopSlug: shop.slug,
        rawBody: raw,
        headers: harness.paypal.signDelivery(WEBHOOK_ID, raw),
      },
      {
        ...harness.deps,
        paypalFor: (ref) => {
          const api = paypalFor(ref);
          return api && { ...api, webhookId: undefined };
        },
      },
    );

    expect(status).toBe(503);
    expect(harness.paypal.verifyRequests()).toHaveLength(0);
    expect(await receipts()).toEqual([]);
  });

  it("asks PayPal to repeat it if verification cannot run, and handles the repeat", async () => {
    const { shop, orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    const event = approvedEvent(paypalOrderId);
    harness.paypal.nextVerify({ type: "timeout" });

    expect(await deliver(shop.slug, event)).toBe(503);
    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("pending");
    expect(await receipts()).toEqual([]);

    expect(await deliver(shop.slug, event)).toBe(200);
    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
  });

  it("asks PayPal to repeat it if the order cannot be settled, and handles the repeat", async () => {
    const { shop, orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    const event = approvedEvent(paypalOrderId);
    harness.paypal.nextRead({ type: "timeout" });

    expect(await deliver(shop.slug, event)).toBe(503);
    expect((await receipts())[0].status).toBe("failed");

    expect(await deliver(shop.slug, event)).toBe(200);
    expect(await receipts()).toHaveLength(1);
    expect((await receipts())[0].status).toBe("processed");
    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
    expect(harness.paypal.charges()).toBe(1);
  });
});

describe("repeated and reordered events", () => {
  it("handles a duplicate delivery once", async () => {
    const { shop, orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    const event = approvedEvent(paypalOrderId);

    expect(await deliver(shop.slug, event)).toBe(200);
    const reads = harness.paypal.readRequests().length;
    expect(await deliver(shop.slug, event)).toBe(200);
    expect(await deliver(shop.slug, event)).toBe(200);

    expect(harness.paypal.readRequests()).toHaveLength(reads);
    expect(await receipts()).toHaveLength(1);
    expect(harness.paypal.charges()).toBe(1);
    expect(harness.confirmed).toEqual([orderId]);
  });

  it("converges when the capture event arrives before the approval event", async () => {
    const { shop, orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);

    expect(await deliver(shop.slug, captureEvent(paypalOrderId))).toBe(200);
    expect(await deliver(shop.slug, approvedEvent(paypalOrderId))).toBe(200);

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
    expect(harness.paypal.charges()).toBe(1);
    expect(harness.confirmed).toEqual([orderId]);
  });

  it("converges when the webhook arrives before the buyer comes back", async () => {
    const { shop, orderId, statusToken, paypalOrderId } = await placeOrder(
      getDb(),
      harness,
    );
    harness.paypal.approve(paypalOrderId);

    expect(await deliver(shop.slug, approvedEvent(paypalOrderId))).toBe(200);
    await reconcileForBuyer(getDb(), { orderId, statusToken }, harness.deps);

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
    expect(harness.paypal.charges()).toBe(1);
    expect(harness.confirmed).toEqual([orderId]);
  });

  it("converges when the buyer comes back before the webhook", async () => {
    const { shop, orderId, statusToken, paypalOrderId } = await placeOrder(
      getDb(),
      harness,
    );
    harness.paypal.approve(paypalOrderId);

    await reconcileForBuyer(getDb(), { orderId, statusToken }, harness.deps);
    expect(await deliver(shop.slug, captureEvent(paypalOrderId))).toBe(200);

    expect(harness.paypal.charges()).toBe(1);
    expect(harness.confirmed).toEqual([orderId]);
  });

  it("converges when a delayed approval event arrives long after payment", async () => {
    const { shop, orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    await deliver(shop.slug, captureEvent(paypalOrderId));
    const captures = harness.paypal.captureRequests().length;

    await deliver(shop.slug, approvedEvent(paypalOrderId));

    expect(harness.paypal.captureRequests()).toHaveLength(captures);
    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
  });

  it("sends a paid order to review when PayPal reports a refund", async () => {
    const { shop, orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    await deliver(shop.slug, approvedEvent(paypalOrderId));
    harness.paypal.setCaptureStatus(paypalOrderId, "REFUNDED");

    await deliver(shop.slug, captureEvent(paypalOrderId, "PAYMENT.CAPTURE.REFUNDED"));

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("review_required");
  });
});

describe("events that are not for us", () => {
  it("ignores an event for an order we do not have, such as a proof order", async () => {
    const { shop } = await placeOrder(getDb(), harness);
    const event = captureEvent("ORDERFROMANOTHERTOOL");

    expect(await deliver(shop.slug, event)).toBe(200);

    expect(await receipts()).toEqual([
      expect.objectContaining({ status: "ignored", orderId: null }),
    ]);
    expect(harness.paypal.readRequests()).toHaveLength(0);
  });

  it("ignores an event for another shop's order, which stays as it was", async () => {
    const first = await placeOrder(getDb(), harness);
    const second = await placeOrder(getDb(), harness, {
      paypalMerchantId: "OTHERMERCHANT1",
    });
    harness.paypal.approve(second.paypalOrderId);

    expect(
      await deliver(first.shop.slug, approvedEvent(second.paypalOrderId)),
    ).toBe(200);

    expect((await readOrder(getDb(), second.orderId)).paymentStatus).toBe("pending");
    expect(harness.paypal.charges()).toBe(0);
    const [receipt] = await receipts();
    expect(receipt).toMatchObject({ status: "ignored", orderId: null });
  });

  it("ignores event types this service does not act on", async () => {
    const { shop, orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    harness.paypal.approve(paypalOrderId);
    eventNumber += 1;
    const event = {
      id: `WH-OTHER-${eventNumber}`,
      event_type: "CUSTOMER.DISPUTE.CREATED",
      // It names the order the same way a capture event does, so only its type excludes it.
      resource: {
        id: paypalOrderId,
        supplementary_data: { related_ids: { order_id: paypalOrderId } },
      },
    };

    expect(await deliver(shop.slug, event)).toBe(200);

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("pending");
    const [receipt] = await getDb()
      .select()
      .from(webhookReceipts)
      .where(eq(webhookReceipts.providerEventId, event.id));
    expect(receipt.status).toBe("ignored");
  });

  it("answers an ignored duplicate without asking PayPal again", async () => {
    const { shop } = await placeOrder(getDb(), harness);
    const event = captureEvent("ORDERFROMANOTHERTOOL");

    await deliver(shop.slug, event);
    expect(await deliver(shop.slug, event)).toBe(200);

    expect(await receipts()).toHaveLength(1);
    expect(harness.paypal.readRequests()).toHaveLength(0);
  });
});

describe("the platform webhook subscription", () => {
  it("reconciles a completed order after seller revocation and deduplicates the delivery", async () => {
    const { shop, orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    await markPlatformOrder(orderId, { revoke: true });
    const platformPayPal = platformDeps.paypalFor(
      PLATFORM_PAYPAL_CREDENTIAL_REF,
      MERCHANT_ID,
    );
    expect(platformPayPal).toBeDefined();
    harness.paypal.approve(paypalOrderId);
    await platformPayPal!.captureOrder({
      id: paypalOrderId,
      paypalRequestId: `capture-${orderId}`,
      body: {},
    });
    const event = captureEvent(paypalOrderId);

    expect(await deliverPlatform(event)).toBe(200);
    expect(await readOrder(getDb(), orderId)).toMatchObject({
      paymentStatus: "paid",
      paypalCredentialRef: PLATFORM_PAYPAL_CREDENTIAL_REF,
    });
    expect(harness.confirmed).toEqual([orderId]);
    expect(harness.paypal.captureRequests()).toHaveLength(1);
    expect(await deliverPlatform(event)).toBe(200);
    expect(harness.confirmed).toEqual([orderId]);
    expect(harness.paypal.readRequests()).toHaveLength(1);
    expect(await receipts()).toEqual([
      expect.objectContaining({
        providerEventId: event.id,
        shopId: shop.id,
        orderId,
        status: "processed",
      }),
    ]);
  });

  it("does not write a receipt or reconcile before the platform signature verifies", async () => {
    const { orderId, paypalOrderId } = await placeOrder(getDb(), harness);
    await markPlatformOrder(orderId);
    const event = captureEvent(paypalOrderId);
    const raw = rawOf(event);
    const headers = harness.paypal.signDelivery(PLATFORM_WEBHOOK_ID, raw);
    headers.set("paypal-transmission-sig", "invalid-signature");

    expect(await deliverPlatform(event, headers, raw)).toBe(400);
    expect(await receipts()).toEqual([]);
    expect(harness.paypal.readRequests()).toHaveLength(0);
    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("pending");
  });

  it("ignores a signed event whose PayPal order ID and local custom ID name different orders", async () => {
    const first = await placeOrder(getDb(), harness);
    const second = await placeOrder(getDb(), harness, { paypalMerchantId: "PLATFORMSELLER2" });
    await markPlatformOrder(first.orderId);
    await markPlatformOrder(second.orderId);
    const event = captureEvent(first.paypalOrderId);
    (event.resource as Json).custom_id = second.orderId;

    expect(await deliverPlatform(event)).toBe(200);
    expect((await readOrder(getDb(), first.orderId)).paymentStatus).toBe("pending");
    expect((await readOrder(getDb(), second.orderId)).paymentStatus).toBe("pending");
    expect(harness.paypal.readRequests()).toHaveLength(0);
    expect(await receipts()).toEqual([
      expect.objectContaining({ status: "ignored", orderId: null }),
    ]);
  });
});
