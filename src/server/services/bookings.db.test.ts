import { randomUUID } from "node:crypto";

import { and, count, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  book,
  captureAcrossExpiry,
  createBookingHarness,
  createWorkshop,
  landEarlierCapture,
  minutes,
  MONDAY_MORNING,
  NOON_SLOT,
  ONE_PM_SLOT,
  openEveryDay,
  paypalIdOf,
  readBooking,
  slotAt,
  type BookingHarness,
} from "../../../test/bookings";
import { setupMigratedDatabase } from "../../../test/database";
import { createTrackedProduct } from "../../../test/fixtures";
import {
  createProduct,
  createService,
  createShop,
  createTechnician,
  createWindow,
} from "../../../test/fixtures";
import { MERCHANT_ID, readOrder, WEBHOOK_ID } from "../../../test/payments";
import {
  bookings,
  orderLines,
  orders,
  paypalMerchantConnections,
  products,
  sellerOwners,
  shopMemberships,
  technicianWindows,
} from "../db/schema";
import { createPayPalProvider } from "../paypal/orders";
import { BOOKING_POLICY } from "../domain/booking-policy";
import { encodeSlotId } from "../domain/slots";
import { ServiceError, type ServiceErrorCode } from "../errors";
import { getOrderBooking, getShopSchedule } from "./booking-schedule";
import {
  bookSlot,
  confirmBookingPayment,
  expireHolds,
  getSlots,
} from "./bookings";
import { createCheckout } from "./checkout";
import { getOrderStatus } from "./order-status";
import { sweepOpenOrders } from "./order-sweep";
import { defaultReconcileDeps, reconcileOrder } from "./payment-reconciliation";
import { handlePayPalWebhook } from "./paypal-webhook";

const getDb = setupMigratedDatabase();

let harness: BookingHarness;

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  vi.spyOn(console, "error").mockImplementation(() => {});
  harness = createBookingHarness();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function codeOf(attempt: Promise<unknown>): Promise<ServiceErrorCode> {
  const error = await attempt.then(
    () => {
      throw new Error("Expected this to fail");
    },
    (rejection) => rejection,
  );
  if (!(error instanceof ServiceError)) {
    throw error;
  }
  return error.code;
}

const HOLD_MS = minutes(BOOKING_POLICY.holdMinutes);

const liveBookings = async () =>
  getDb()
    .select()
    .from(bookings)
    .where(sql`${bookings.status} IN ('held', 'confirmed')`);

const countOf = async (table: typeof bookings | typeof orders | typeof orderLines) => {
  const [{ n }] = await getDb().select({ n: count() }).from(table);
  return n;
};

// A hold on the noon slot, with PayPal waiting for the buyer.
async function holdNoon(workshop?: Awaited<ReturnType<typeof createWorkshop>>) {
  const context = workshop ?? (await createWorkshop(getDb()));
  const slotId = await slotAt(getDb(), harness, context, NOON_SLOT);
  const held = await book(getDb(), harness, slotId, context.service.id);
  return {
    ...context,
    slotId,
    held,
    paypalOrderId: await paypalIdOf(getDb(), held.orderId),
  };
}

const settle = (orderId: string, options = {}) =>
  reconcileOrder(getDb(), orderId, harness.reconcileDeps, options);

describe("get_slots", () => {
  it("offers explicit instants in shop time for one technician", async () => {
    const { shop, service, technician } = await createWorkshop(getDb());

    const { slots, truncated } = await getSlots(
      getDb(),
      {
        shopId: shop.id,
        serviceId: service.id,
        from: "2026-11-10T07:00:00Z",
        to: "2026-11-10T09:00:00+00:00",
      },
      harness.now(),
    );

    expect(truncated).toBe(false);
    const expected = (startsAt: string, endsAt: string) => ({
      slotId: expect.any(String),
      technicianId: technician.id,
      technicianName: technician.name,
      startsAt,
      endsAt,
      timezone: "Europe/Riga",
    });
    expect(slots).toEqual([
      expected("2026-11-10T07:00:00.000Z", "2026-11-10T08:00:00.000Z"),
      expected("2026-11-10T07:30:00.000Z", "2026-11-10T08:30:00.000Z"),
      expected("2026-11-10T08:00:00.000Z", "2026-11-10T09:00:00.000Z"),
    ]);
  });

  it("derives UTC per date, so working hours hold across a clock change", async () => {
    const { shop, service } = await createWorkshop(getDb());
    harness.setNow(new Date("2027-03-20T00:00:00Z"));

    const firstOfDay = async (from: string, to: string) =>
      (
        await getSlots(
          getDb(),
          { shopId: shop.id, serviceId: service.id, from, to },
          harness.now(),
        )
      ).slots[0].startsAt;

    expect(
      await firstOfDay("2027-03-27T00:00:00Z", "2027-03-27T21:00:00Z"),
    ).toBe("2027-03-27T07:00:00.000Z");
    expect(
      await firstOfDay("2027-03-28T00:00:00Z", "2027-03-28T20:00:00Z"),
    ).toBe("2027-03-28T06:00:00.000Z");
  });

  it("does not offer time within the lead time", async () => {
    const { shop, service } = await createWorkshop(getDb());
    const { slots } = await getSlots(
      getDb(),
      {
        shopId: shop.id,
        serviceId: service.id,
        from: MONDAY_MORNING.toISOString(),
        to: new Date(MONDAY_MORNING.getTime() + minutes(150)).toISOString(),
      },
      harness.now(),
    );
    expect(slots[0].startsAt).toBe(
      new Date(
        MONDAY_MORNING.getTime() + minutes(BOOKING_POLICY.minLeadMinutes),
      ).toISOString(),
    );
  });

  it("hides what a live hold or a confirmed booking occupies, and nothing else", async () => {
    const workshop = await createWorkshop(getDb());
    await holdNoon(workshop);

    const starts = async () =>
      (
        await getSlots(
          getDb(),
          {
            shopId: workshop.shop.id,
            serviceId: workshop.service.id,
            from: new Date(NOON_SLOT.getTime() - minutes(60)).toISOString(),
            to: new Date(NOON_SLOT.getTime() + minutes(120)).toISOString(),
          },
          harness.now(),
        )
      ).slots.map((slot) => slot.startsAt);

    // Neighbours that would run into the noon hour are gone too.
    expect(await starts()).toEqual([
      "2026-11-09T09:00:00.000Z",
      "2026-11-09T11:00:00.000Z",
    ]);

    harness.advance(HOLD_MS);
    expect(await starts()).toEqual([
      "2026-11-09T09:00:00.000Z",
      "2026-11-09T09:30:00.000Z",
      "2026-11-09T10:00:00.000Z",
      "2026-11-09T10:30:00.000Z",
      "2026-11-09T11:00:00.000Z",
    ]);
  });

  it("lists each technician's free time separately", async () => {
    const workshop = await createWorkshop(getDb());
    const other = await createTechnician(getDb(), workshop.shop.id);
    await openEveryDay(getDb(), other);
    await holdNoon({ ...workshop });

    const { slots } = await getSlots(
      getDb(),
      {
        shopId: workshop.shop.id,
        serviceId: workshop.service.id,
        from: NOON_SLOT.toISOString(),
        to: ONE_PM_SLOT.toISOString(),
      },
      harness.now(),
    );
    expect(slots).toHaveLength(1);
    const heldBy = (await liveBookings())[0].technicianId;
    expect(slots[0].technicianId).not.toBe(heldBy);
  });

  it("says when an answer does not hold everything", async () => {
    const { shop, service } = await createWorkshop(getDb());
    const { slots, truncated } = await getSlots(
      getDb(),
      {
        shopId: shop.id,
        serviceId: service.id,
        from: "2026-11-10T00:00:00Z",
        to: "2026-12-10T00:00:00Z",
      },
      harness.now(),
    );
    expect(truncated).toBe(true);
    expect(slots).toHaveLength(BOOKING_POLICY.maxSlotsPerAnswer);
  });

  it("gives the same answer for a missing service, another shop's and one not on sale", async () => {
    const { shop, service } = await createWorkshop(getDb());
    const otherShop = await createShop(getDb());
    const plain = await createProduct(getDb(), shop.id);
    const draft = await createService(getDb(), shop.id, { status: "draft" });
    const range = { from: "2026-11-10T07:00:00Z", to: "2026-11-10T09:00:00Z" };

    for (const input of [
      { shopId: shop.id, serviceId: randomUUID() },
      { shopId: otherShop.id, serviceId: service.id },
      { shopId: shop.id, serviceId: plain.id },
      { shopId: shop.id, serviceId: draft.id },
    ]) {
      expect(await codeOf(getSlots(getDb(), { ...input, ...range }))).toBe(
        "PRODUCT_NOT_FOUND",
      );
    }
  });

  it("refuses a service marked unavailable", async () => {
    const { shop, service } = await createWorkshop(getDb());
    await getDb()
      .update(products)
      .set({ availability: "unavailable" })
      .where(eq(products.id, service.id));
    expect(
      await codeOf(
        getSlots(getDb(), {
          shopId: shop.id,
          serviceId: service.id,
          from: "2026-11-10T07:00:00Z",
          to: "2026-11-10T09:00:00Z",
        }),
      ),
    ).toBe("PRODUCT_UNAVAILABLE");
  });
});

describe("book_slot", () => {
  it("uses the current consented seller mapping and snapshots platform routing for a deposit", async () => {
    const { shop, service, technician } = await createWorkshop(getDb(), {
      paypalCredentialRef: "PAYPAL_PLATFORM",
      paypalMerchantId: "STALE_LEGACY_SELLER",
    });
    const ownerId = randomUUID();
    const trackingId = "verified-tracking-id-1234567890-abcdefghijklmno";
    const sellerMerchantId = "CONNECTEDSELLER123";
    const now = MONDAY_MORNING;
    await getDb().insert(sellerOwners).values({
      id: ownerId,
      username: `owner-${randomUUID().slice(0, 8)}`,
      passwordHash: `scrypt$16384$8$1$${"A".repeat(22)}$${"B".repeat(43)}`,
    });
    await getDb().insert(shopMemberships).values({ ownerId, shopId: shop.id });
    await getDb().insert(paypalMerchantConnections).values({
      shopId: shop.id,
      consentedByOwnerId: ownerId,
      shareDataConsentAt: now,
      status: "ready",
      trackingId,
      requestKeyHash: "2".repeat(64),
      sellerMerchantId,
      statusEvidence: {
        merchantId: sellerMerchantId,
        trackingId,
        paymentsReceivable: true,
        primaryEmailConfirmed: true,
        consentGranted: true,
        activeProducts: ["EXPRESS_CHECKOUT"],
        grantedScopes: ["https://uri.paypal.com/services/payments/payment/authcapture"],
      },
      createdAt: now,
      updatedAt: now,
    });

    harness.bookingDeps.paypalFor = createPayPalProvider({
      PAYPAL_PLATFORM_CLIENT_ID: "sandbox-platform-client-id",
      PAYPAL_PLATFORM_CLIENT_SECRET: "sandbox-platform-client-secret",
      PAYPAL_PARTNER_ATTRIBUTION_ID: "AGENT_SHELF_BN_CODE",
    }, harness.paypal.adapter);
    const slotId = await slotAt(getDb(), harness, { shop, service, technician }, NOON_SLOT);
    const held = await book(getDb(), harness, slotId, service.id);
    const order = await readOrder(getDb(), held.orderId);

    expect(order).toMatchObject({
      payeeMerchantId: sellerMerchantId,
      paypalCredentialRef: "PAYPAL_PLATFORM",
    });
    const [request] = harness.paypal.createRequests();
    const [unit] = harness.paypal.bodyOf(request).purchase_units;
    expect(unit.payee.merchant_id).toBe(sellerMerchantId);
    const expectedAssertion = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64")}.${Buffer.from(JSON.stringify({ iss: "sandbox-platform-client-id", payer_id: sellerMerchantId })).toString("base64")}.`;
    expect(request.headers).toMatchObject({
      "PayPal-Partner-Attribution-Id": "AGENT_SHELF_BN_CODE",
      "PayPal-Auth-Assertion": expectedAssertion,
    });
    expect(harness.paypal.captureRequests()).toHaveLength(0);
  });

  it("holds the slot, states the money and takes none of it", async () => {
    const { held, service, technician, paypalOrderId } = await holdNoon();

    expect(held).toMatchObject({
      expiresAt: new Date(MONDAY_MORNING.getTime() + HOLD_MS).toISOString(),
      depositMinor: 2000,
      remainingMinor: 6000,
      currency: "EUR",
    });
    expect(held.approvalUrl).toContain(paypalOrderId);

    const booking = await readBooking(getDb(), held.bookingId);
    expect(booking).toMatchObject({
      status: "held",
      serviceId: service.id,
      technicianId: technician.id,
      orderId: held.orderId,
      startsAt: NOON_SLOT,
      endsAt: ONE_PM_SLOT,
      servicePriceMinor: 8000,
      depositCaptureId: null,
    });
    expect(await readOrder(getDb(), held.orderId)).toMatchObject({
      kind: "booking_deposit",
      paymentStatus: "pending",
      totalMinor: 2000,
      payeeMerchantId: MERCHANT_ID,
    });
    expect(harness.paypal.captureRequests()).toHaveLength(0);
  });

  it("asks PayPal for the deposit, paid to the shop's own merchant", async () => {
    const { held } = await holdNoon();

    const [request] = harness.paypal.createRequests();
    const [unit] = harness.paypal.bodyOf(request).purchase_units;
    expect(harness.paypal.requestIdOf(request)).toBe(held.orderId);
    expect(unit.payee.merchant_id).toBe(MERCHANT_ID);
    expect(unit.amount.value).toBe("20.00");
    expect(unit.items).toEqual([
      expect.objectContaining({ name: "Deposit: Test repair", quantity: "1" }),
    ]);
  });

  it("gives one winner when requests for one slot race", async () => {
    const workshop = await createWorkshop(getDb());
    const slotId = await slotAt(getDb(), harness, workshop, NOON_SLOT);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        book(getDb(), harness, slotId, workshop.service.id),
      ),
    );

    const won = results.filter((result) => result.status === "fulfilled");
    expect(won).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect((result.reason as ServiceError).code).toBe("SLOT_UNAVAILABLE");
      }
    }
    // A loser leaves nothing behind, and PayPal never hears about it.
    expect(await countOf(bookings)).toBe(1);
    expect(await countOf(orders)).toBe(1);
    expect(await countOf(orderLines)).toBe(1);
    expect(harness.paypal.createRequests()).toHaveLength(1);
  });

  it("gives one winner when different services race for overlapping time", async () => {
    const workshop = await createWorkshop(getDb());
    const longer = await createService(getDb(), workshop.shop.id, {
      serviceDurationMinutes: 120,
    });
    const shorter = await createService(getDb(), workshop.shop.id, {
      serviceDurationMinutes: 30,
    });
    const requests = [
      [await slotAt(getDb(), harness, workshop, NOON_SLOT), workshop.service.id],
      [
        await slotAt(
          getDb(),
          harness,
          { ...workshop, service: longer },
          new Date(NOON_SLOT.getTime() - minutes(30)),
        ),
        longer.id,
      ],
      [
        await slotAt(
          getDb(),
          harness,
          { ...workshop, service: shorter },
          new Date(NOON_SLOT.getTime() + minutes(30)),
        ),
        shorter.id,
      ],
    ];

    const results = await Promise.allSettled(
      requests.flatMap(([slotId, serviceId]) =>
        Array.from({ length: 3 }, () => book(getDb(), harness, slotId, serviceId)),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await liveBookings()).toHaveLength(1);
  });

  it("lets different technicians and adjacent times go through together", async () => {
    const workshop = await createWorkshop(getDb());
    const other = await createTechnician(getDb(), workshop.shop.id);
    await openEveryDay(getDb(), other);
    const slots = [
      await slotAt(getDb(), harness, { ...workshop, technician: other }, NOON_SLOT),
      await slotAt(getDb(), harness, workshop, NOON_SLOT),
      await slotAt(getDb(), harness, workshop, ONE_PM_SLOT),
    ];

    await Promise.all(
      slots.map((slotId) => book(getDb(), harness, slotId, workshop.service.id)),
    );

    expect(await liveBookings()).toHaveLength(3);
  });

  it("answers concurrent repeats of one key with one booking and one payment", async () => {
    const workshop = await createWorkshop(getDb());
    const slotId = await slotAt(getDb(), harness, workshop, NOON_SLOT);
    const key = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        book(getDb(), harness, slotId, workshop.service.id, key),
      ),
    );

    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(await countOf(bookings)).toBe(1);
    expect(await countOf(orders)).toBe(1);
    expect(harness.paypal.createdOrders()).toHaveLength(1);
  });

  it("answers a later repeat from what is stored, whatever has changed", async () => {
    const workshop = await createWorkshop(getDb());
    const slotId = await slotAt(getDb(), harness, workshop, NOON_SLOT);
    const key = randomUUID();
    const first = await book(getDb(), harness, slotId, workshop.service.id, key);

    await getDb()
      .update(products)
      .set({ priceMinor: 9000, depositMinor: 3000, serviceDurationMinutes: 90 })
      .where(eq(products.id, workshop.service.id));
    await getDb().delete(technicianWindows);
    harness.advance(minutes(5));

    expect(await book(getDb(), harness, slotId, workshop.service.id, key)).toEqual(first);
    expect(harness.paypal.createRequests()).toHaveLength(1);
  });

  it("refuses one key for a different slot", async () => {
    const workshop = await createWorkshop(getDb());
    const key = randomUUID();
    const noon = await slotAt(getDb(), harness, workshop, NOON_SLOT);
    await book(getDb(), harness, noon, workshop.service.id, key);
    const onePm = await slotAt(getDb(), harness, workshop, ONE_PM_SLOT);

    expect(
      await codeOf(book(getDb(), harness, onePm, workshop.service.id, key)),
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(await countOf(bookings)).toBe(1);
  });

  it("cannot reach a purchase order through its key", async () => {
    const workshop = await createWorkshop(getDb());
    const cable = await createTrackedProduct(getDb(), workshop.shop.id);
    const key = randomUUID();
    await createCheckout(
      getDb(),
      {
        items: [{ productId: cable.id, quantity: 1 }],
        idempotencyKey: `booking:${key}`,
      },
      harness.bookingDeps,
    );
    const slotId = await slotAt(getDb(), harness, workshop, NOON_SLOT);

    expect(
      await codeOf(book(getDb(), harness, slotId, workshop.service.id, key)),
    ).toBe("IDEMPOTENCY_CONFLICT");

    // The same key in both tools makes two separate orders.
    const shared = randomUUID();
    const plain = await createCheckout(
      getDb(),
      { items: [{ productId: cable.id, quantity: 1 }], idempotencyKey: shared },
      harness.bookingDeps,
    );
    const booked = await book(getDb(), harness, slotId, workshop.service.id, shared);
    expect(booked.orderId).not.toBe(plain.orderId);
  });

  it("refuses a client price or any other unknown field", async () => {
    const workshop = await createWorkshop(getDb());
    const slotId = await slotAt(getDb(), harness, workshop, NOON_SLOT);
    expect(
      await codeOf(
        bookSlot(
          getDb(),
          {
            slotId,
            serviceId: workshop.service.id,
            idempotencyKey: randomUUID(),
            depositMinor: 1,
          },
          harness.bookingDeps,
        ),
      ),
    ).toBe("INVALID_INPUT");
    expect(await countOf(orders)).toBe(0);
  });

  it("checks a slot against the windows rather than trusting its ID", async () => {
    const workshop = await createWorkshop(getDb());
    const { service, technician } = workshop;
    const reference = {
      serviceId: service.id,
      technicianId: technician.id,
      startsAt: NOON_SLOT,
      durationMinutes: 60,
    };
    const otherShop = await createWorkshop(getDb(), {
      paypalMerchantId: "OTHERSHOPMERCHANT",
    });

    const refused = [
      "not-a-slot",
      // Off the step.
      encodeSlotId({ ...reference, startsAt: new Date(NOON_SLOT.getTime() + minutes(10)) }),
      // 03:00 in the morning.
      encodeSlotId({ ...reference, startsAt: new Date("2026-11-10T01:00:00Z") }),
      // In the past, and within the lead time.
      encodeSlotId({ ...reference, startsAt: new Date("2026-11-08T10:00:00Z") }),
      encodeSlotId({ ...reference, startsAt: new Date(MONDAY_MORNING.getTime() + minutes(30)) }),
      // Running past the end of the day.
      encodeSlotId({ ...reference, startsAt: new Date("2026-11-09T15:30:00Z") }),
      // A shorter or longer appointment than this service takes.
      encodeSlotId({ ...reference, durationMinutes: 30 }),
      encodeSlotId({ ...reference, durationMinutes: 90 }),
      // Another service, and another shop's technician.
      encodeSlotId({ ...reference, serviceId: otherShop.service.id }),
      encodeSlotId({ ...reference, technicianId: otherShop.technician.id }),
    ];
    for (const slotId of refused) {
      expect(await codeOf(book(getDb(), harness, slotId, service.id))).toBe(
        "SLOT_UNAVAILABLE",
      );
    }
    expect(await countOf(bookings)).toBe(0);
    expect(await countOf(orders)).toBe(0);
  });

  it("refuses a slot once the service has changed its duration", async () => {
    const workshop = await createWorkshop(getDb());
    const slotId = await slotAt(getDb(), harness, workshop, NOON_SLOT);
    await getDb()
      .update(products)
      .set({ serviceDurationMinutes: 90 })
      .where(eq(products.id, workshop.service.id));
    expect(
      await codeOf(book(getDb(), harness, slotId, workshop.service.id)),
    ).toBe("SLOT_UNAVAILABLE");
  });

  it("refuses a service unpublished after its slot was offered", async () => {
    const workshop = await createWorkshop(getDb());
    const slotId = await slotAt(getDb(), harness, workshop, NOON_SLOT);
    await getDb()
      .update(products)
      .set({ status: "unpublished" })
      .where(eq(products.id, workshop.service.id));
    expect(
      await codeOf(book(getDb(), harness, slotId, workshop.service.id)),
    ).toBe("PRODUCT_NOT_FOUND");
  });

  it("stores nothing for a shop that cannot take the payment", async () => {
    const noMerchant = await createWorkshop(getDb(), { paypalMerchantId: null });
    const noCredentials = await createWorkshop(getDb(), {
      paypalMerchantId: "NOCREDENTIALS1",
      paypalCredentialRef: "NOT_CONFIGURED",
    });
    for (const workshop of [noMerchant, noCredentials]) {
      const slotId = await slotAt(getDb(), harness, workshop, NOON_SLOT);
      expect(
        await codeOf(book(getDb(), harness, slotId, workshop.service.id)),
      ).toBe("PAYMENT_NOT_CONFIGURED");
    }
    expect(await countOf(bookings)).toBe(0);
    expect(await countOf(orders)).toBe(0);
  });

  it("keeps the hold when PayPal does not answer, and a retry finds the same booking", async () => {
    const workshop = await createWorkshop(getDb());
    const slotId = await slotAt(getDb(), harness, workshop, NOON_SLOT);
    const key = randomUUID();
    harness.paypal.nextOrder({ type: "timeout", orderCreated: true });

    expect(
      await codeOf(book(getDb(), harness, slotId, workshop.service.id, key)),
    ).toBe("PAYMENT_TIMEOUT");
    expect(await liveBookings()).toHaveLength(1);
    // Nobody else can take it meanwhile.
    expect(
      await codeOf(book(getDb(), harness, slotId, workshop.service.id)),
    ).toBe("SLOT_UNAVAILABLE");

    const retried = await book(getDb(), harness, slotId, workshop.service.id, key);

    const [first, second] = harness.paypal.createRequests();
    expect(harness.paypal.requestIdOf(second)).toBe(harness.paypal.requestIdOf(first));
    expect(harness.paypal.createdOrders()).toHaveLength(1);
    expect(retried.bookingId).toBe((await liveBookings())[0].id);
    expect(await countOf(bookings)).toBe(1);
  });

  it("releases the hold when PayPal refuses the order", async () => {
    const workshop = await createWorkshop(getDb());
    const slotId = await slotAt(getDb(), harness, workshop, NOON_SLOT);
    const key = randomUUID();
    harness.paypal.nextOrder({
      type: "respond",
      status: 422,
      body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REFUSED" }] },
    });

    expect(
      await codeOf(book(getDb(), harness, slotId, workshop.service.id, key)),
    ).toBe("PAYMENT_DECLINED");
    expect(await liveBookings()).toHaveLength(0);

    // The same answer for the same key, and the slot is open to anyone else.
    expect(
      await codeOf(book(getDb(), harness, slotId, workshop.service.id, key)),
    ).toBe("PAYMENT_DECLINED");
    await book(getDb(), harness, slotId, workshop.service.id);
    expect(await liveBookings()).toHaveLength(1);
  });
});

describe("hold expiry", () => {
  it("expires exactly at its time, whether or not the sweep has run", async () => {
    const { held, slotId, service } = await holdNoon();
    const statusNow = async () =>
      (await getOrderBooking(getDb(), held.orderId, harness.now()))?.status;

    harness.setNow(new Date(new Date(held.expiresAt).getTime() - 1));
    expect(await statusNow()).toBe("held");
    expect(await codeOf(book(getDb(), harness, slotId, service.id))).toBe(
      "SLOT_UNAVAILABLE",
    );

    harness.setNow(new Date(held.expiresAt));
    expect(await statusNow()).toBe("expired");
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("held");

    const next = await book(getDb(), harness, slotId, service.id);
    expect(next.bookingId).not.toBe(held.bookingId);
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("expired");
  });

  it("gives one winner when requests race for a slot behind a stale hold", async () => {
    const { held, slotId, service } = await holdNoon();
    harness.advance(HOLD_MS);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => book(getDb(), harness, slotId, service.id)),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("expired");
    expect(await liveBookings()).toHaveLength(1);
  });

  it("is expired by the sweep and leaves live holds alone", async () => {
    const workshop = await createWorkshop(getDb());
    const { held } = await holdNoon(workshop);
    const onePm = await slotAt(getDb(), harness, workshop, ONE_PM_SLOT);
    harness.advance(minutes(10));
    const later = await book(getDb(), harness, onePm, workshop.service.id);

    harness.advance(minutes(5));
    expect(await expireHolds(getDb(), harness.now())).toBe(1);
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("expired");
    expect((await readBooking(getDb(), later.bookingId)).status).toBe("held");

    expect(await expireHolds(getDb(), harness.now())).toBe(0);
  });

  it("is part of the order sweep", async () => {
    const { held } = await holdNoon();
    await getDb()
      .update(bookings)
      .set({ holdExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(bookings.id, held.bookingId));

    await sweepOpenOrders(getDb(), harness.reconcileDeps);

    expect((await readBooking(getDb(), held.bookingId)).status).toBe("expired");
  });

  it("only expires this technician's holds on a new hold", async () => {
    const workshop = await createWorkshop(getDb());
    const other = await createTechnician(getDb(), workshop.shop.id);
    await openEveryDay(getDb(), other);
    const theirs = await book(
      getDb(),
      harness,
      await slotAt(getDb(), harness, { ...workshop, technician: other }, NOON_SLOT),
      workshop.service.id,
    );
    harness.advance(HOLD_MS);

    await book(
      getDb(),
      harness,
      await slotAt(getDb(), harness, workshop, NOON_SLOT),
      workshop.service.id,
    );

    expect((await readBooking(getDb(), theirs.bookingId)).status).toBe("held");
  });

  it("refuses a repeat once the hold has ended, and keeps the old booking", async () => {
    const workshop = await createWorkshop(getDb());
    const slotId = await slotAt(getDb(), harness, workshop, NOON_SLOT);
    const key = randomUUID();
    await book(getDb(), harness, slotId, workshop.service.id, key);

    harness.advance(HOLD_MS);
    expect(
      await codeOf(book(getDb(), harness, slotId, workshop.service.id, key)),
    ).toBe("BOOKING_HOLD_ENDED");

    await expireHolds(getDb(), harness.now());
    expect(
      await codeOf(book(getDb(), harness, slotId, workshop.service.id, key)),
    ).toBe("BOOKING_HOLD_ENDED");
    expect(await countOf(bookings)).toBe(1);
    expect(harness.paypal.createRequests()).toHaveLength(1);
  });

  it("leaves an unpaid order for the sweep to keep asking about", async () => {
    const { held } = await holdNoon();
    harness.advance(HOLD_MS);
    await expireHolds(getDb(), harness.now());
    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("pending");
  });
});

describe("a verified deposit", () => {
  it("confirms the booking with the capture on record", async () => {
    const { held, paypalOrderId } = await holdNoon();
    harness.paypal.approve(paypalOrderId);
    harness.advance(minutes(5));

    await settle(held.orderId);

    const order = await readOrder(getDb(), held.orderId);
    expect(order.paymentStatus).toBe("paid");
    expect(await readBooking(getDb(), held.bookingId)).toMatchObject({
      status: "confirmed",
      depositCaptureId: order.paypalCaptureId,
      reviewReason: null,
    });
    expect(order.paypalCaptureId).toBe(harness.paypal.captureIdOf(paypalOrderId));
  });

  it("is wired into the default reconciliation", async () => {
    harness.setNow(new Date());
    const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const workshop = await createWorkshop(getDb());
    const { slots } = await getSlots(getDb(), {
      shopId: workshop.shop.id,
      serviceId: workshop.service.id,
      from: start.toISOString(),
      to: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    });
    const held = await book(getDb(), harness, slots[0].slotId, workshop.service.id);
    const paypalOrderId = await paypalIdOf(getDb(), held.orderId);
    harness.paypal.approve(paypalOrderId);

    await reconcileOrder(getDb(), held.orderId, {
      ...defaultReconcileDeps,
      paypalFor: harness.reconcileDeps.paypalFor,
    });

    expect((await readBooking(getDb(), held.bookingId)).status).toBe("confirmed");
  });

  it("does not confirm on approval alone", async () => {
    const { held, paypalOrderId } = await holdNoon();
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: false });

    await settle(held.orderId).catch(() => {});

    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("approved");
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("held");
  });

  it("does not confirm on a capture still pending at PayPal", async () => {
    const { held, paypalOrderId } = await holdNoon();
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "capture_status", status: "PENDING" });

    await settle(held.orderId);

    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("approved");
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("held");

    harness.paypal.setCaptureStatus(paypalOrderId, "COMPLETED");
    await settle(held.orderId);
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("confirmed");
  });

  it("confirms once however many reconciliations race", async () => {
    const { held, paypalOrderId } = await holdNoon();
    harness.paypal.approve(paypalOrderId);

    await Promise.all(Array.from({ length: 8 }, () => settle(held.orderId)));

    expect(harness.paypal.charges()).toBe(1);
    const booking = await readBooking(getDb(), held.bookingId);
    expect(booking.status).toBe("confirmed");
    expect(booking.depositCaptureId).toBe(harness.paypal.captureIdOf(paypalOrderId));
  });

  it("still blocks the slot, and a repeat of its key returns the same booking", async () => {
    const workshop = await createWorkshop(getDb());
    const slotId = await slotAt(getDb(), harness, workshop, NOON_SLOT);
    const key = randomUUID();
    const held = await book(getDb(), harness, slotId, workshop.service.id, key);
    harness.paypal.approve(await paypalIdOf(getDb(), held.orderId));
    await settle(held.orderId);

    harness.advance(HOLD_MS * 2);
    await expireHolds(getDb(), harness.now());

    expect((await readBooking(getDb(), held.bookingId)).status).toBe("confirmed");
    expect(await codeOf(book(getDb(), harness, slotId, workshop.service.id))).toBe(
      "SLOT_UNAVAILABLE",
    );
    expect(await book(getDb(), harness, slotId, workshop.service.id, key)).toEqual(held);
    const { slots } = await getSlots(
      getDb(),
      {
        shopId: workshop.shop.id,
        serviceId: workshop.service.id,
        from: NOON_SLOT.toISOString(),
        to: ONE_PM_SLOT.toISOString(),
      },
      harness.now(),
    );
    expect(slots).toEqual([]);
  });

  it("leaves a purchase order's path alone", async () => {
    const workshop = await createWorkshop(getDb());
    const cable = await createTrackedProduct(getDb(), workshop.shop.id);
    const { orderId } = await createCheckout(
      getDb(),
      { items: [{ productId: cable.id, quantity: 1 }], idempotencyKey: randomUUID() },
      harness.bookingDeps,
    );
    harness.paypal.approve(await paypalIdOf(getDb(), orderId));

    await settle(orderId);

    expect((await readOrder(getDb(), orderId)).paymentStatus).toBe("paid");
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("an approval after the hold has ended", () => {
  it.each([
    ["while the expired hold is still marked held", false],
    ["after the hold was marked expired", true],
  ])("charges nothing and closes the order, %s", async (_name, swept) => {
    const { held, paypalOrderId, slotId, service } = await holdNoon();
    harness.advance(HOLD_MS);
    if (swept) {
      await expireHolds(getDb(), harness.now());
    }
    harness.paypal.approve(paypalOrderId);

    await settle(held.orderId);

    expect(harness.paypal.charges()).toBe(0);
    const order = await readOrder(getDb(), held.orderId);
    expect(order.paymentStatus).toBe("cancelled");
    expect(order.paypalCaptureId).toBeNull();
    expect(await readBooking(getDb(), held.bookingId)).toMatchObject({
      status: "expired",
      depositCaptureId: null,
      reviewReason: null,
    });
    // The time is free to be sold again.
    await book(getDb(), harness, slotId, service.id);
    expect(await liveBookings()).toHaveLength(1);
  });

  it("counts the exact moment of expiry as ended", async () => {
    const { held, paypalOrderId } = await holdNoon();
    harness.setNow(new Date(held.expiresAt));
    harness.paypal.approve(paypalOrderId);

    await settle(held.orderId);

    expect(harness.paypal.charges()).toBe(0);
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("expired");
  });

  it("still charges and confirms just before expiry", async () => {
    const { held, paypalOrderId } = await holdNoon();
    harness.setNow(new Date(new Date(held.expiresAt).getTime() - 1));
    harness.paypal.approve(paypalOrderId);

    await settle(held.orderId);

    expect(harness.paypal.charges()).toBe(1);
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("confirmed");
  });

  it("stays uncharged however often and from wherever it is asked about", async () => {
    const { held, paypalOrderId } = await holdNoon();
    harness.advance(HOLD_MS);
    harness.paypal.approve(paypalOrderId);
    await getDb()
      .update(orders)
      .set({ createdAt: sql`now() - interval '10 minutes'` })
      .where(eq(orders.id, held.orderId));

    await sweepOpenOrders(getDb(), harness.reconcileDeps);
    await settle(held.orderId);
    await settle(held.orderId);
    await sweepOpenOrders(getDb(), harness.reconcileDeps);

    expect(harness.paypal.charges()).toBe(0);
    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("cancelled");
  });

  it("closes an order nobody approved, and a later approval charges nothing", async () => {
    const { held, paypalOrderId } = await holdNoon();
    harness.advance(HOLD_MS);

    await settle(held.orderId);

    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("cancelled");
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("expired");

    harness.paypal.approve(paypalOrderId);
    await settle(held.orderId);

    expect(harness.paypal.charges()).toBe(0);
    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("cancelled");
  });

  it("charges only the buyer who holds the time when the slot is sold again", async () => {
    const { held, paypalOrderId, slotId, service } = await holdNoon();
    harness.advance(HOLD_MS);
    const second = await book(getDb(), harness, slotId, service.id);
    harness.paypal.approve(await paypalIdOf(getDb(), second.orderId));
    await settle(second.orderId);

    harness.paypal.approve(paypalOrderId);
    await settle(held.orderId);

    expect(harness.paypal.charges()).toBe(1);
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("expired");
    expect((await readBooking(getDb(), second.bookingId)).status).toBe("confirmed");
    expect(await liveBookings()).toHaveLength(1);
  });

  it("does not try again when a capture was attempted before the hold ended", async () => {
    const { held, paypalOrderId } = await holdNoon();
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: false });
    await settle(held.orderId).catch(() => {});
    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("approved");

    harness.advance(HOLD_MS);
    await settle(held.orderId);

    expect(harness.paypal.charges()).toBe(0);
    // Its outcome is still open, so the sweep keeps asking rather than closing it.
    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("approved");
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("expired");
  });

  it("keeps a refused deposit capture open while its hold is live, then charges nothing", async () => {
    const { held, paypalOrderId } = await holdNoon();
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "respond", status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] } });
    await settle(held.orderId).catch(() => {});
    // Another capture of this order may be in progress at PayPal, so a refusal proves nothing.
    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("approved");
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("held");

    harness.setNow(
      new Date(new Date(held.expiresAt).getTime() + minutes(BOOKING_POLICY.captureSettleMinutes)),
    );
    await settle(held.orderId);

    expect(harness.paypal.charges()).toBe(0);
    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("cancelled");
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("expired");
  });

  it("does not release the time when a capture is refused while another is in progress", async () => {
    const { held, paypalOrderId, slotId, service } = await holdNoon();
    harness.paypal.approve(paypalOrderId);
    const base = harness.reconcileDeps;
    let interleaved = false;
    const first = {
      ...base,
      gateDepositCapture: async (...args: Parameters<typeof base.gateDepositCapture>) => {
        const decision = await base.gateDepositCapture(...args);
        if (!interleaved && decision.action === "capture") {
          interleaved = true;
          // A webhook's reconciliation sends the same capture first, and its answer is lost.
          harness.paypal.nextCapture({ type: "timeout", captured: false });
          await reconcileOrder(getDb(), held.orderId, base).catch(() => {});
          // This reconciliation's own request is then refused while that one is in progress.
          harness.paypal.nextCapture({ type: "respond", status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] } });
        }
        return decision;
      },
    };
    await reconcileOrder(getDb(), held.orderId, first).catch(() => {});

    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("approved");
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("held");
    expect(await codeOf(book(getDb(), harness, slotId, service.id))).toBe("SLOT_UNAVAILABLE");

    // The capture sent inside the hold completes, and the booking stands.
    await landEarlierCapture(harness, paypalOrderId, held.orderId);
    await settle(held.orderId);
    expect(harness.paypal.charges()).toBe(1);
    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("paid");
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("confirmed");
  });

  it("is what the running service does, with its default dependencies", async () => {
    const { held, paypalOrderId } = await holdNoon();
    await getDb()
      .update(bookings)
      .set({ holdExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(bookings.id, held.bookingId));
    harness.paypal.approve(paypalOrderId);

    await reconcileOrder(getDb(), held.orderId, {
      ...defaultReconcileDeps,
      paypalFor: harness.reconcileDeps.paypalFor,
    });

    expect(harness.paypal.charges()).toBe(0);
    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("cancelled");
  });

  it("is settled one of the known ways however an approval and an expiry race", async () => {
    for (let round = 0; round < 6; round += 1) {
      const workshop = await createWorkshop(getDb(), {
        paypalMerchantId: `RACEMERCHANT${round}`,
      });
      const charged = harness.paypal.charges();
      const { held, paypalOrderId } = await holdNoon(workshop);
      harness.paypal.approve(paypalOrderId);

      // The capture reads its clock inside the hold, and the sweep's clock is already past it.
      await Promise.all([
        settle(held.orderId),
        expireHolds(getDb(), new Date(new Date(held.expiresAt).getTime() + 1)),
      ]);

      const order = await readOrder(getDb(), held.orderId);
      const booking = await readBooking(getDb(), held.bookingId);
      if (harness.paypal.charges() === charged) {
        expect(order.paymentStatus).toBe("cancelled");
        expect(booking.status).toBe("expired");
      } else {
        expect(order.paymentStatus).toBe("paid");
        expect(booking.depositCaptureId).toBe(order.paypalCaptureId);
        expect(["confirmed", "review_required"]).toContain(booking.status);
      }
    }
  });

  it("reports what happened through the status tool", async () => {
    const { held, paypalOrderId } = await holdNoon();
    harness.advance(HOLD_MS);
    harness.paypal.approve(paypalOrderId);
    await settle(held.orderId);

    const status = await getOrderStatus(
      getDb(),
      { orderId: held.orderId, statusToken: held.statusToken },
      harness.now(),
    );

    expect(status.paymentStatus).toBe("cancelled");
    expect(status.booking).toMatchObject({ status: "expired", depositMinor: 2000 });
  });
});

describe("a capture PayPal had already made when the hold ended", () => {
  it("goes to review with the money on record, if the hold ended during it", async () => {
    const { held, slotId, service } = await holdNoon();

    await captureAcrossExpiry(getDb(), harness, held.orderId, HOLD_MS);

    expect(harness.paypal.charges()).toBe(1);
    const order = await readOrder(getDb(), held.orderId);
    expect(order.paymentStatus).toBe("paid");
    expect(order.paypalCaptureId).toBeTruthy();
    expect(await readBooking(getDb(), held.bookingId)).toMatchObject({
      status: "review_required",
      reviewReason: "late_capture",
      depositCaptureId: order.paypalCaptureId,
    });
    // It claims no time, so the slot can still be sold.
    await book(getDb(), harness, slotId, service.id);
    expect(await liveBookings()).toHaveLength(1);
  });

  it("goes to review if its answer was lost until after the hold ended", async () => {
    const { held, paypalOrderId } = await holdNoon();
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: true });
    harness.paypal.nextRead({ type: "change", change: (order) => order });
    harness.paypal.nextRead({ type: "timeout" });
    await settle(held.orderId).catch(() => {});
    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("approved");

    harness.advance(HOLD_MS);
    await settle(held.orderId);

    expect(harness.paypal.charges()).toBe(1);
    const order = await readOrder(getDb(), held.orderId);
    expect(order.paymentStatus).toBe("paid");
    expect(await readBooking(getDb(), held.bookingId)).toMatchObject({
      status: "review_required",
      reviewReason: "late_capture",
      depositCaptureId: order.paypalCaptureId,
    });
  });

  it("never double-books when someone else has paid for the slot meanwhile", async () => {
    const { held, paypalOrderId, slotId, service } = await holdNoon();
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: true });
    harness.paypal.nextRead({ type: "change", change: (order) => order });
    harness.paypal.nextRead({ type: "timeout" });
    await settle(held.orderId).catch(() => {});

    harness.advance(HOLD_MS);
    const second = await book(getDb(), harness, slotId, service.id);
    harness.paypal.approve(await paypalIdOf(getDb(), second.orderId));
    await settle(second.orderId);
    await settle(held.orderId);

    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("paid");
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("review_required");
    expect((await readBooking(getDb(), second.bookingId)).status).toBe("confirmed");
    expect(await liveBookings()).toHaveLength(1);
    expect(harness.paypal.charges()).toBe(2);
  });

  it("names a capture that arrives after a cancel as its own reason", async () => {
    const { held } = await holdNoon();
    await settle(held.orderId, { buyerCancelled: true });
    const [order] = await getDb()
      .update(orders)
      .set({ paymentStatus: "paid", paypalCaptureId: "CAPTURE1" })
      .where(eq(orders.id, held.orderId))
      .returning();

    await getDb().transaction((tx) => confirmBookingPayment(tx, order, harness.now()));

    expect(await readBooking(getDb(), held.bookingId)).toMatchObject({
      status: "review_required",
      reviewReason: "captured_after_cancel",
      depositCaptureId: "CAPTURE1",
    });
  });

  it("reports what happened through the status tool, without the capture", async () => {
    const { held, paypalOrderId } = await holdNoon();
    await captureAcrossExpiry(getDb(), harness, held.orderId, HOLD_MS);

    const status = await getOrderStatus(
      getDb(),
      { orderId: held.orderId, statusToken: held.statusToken },
      harness.now(),
    );

    expect(status.paymentStatus).toBe("paid");
    expect(status.booking).toEqual({
      bookingId: held.bookingId,
      status: "review_required",
      reviewReason: "late_capture",
      startsAt: NOON_SLOT.toISOString(),
      endsAt: ONE_PM_SLOT.toISOString(),
      expiresAt: held.expiresAt,
      timezone: "Europe/Riga",
      depositMinor: 2000,
      remainingMinor: 6000,
    });
    expect(JSON.stringify(status)).not.toContain(
      harness.paypal.captureIdOf(paypalOrderId) as string,
    );
  });
});

describe("a deposit left approved by a capture with no known outcome", () => {
  const SETTLE_MS = minutes(BOOKING_POLICY.captureSettleMinutes);

  // The buyer approves inside the hold, and the capture's request never reaches PayPal in time.
  async function approvedWithLostCapture(workshop?: Awaited<ReturnType<typeof createWorkshop>>) {
    const context = await holdNoon(workshop);
    harness.paypal.approve(context.paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: false });
    await settle(context.held.orderId).catch(() => {});
    expect((await readOrder(getDb(), context.held.orderId)).paymentStatus).toBe("approved");
    return context;
  }

  it("closes with nothing charged once a capture sent inside the hold can no longer land", async () => {
    const { held } = await approvedWithLostCapture();
    const holdEnd = new Date(held.expiresAt).getTime();

    harness.setNow(new Date(holdEnd + SETTLE_MS - 1));
    await settle(held.orderId);
    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("approved");

    harness.setNow(new Date(holdEnd + SETTLE_MS));
    await settle(held.orderId);

    expect(harness.paypal.charges()).toBe(0);
    expect(harness.paypal.captureRequests()).toHaveLength(1);
    const order = await readOrder(getDb(), held.orderId);
    expect(order).toMatchObject({ paymentStatus: "cancelled", paypalCaptureId: null });
    expect(await readBooking(getDb(), held.bookingId)).toMatchObject({
      status: "expired",
      depositCaptureId: null,
    });
    const status = await getOrderStatus(
      getDb(),
      { orderId: held.orderId, statusToken: held.statusToken },
      harness.now(),
    );
    expect(status.paymentStatus).toBe("cancelled");
    expect(status.booking?.status).toBe("expired");
  });

  it("is settled by the sweep, with no request from the buyer", async () => {
    const { held } = await approvedWithLostCapture();
    harness.advance(HOLD_MS + SETTLE_MS);
    await getDb()
      .update(orders)
      .set({ createdAt: sql`now() - interval '30 minutes'` })
      .where(eq(orders.id, held.orderId));

    await sweepOpenOrders(getDb(), harness.reconcileDeps);

    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("cancelled");
    expect(harness.paypal.charges()).toBe(0);
  });

  it("does not close an order with a capture on record, even a pending one", async () => {
    const { held, paypalOrderId } = await holdNoon();
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "capture_status", status: "PENDING" });
    await settle(held.orderId);
    harness.advance(HOLD_MS + SETTLE_MS);

    await settle(held.orderId);
    // Even a reading that contradicts it does not close an order with a capture on record.
    harness.paypal.nextRead({
      type: "change",
      change: (order) => {
        delete (order.purchase_units as Record<string, unknown>[])[0].payments;
        return { ...order, status: "APPROVED" };
      },
    });
    await settle(held.orderId);

    const order = await readOrder(getDb(), held.orderId);
    expect(order.paymentStatus).toBe("approved");
    expect(order.paypalCaptureId).toBe(harness.paypal.captureIdOf(paypalOrderId));
  });

  it("captures nothing for an order sent to review while it was being read", async () => {
    const { held, paypalOrderId } = await holdNoon();
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextRead({
      type: "change",
      change: async (order) => {
        await getDb()
          .update(orders)
          .set({ paymentStatus: "review_required" })
          .where(eq(orders.id, held.orderId));
        return order;
      },
    });

    await settle(held.orderId);

    expect(harness.paypal.captureRequests()).toHaveLength(0);
    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("review_required");
  });

  it("still records a capture that lands after it closed, as paid with the booking in review", async () => {
    const { held, paypalOrderId } = await approvedWithLostCapture();
    harness.advance(HOLD_MS + SETTLE_MS);
    await settle(held.orderId);
    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("cancelled");

    await landEarlierCapture(harness, paypalOrderId, held.orderId);
    await settle(held.orderId);

    expect(harness.paypal.charges()).toBe(1);
    const order = await readOrder(getDb(), held.orderId);
    expect(order.paymentStatus).toBe("paid");
    expect(order.paypalCaptureId).toBe(harness.paypal.captureIdOf(paypalOrderId));
    expect(await readBooking(getDb(), held.bookingId)).toMatchObject({
      status: "review_required",
      reviewReason: "late_capture",
      depositCaptureId: order.paypalCaptureId,
    });
  });

  it.each([
    ["a declined instrument", 422, "INSTRUMENT_DECLINED"],
    ["an order PayPal calls not approved", 422, "ORDER_NOT_APPROVED"],
    ["an invalid request", 400, "INVALID_PARAMETER_VALUE"],
  ])(
    "is not closed by %s on a repeat while the first capture may be in progress",
    async (_name, status, issue) => {
      const { held, paypalOrderId } = await approvedWithLostCapture();
      harness.paypal.nextCapture({
        type: "respond",
        status,
        body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue }] },
      });

      expect(await codeOf(settle(held.orderId))).toBe("PAYMENT_UNAVAILABLE");

      expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("approved");
      expect((await readBooking(getDb(), held.bookingId)).status).toBe("held");

      // The first capture lands, inside the hold, and confirms the booking.
      await landEarlierCapture(harness, paypalOrderId, held.orderId);
      await settle(held.orderId);
      expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("paid");
      expect((await readBooking(getDb(), held.bookingId)).status).toBe("confirmed");
      expect(harness.paypal.charges()).toBe(1);
    },
  );

  it("closes uncharged after a refused repeat once nothing can land", async () => {
    const { held } = await approvedWithLostCapture();
    harness.paypal.nextCapture({
      type: "respond",
      status: 422,
      body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] },
    });
    await settle(held.orderId).catch(() => {});

    harness.advance(HOLD_MS + SETTLE_MS);
    await settle(held.orderId);

    expect(harness.paypal.charges()).toBe(0);
    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("cancelled");
  });

  it("is never reopened by a reconciliation that passed the hold check as it closed", async () => {
    for (let round = 0; round < 8; round += 1) {
      const workshop = await createWorkshop(getDb(), {
        paypalMerchantId: `REOPENMERCHANT${round}`,
      });
      const charged = harness.paypal.charges();
      const { held, paypalOrderId } = await holdNoon(workshop);
      harness.paypal.approve(paypalOrderId);

      // Any write that closes a pending order, such as the buyer's cancel or the sweep's close.
      const close = async () => {
        await new Promise((resolve) => setTimeout(resolve, round));
        return getDb()
          .update(orders)
          .set({ paymentStatus: "cancelled" })
          .where(and(eq(orders.id, held.orderId), eq(orders.paymentStatus, "pending")))
          .returning({ id: orders.id });
      };
      const [, closed] = await Promise.all([settle(held.orderId).catch(() => {}), close()]);

      const order = await readOrder(getDb(), held.orderId);
      if (closed.length > 0) {
        expect(order.paymentStatus).toBe("cancelled");
        expect(harness.paypal.charges()).toBe(charged);
        expect((await readBooking(getDb(), held.bookingId)).status).toBe("cancelled");
      } else {
        expect(order.paymentStatus).toBe("paid");
        expect((await readBooking(getDb(), held.bookingId)).status).toBe("confirmed");
      }
    }
  });
});

describe("a deposit in review with no capture on record", () => {
  // The sweep's three-day close sends an approved deposit to review while PayPal cannot be read.
  async function closedByTheSweep() {
    const context = await holdNoon();
    harness.paypal.approve(context.paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: false });
    await settle(context.held.orderId).catch(() => {});
    await getDb()
      .update(orders)
      .set({ createdAt: sql`now() - interval '73 hours'` })
      .where(eq(orders.id, context.held.orderId));
    harness.paypal.nextRead({ type: "timeout" });
    await sweepOpenOrders(getDb(), harness.reconcileDeps);
    const order = await readOrder(getDb(), context.held.orderId);
    expect(order).toMatchObject({ paymentStatus: "review_required", paypalCaptureId: null });
    return context;
  }

  it("records a capture that lands after the close, through a verified webhook", async () => {
    const { held, paypalOrderId, shop } = await closedByTheSweep();
    await landEarlierCapture(harness, paypalOrderId, held.orderId);
    const captures = harness.paypal.captureRequests().length;
    const rawBody = JSON.stringify({
      id: "WH-LATE-CAPTURE-1",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource_type: "capture",
      create_time: "2026-11-12T10:00:00Z",
      resource: {
        id: "SOMECAPTUREID",
        status: "COMPLETED",
        supplementary_data: { related_ids: { order_id: paypalOrderId } },
      },
    });

    const answer = await handlePayPalWebhook(
      getDb(),
      { shopSlug: shop.slug, rawBody, headers: harness.paypal.signDelivery(WEBHOOK_ID, rawBody) },
      harness.reconcileDeps,
    );

    expect(answer).toBe(200);
    expect(await readOrder(getDb(), held.orderId)).toMatchObject({
      paymentStatus: "review_required",
      paypalCaptureId: harness.paypal.captureIdOf(paypalOrderId),
    });
    expect(harness.paypal.captureRequests()).toHaveLength(captures);
    expect(harness.paypal.charges()).toBe(1);
  });

  it("records a capture whose payment lands as the sweep closes the order", async () => {
    const { held, paypalOrderId } = await holdNoon();
    harness.paypal.approve(paypalOrderId);
    harness.paypal.nextCapture({ type: "timeout", captured: false });
    await settle(held.orderId).catch(() => {});
    await landEarlierCapture(harness, paypalOrderId, held.orderId);
    // The sweep's close commits while this reconciliation reads the capture.
    harness.paypal.nextRead({
      type: "change",
      change: async (order) => {
        await getDb()
          .update(orders)
          .set({ paymentStatus: "review_required" })
          .where(eq(orders.id, held.orderId));
        return order;
      },
    });

    await settle(held.orderId);

    expect(await readOrder(getDb(), held.orderId)).toMatchObject({
      paymentStatus: "review_required",
      paypalCaptureId: harness.paypal.captureIdOf(paypalOrderId),
    });
  });

  it("asks nothing more once its capture is on record, and never captures", async () => {
    const { held, paypalOrderId } = await closedByTheSweep();
    await landEarlierCapture(harness, paypalOrderId, held.orderId);
    await settle(held.orderId);
    const reads = harness.paypal.readRequests().length;
    const captures = harness.paypal.captureRequests().length;

    await settle(held.orderId);

    expect(harness.paypal.readRequests()).toHaveLength(reads);
    expect(harness.paypal.captureRequests()).toHaveLength(captures);
    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("review_required");
  });

  it("captures nothing when PayPal still shows the approval", async () => {
    const { held } = await closedByTheSweep();
    const captures = harness.paypal.captureRequests().length;

    await settle(held.orderId);

    expect(harness.paypal.captureRequests()).toHaveLength(captures);
    expect(await readOrder(getDb(), held.orderId)).toMatchObject({
      paymentStatus: "review_required",
      paypalCaptureId: null,
    });
  });
});

describe("cancellation", () => {
  it("releases the hold when the buyer cancels", async () => {
    const { held, slotId, service } = await holdNoon();

    await settle(held.orderId, { buyerCancelled: true });

    expect((await readOrder(getDb(), held.orderId)).paymentStatus).toBe("cancelled");
    expect((await readBooking(getDb(), held.bookingId)).status).toBe("cancelled");
    await book(getDb(), harness, slotId, service.id);
    expect(await liveBookings()).toHaveLength(1);
  });

  it("refuses a repeat of its key and offers no link", async () => {
    const workshop = await createWorkshop(getDb());
    const slotId = await slotAt(getDb(), harness, workshop, NOON_SLOT);
    const key = randomUUID();
    const held = await book(getDb(), harness, slotId, workshop.service.id, key);
    await settle(held.orderId, { buyerCancelled: true });

    expect(
      await codeOf(book(getDb(), harness, slotId, workshop.service.id, key)),
    ).toBe("BOOKING_HOLD_ENDED");
  });

  it("charges nothing for an approval after cancelling, inside the hold's time too", async () => {
    const { held, paypalOrderId } = await holdNoon();
    await settle(held.orderId, { buyerCancelled: true });

    harness.paypal.approve(paypalOrderId);
    await settle(held.orderId);

    expect(harness.paypal.charges()).toBe(0);
    const order = await readOrder(getDb(), held.orderId);
    expect(order.paymentStatus).toBe("cancelled");
    expect(order.paypalCaptureId).toBeNull();
    expect(await readBooking(getDb(), held.bookingId)).toMatchObject({
      status: "cancelled",
      depositCaptureId: null,
      reviewReason: null,
    });
  });

  it("releases the hold when PayPal voids the order or refuses the capture", async () => {
    const voided = await holdNoon();
    harness.paypal.void(voided.paypalOrderId);
    await settle(voided.held.orderId);
    expect((await readBooking(getDb(), voided.held.bookingId)).status).toBe("cancelled");

    const refused = await holdNoon(
      await createWorkshop(getDb(), { paypalMerchantId: "REFUSEDMERCHANT1" }),
    );
    harness.paypal.approve(refused.paypalOrderId);
    harness.paypal.nextCapture({ type: "capture_status", status: "DECLINED" });
    await settle(refused.held.orderId);
    expect((await readOrder(getDb(), refused.held.orderId)).paymentStatus).toBe("failed");
    expect((await readBooking(getDb(), refused.held.bookingId)).status).toBe("cancelled");
  });

  it("leaves other bookings and a confirmed booking alone", async () => {
    const workshop = await createWorkshop(getDb());
    const { held: paid, paypalOrderId } = await holdNoon(workshop);
    harness.paypal.approve(paypalOrderId);
    await settle(paid.orderId);
    const onePm = await slotAt(getDb(), harness, workshop, ONE_PM_SLOT);
    const stillHeld = await book(getDb(), harness, onePm, workshop.service.id);

    // PayPal later reports a refund, so the order needs a person, and the appointment stays.
    harness.paypal.setCaptureStatus(paypalOrderId, "REFUNDED");
    await settle(paid.orderId);
    expect((await readOrder(getDb(), paid.orderId)).paymentStatus).toBe("review_required");
    expect((await readBooking(getDb(), paid.bookingId)).status).toBe("confirmed");

    await getDb()
      .update(orders)
      .set({ paymentStatus: "cancelled" })
      .where(eq(orders.id, paid.orderId));
    expect((await readBooking(getDb(), paid.bookingId)).status).toBe("confirmed");
    expect((await readBooking(getDb(), stillHeld.bookingId)).status).toBe("held");
  });
});

describe("confirmBookingPayment", () => {
  it("does not throw for a booking already settled", async () => {
    const { held, paypalOrderId } = await holdNoon();
    harness.paypal.approve(paypalOrderId);
    await settle(held.orderId);
    const order = await readOrder(getDb(), held.orderId);

    await getDb().transaction((tx) =>
      confirmBookingPayment(tx, order, harness.now()),
    );

    expect((await readBooking(getDb(), held.bookingId)).status).toBe("confirmed");
  });
});

describe("getShopSchedule", () => {
  const WHOLE_DAY = [
    new Date("2026-11-08T22:00:00Z"),
    new Date("2026-11-09T22:00:00Z"),
  ] as const;

  it("gives one view of technicians, working time and every booking state", async () => {
    const workshop = await createWorkshop(getDb());
    const { shop, service, technician } = workshop;
    const paid = await holdNoon(workshop);
    harness.paypal.approve(paid.paypalOrderId);
    await settle(paid.held.orderId);
    const pending = await book(
      getDb(),
      harness,
      await slotAt(getDb(), harness, workshop, ONE_PM_SLOT),
      service.id,
    );

    const schedule = await getShopSchedule(
      getDb(),
      shop.id,
      ...WHOLE_DAY,
      harness.now(),
    );

    expect(schedule).toMatchObject({
      shopId: shop.id,
      timezone: "Europe/Riga",
      currency: "EUR",
      from: WHOLE_DAY[0].toISOString(),
      to: WHOLE_DAY[1].toISOString(),
    });
    expect(schedule.technicians).toHaveLength(1);
    expect(schedule.technicians[0]).toMatchObject({
      technicianId: technician.id,
      name: technician.name,
    });
    expect(schedule.technicians[0].windows[0]).toEqual({
      weekday: 1,
      startMinute: 540,
      endMinute: 1080,
    });

    const captureId = (await readOrder(getDb(), paid.held.orderId)).paypalCaptureId;
    expect(schedule.bookings).toHaveLength(2);
    expect(schedule.bookings[0]).toEqual({
      bookingId: paid.held.bookingId,
      orderId: paid.held.orderId,
      status: "confirmed",
      reviewReason: null,
      blocksTime: true,
      serviceId: service.id,
      serviceTitle: service.title,
      technicianId: technician.id,
      technicianName: technician.name,
      startsAt: NOON_SLOT.toISOString(),
      endsAt: ONE_PM_SLOT.toISOString(),
      holdExpiresAt: paid.held.expiresAt,
      timezone: "Europe/Riga",
      paymentStatus: "paid",
      priceMinor: 8000,
      depositMinor: 2000,
      remainingMinor: 6000,
      currency: "EUR",
      depositCaptureId: captureId,
      updatedAt: expect.any(String),
    });
    expect(schedule.bookings[1]).toMatchObject({
      bookingId: pending.bookingId,
      status: "held",
      blocksTime: true,
      paymentStatus: "pending",
    });
  });

  it("reads a stale hold as expired, and keeps a review in view", async () => {
    const workshop = await createWorkshop(getDb());
    const late = await holdNoon(workshop);
    await book(
      getDb(),
      harness,
      await slotAt(getDb(), harness, workshop, ONE_PM_SLOT),
      workshop.service.id,
    );
    await captureAcrossExpiry(getDb(), harness, late.held.orderId, HOLD_MS);

    const { bookings: views } = await getShopSchedule(
      getDb(),
      workshop.shop.id,
      ...WHOLE_DAY,
      harness.now(),
    );

    expect(views.map((view) => [view.status, view.blocksTime])).toEqual([
      ["review_required", false],
      ["expired", false],
    ]);
    expect(views[0].reviewReason).toBe("late_capture");
  });

  it("keeps the money as booked after the seller changes the price", async () => {
    const workshop = await createWorkshop(getDb());
    const { held } = await holdNoon(workshop);
    await getDb()
      .update(products)
      .set({ priceMinor: 9900, depositMinor: 5000 })
      .where(eq(products.id, workshop.service.id));

    const view = await getOrderBooking(getDb(), held.orderId, harness.now());
    expect(view).toMatchObject({
      priceMinor: 8000,
      depositMinor: 2000,
      remainingMinor: 6000,
    });
  });

  it("returns only what touches the range", async () => {
    const workshop = await createWorkshop(getDb());
    await holdNoon(workshop);
    const read = async (from: Date, to: Date) =>
      (await getShopSchedule(getDb(), workshop.shop.id, from, to, harness.now())).bookings
        .length;

    expect(await read(ONE_PM_SLOT, new Date("2026-11-09T20:00:00Z"))).toBe(0);
    expect(await read(new Date("2026-11-09T08:00:00Z"), NOON_SLOT)).toBe(0);
    expect(
      await read(new Date("2026-11-09T10:59:00Z"), new Date("2026-11-09T12:00:00Z")),
    ).toBe(1);
  });

  it("never shows another shop's bookings or technicians", async () => {
    const mine = await createWorkshop(getDb());
    await holdNoon(mine);
    const other = await createShop(getDb(), { paypalMerchantId: "OTHERSHOPMERCHANT" });
    const theirTechnician = await createTechnician(getDb(), other.id);
    await createWindow(getDb(), theirTechnician);

    const schedule = await getShopSchedule(getDb(), other.id, ...WHOLE_DAY, harness.now());

    expect(schedule.bookings).toEqual([]);
    expect(schedule.technicians.map((person) => person.technicianId)).toEqual([
      theirTechnician.id,
    ]);
  });

  it("refuses a range that makes no sense, and a shop that does not exist", async () => {
    const { shop } = await createWorkshop(getDb());
    expect(
      await codeOf(getShopSchedule(getDb(), shop.id, WHOLE_DAY[1], WHOLE_DAY[0])),
    ).toBe("INVALID_INPUT");
    expect(
      await codeOf(
        getShopSchedule(
          getDb(),
          shop.id,
          new Date("2026-01-01T00:00:00Z"),
          new Date("2027-01-01T00:00:00Z"),
        ),
      ),
    ).toBe("INVALID_INPUT");
    expect(
      await codeOf(getShopSchedule(getDb(), randomUUID(), ...WHOLE_DAY)),
    ).toBe("SHOP_NOT_FOUND");
  });
});
