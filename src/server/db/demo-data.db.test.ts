import { randomUUID } from "node:crypto";

import { asc, count, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import { createProduct, createService, createShop, createTrackedProduct, createTechnician, createWindow } from "../../../test/fixtures";
import { createFakePayPal } from "../../../test/paypal-fake";
import {
  addDays,
  demoInstant,
  formatLocalDate,
  parseLocalDate,
  tomorrowBeforeNoon,
} from "../domain/demo-calendar";
import { createPayPalProvider } from "../paypal/orders";
import { bookSlot, getSlots } from "../services/bookings";
import { searchProducts } from "../services/catalog";
import { createCheckout } from "../services/checkout";
import { DemoResetRefused, resetDemoData } from "./demo-reset";
import {
  bookings,
  inventoryAdjustments,
  inventoryAudit,
  inventoryReservationLines,
  inventoryReservations,
  inventoryStock,
  orderLines,
  orders,
  products,
  searchEvents,
  shops,
  technicians,
  technicianWindows,
  webhookReceipts,
} from "./schema";
import {
  DEMO_CABLE_ID,
  DEMO_CANDLE_ID,
  DEMO_FIXTURE_EVENT_IDS,
  DEMO_PRODUCT_ID,
  DEMO_SECOND_SHOP_ID,
  DEMO_SERVICE_ID,
  DEMO_SHOP_ID,
  DEMO_TECHNICIAN_IDS,
  seedDemoData,
} from "./seed";

const getDb = setupMigratedDatabase();

const DEMO_ENV = {
  DEMO_ENVIRONMENT: "true",
  DEMO_DATE: "2026-11-09",
  DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID: "PHONEMERCHANT1",
  DEMO_SECOND_SHOP_PAYPAL_MERCHANT_ID: "CANDLEMERCHANT1",
};

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const rowIds = async () => ({
  shops: (await getDb().select({ id: shops.id }).from(shops).orderBy(asc(shops.id))).map((r) => r.id),
  products: (await getDb().select({ id: products.id }).from(products).orderBy(asc(products.id))).map((r) => r.id),
  technicians: (await getDb().select({ id: technicians.id }).from(technicians).orderBy(asc(technicians.id))).map((r) => r.id),
  windows: (await getDb().select({ id: technicianWindows.id }).from(technicianWindows).orderBy(asc(technicianWindows.id))).map((r) => r.id),
  events: (await getDb().select({ id: searchEvents.id }).from(searchEvents).orderBy(asc(searchEvents.id))).map((r) => r.id),
});

describe("the seeded demo", () => {
  it("keeps every identifier and adds no row when seeded again", async () => {
    await seedDemoData(getDb(), DEMO_ENV);
    const first = await rowIds();
    await seedDemoData(getDb(), DEMO_ENV);
    await seedDemoData(getDb(), { ...DEMO_ENV, DEMO_DATE: "2027-02-01" });

    expect(await rowIds()).toEqual(first);
    expect(first.shops).toEqual([DEMO_SHOP_ID, DEMO_SECOND_SHOP_ID]);
    expect(first.products).toHaveLength(8);
    expect(first.technicians).toHaveLength(2);
    expect(first.windows).toHaveLength(12);
    expect(first.events).toEqual([...DEMO_FIXTURE_EVENT_IDS].sort());
  });

  it("holds two shops of different kinds, each paid into its own account", async () => {
    await seedDemoData(getDb(), {
      ...DEMO_ENV,
      DEMO_PHONE_WORKSHOP_SELLER_CODE: "phone-code-for-tests",
      DEMO_SECOND_SHOP_SELLER_CODE: "candle-code-for-tests",
    });
    const [phone, candle] = await getDb().select().from(shops).orderBy(asc(shops.id));

    expect(phone).toMatchObject({
      slug: "demo-phone-workshop",
      location: "Liepaja",
      paypalCredentialRef: "DEMO_PHONE_WORKSHOP",
      paypalMerchantId: "PHONEMERCHANT1",
    });
    expect(candle).toMatchObject({
      slug: "demo-candle-studio",
      paypalCredentialRef: "DEMO_SECOND_SHOP",
      paypalMerchantId: "CANDLEMERCHANT1",
    });
    expect(phone.sellerAccessCodeHash).toMatch(/^scrypt\$/);
    expect(candle.sellerAccessCodeHash).toMatch(/^scrypt\$/);
    expect(candle.sellerAccessCodeHash).not.toBe(phone.sellerAccessCodeHash);

    const services = await getDb().select().from(products).where(eq(products.kind, "service"));
    expect(services.map((service) => service.shopId)).toEqual([DEMO_SHOP_ID]);
    expect(
      await getDb().select({ n: count() }).from(technicians).where(eq(technicians.shopId, DEMO_SECOND_SHOP_ID)),
    ).toEqual([{ n: 0 }]);
  });

  it("refuses to give two shops one merchant", async () => {
    await expect(
      seedDemoData(getDb(), {
        DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID: "SAMEMERCHANT",
        DEMO_SECOND_SHOP_PAYPAL_MERCHANT_ID: "SAMEMERCHANT",
      }),
    ).rejects.toThrow("different PayPal merchant IDs");
    expect(await getDb().select({ n: count() }).from(shops)).toEqual([{ n: 0 }]);
  });

  it("labels its demand as fixtures and records no payment", async () => {
    await seedDemoData(getDb(), DEMO_ENV);

    const events = await getDb().select().from(searchEvents);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.origin === "fixture")).toBe(true);
    const magsafe = events.filter((event) => event.queryNormalized.includes("magsafe"));
    expect(magsafe.length).toBeGreaterThanOrEqual(3);
    expect(magsafe.every((event) => event.resultCount === 0 && event.attributedShopId === DEMO_SHOP_ID)).toBe(true);

    for (const table of [orders, orderLines, bookings, webhookReceipts]) {
      expect(await getDb().select({ n: count() }).from(table)).toEqual([{ n: 0 }]);
    }
  });

  it("dates its demand from the demo date and only ever in the past", async () => {
    await seedDemoData(getDb(), DEMO_ENV);
    const readDates = async () =>
      (await getDb().select({ id: searchEvents.id, at: searchEvents.createdAt }).from(searchEvents).orderBy(asc(searchEvents.id)));
    const first = await readDates();
    const midnight = demoInstant(parseLocalDate("2026-11-09"), 0);
    expect(first.every((event) => event.at < midnight)).toBe(true);

    await seedDemoData(getDb(), { ...DEMO_ENV, DEMO_DATE: "2026-11-19" });
    const second = await readDates();
    expect(second.map((event) => event.id)).toEqual(first.map((event) => event.id));
    for (const [index, event] of second.entries()) {
      expect(event.at.getTime() - first[index].at.getTime()).toBe(10 * 24 * 3600 * 1000);
    }
  });

  it("finds goods in both shops through the one search", async () => {
    await seedDemoData(getDb(), DEMO_ENV);
    const ids = async (query: string, extra = {}) =>
      (await searchProducts(getDb(), { query, ...extra })).products.map((p) => p.productId);

    expect(await ids("iPhone 13 screen repair")).toEqual([DEMO_SERVICE_ID]);
    expect(await ids("soy candle")).toContain(DEMO_CANDLE_ID);
    expect(await ids("candle", { location: "Riga" })).toContain(DEMO_CANDLE_ID);
    expect(await ids("candle", { location: "Liepaja" })).toEqual([]);
    expect(await ids("iPhone 13 screen protector", { maxPriceMinor: 1500 })).toEqual([DEMO_PRODUCT_ID]);
    expect(await ids("lightning cable", { maxPriceMinor: 1500 })).toEqual([DEMO_CABLE_ID]);
  });

  it("has free time for the repair tomorrow before noon, whatever day tomorrow is", async () => {
    await seedDemoData(getDb(), DEMO_ENV);
    // Two starting dates, each followed by two weeks, so every weekday is met more than once.
    // The second run crosses the March clock change.
    for (const start of ["2026-11-09", "2027-03-22"]) {
      for (let offset = 0; offset < 14; offset += 1) {
        const today = addDays(parseLocalDate(start), offset);
        const { from, to } = tomorrowBeforeNoon(today);
        const evening = demoInstant(today, 20);
        const { slots } = await getSlots(
          getDb(),
          {
            shopId: DEMO_SHOP_ID,
            serviceId: DEMO_SERVICE_ID,
            from: from.toISOString(),
            to: to.toISOString(),
          },
          evening,
        );
        expect(slots.length, formatLocalDate(today)).toBeGreaterThan(0);
        for (const slot of slots) {
          const startsAt = Date.parse(slot.startsAt);
          expect(startsAt).toBeGreaterThanOrEqual(from.getTime());
          expect(startsAt).toBeLessThan(to.getTime());
          expect(slot.timezone).toBe("Europe/Riga");
        }
      }
    }
  });

  it("pays an accessory under EUR 15 into the right shop's account", async () => {
    await seedDemoData(getDb(), DEMO_ENV);
    const paypal = createFakePayPal();
    const paypalFor = createPayPalProvider(
      {
        PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP: "phone-client",
        PAYPAL_CLIENT_SECRET_DEMO_PHONE_WORKSHOP: "phone-secret",
        PAYPAL_CLIENT_ID_DEMO_SECOND_SHOP: "candle-client",
        PAYPAL_CLIENT_SECRET_DEMO_SECOND_SHOP: "candle-secret",
      },
      paypal.adapter,
    );

    for (const [productId, total] of [
      [DEMO_PRODUCT_ID, 990],
      [DEMO_CABLE_ID, 750],
      [DEMO_CANDLE_ID, 1250],
    ] as const) {
      const checkout = await createCheckout(
        getDb(),
        { items: [{ productId, quantity: 1 }], idempotencyKey: randomUUID() },
        { paypalFor },
      );
      expect(checkout.totalMinor).toBe(total);
      expect(total).toBeLessThan(1500);
    }

    const payees = paypal
      .createRequests()
      .map((request) => paypal.bodyOf(request).purchase_units[0].payee.merchant_id);
    expect(payees).toEqual(["PHONEMERCHANT1", "PHONEMERCHANT1", "CANDLEMERCHANT1"]);
    // Nothing was approved or captured, so no order is paid.
    expect(paypal.captureRequests()).toHaveLength(0);
    const paid = await getDb().select().from(orders).where(eq(orders.paymentStatus, "paid"));
    expect(paid).toEqual([]);
  });
});

describe("resetting the demo", () => {
  it("refuses unless the environment says it is a demo", async () => {
    await seedDemoData(getDb(), DEMO_ENV);
    await getDb().update(products).set({ priceMinor: 1 }).where(eq(products.id, DEMO_PRODUCT_ID));

    for (const flag of [undefined, "", "false", "yes", "1", "TRUE"]) {
      await expect(
        resetDemoData(getDb(), { ...DEMO_ENV, DEMO_ENVIRONMENT: flag }),
      ).rejects.toBeInstanceOf(DemoResetRefused);
    }
    const [product] = await getDb().select().from(products).where(eq(products.id, DEMO_PRODUCT_ID));
    expect(product.priceMinor).toBe(1);
  });

  it("refuses a database that holds a shop the demo does not own", async () => {
    await seedDemoData(getDb(), DEMO_ENV);
    await createShop(getDb(), { name: "A real shop" });
    const extra = await createProduct(getDb(), DEMO_SHOP_ID, { title: "Extra" });

    await expect(resetDemoData(getDb(), DEMO_ENV)).rejects.toThrow("not part of the demo");
    expect(await getDb().select().from(products).where(eq(products.id, extra.id))).toHaveLength(1);
  });

  it("refuses an active or unresolved reservation without changing any demo rows", async () => {
    await seedDemoData(getDb(), DEMO_ENV);
    await getDb().update(products).set({ priceMinor: 1 }).where(eq(products.id, DEMO_PRODUCT_ID));
    await getDb()
      .update(inventoryStock)
      .set({ onHand: 9, reserved: 0, version: 1 })
      .where(eq(inventoryStock.productId, DEMO_PRODUCT_ID));
    const reservationId = randomUUID();
    await getDb().insert(inventoryReservations).values({
      id: reservationId,
      shopId: DEMO_SHOP_ID,
      idempotencyKey: "demo-reset-held-reservation-0001",
      requestHash: "a".repeat(64),
      state: "capture_pending",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await getDb().insert(inventoryReservationLines).values({
      reservationId,
      shopId: DEMO_SHOP_ID,
      productId: DEMO_PRODUCT_ID,
      quantity: 1,
    });

    const auditBefore = await getDb().select().from(inventoryAudit);
    await expect(resetDemoData(getDb(), DEMO_ENV)).rejects.toThrow("active or unresolved");

    const [product] = await getDb().select().from(products).where(eq(products.id, DEMO_PRODUCT_ID));
    const [stock] = await getDb().select().from(inventoryStock).where(eq(inventoryStock.productId, DEMO_PRODUCT_ID));
    const [reservation] = await getDb().select().from(inventoryReservations).where(eq(inventoryReservations.id, reservationId));
    expect(product.priceMinor).toBe(1);
    expect(stock).toMatchObject({ onHand: 9, reserved: 0, version: 1 });
    expect(reservation.state).toBe("capture_pending");
    expect(await getDb().select().from(inventoryAudit)).toEqual(auditBefore);
  });

  it("puts the demo back as seeded, twice over, with the same identifiers", async () => {
    await seedDemoData(getDb(), DEMO_ENV);
    const seeded = await rowIds();

    await getDb().update(products).set({ priceMinor: 1, status: "unpublished" }).where(eq(products.id, DEMO_PRODUCT_ID));
    await getDb().update(inventoryStock).set({ onHand: 8, version: 2 }).where(eq(inventoryStock.productId, DEMO_PRODUCT_ID));
    const extra = await createProduct(getDb(), DEMO_SECOND_SHOP_ID, { title: "Left over" });
    const person = await createTechnician(getDb(), DEMO_SHOP_ID);
    await createWindow(getDb(), person, { weekday: 3 });
    await getDb().delete(technicianWindows).where(eq(technicianWindows.weekday, 6));
    await createWindow(getDb(), { id: DEMO_TECHNICIAN_IDS[0], shopId: DEMO_SHOP_ID }, { weekday: 7 });
    await getDb().update(searchEvents).set({ queryNormalized: "changed" }).where(eq(searchEvents.id, DEMO_FIXTURE_EVENT_IDS[0]));
    await getDb().insert(searchEvents).values({ queryNormalized: "seen by a real buyer", resultCount: 0 });

    const first = await resetDemoData(getDb(), DEMO_ENV);
    const afterFirst = await rowIds();
    const second = await resetDemoData(getDb(), DEMO_ENV);

    expect(first.removedProducts).toBe(1);
    expect(first.restoredStock).toBe(1);
    expect(second.removedProducts).toBe(0);
    expect(second.restoredStock).toBe(0);
    expect(await getDb().select().from(products).where(eq(products.id, extra.id))).toEqual([]);
    expect(await getDb().select().from(technicians).where(eq(technicians.id, person.id))).toEqual([]);
    const [product] = await getDb().select().from(products).where(eq(products.id, DEMO_PRODUCT_ID));
    expect(product).toMatchObject({ priceMinor: 990, status: "published" });
    const [stock] = await getDb().select().from(inventoryStock).where(eq(inventoryStock.productId, DEMO_PRODUCT_ID));
    expect(stock).toMatchObject({ onHand: 10, reserved: 0, version: 3 });
    const stockAudits = await getDb().select().from(inventoryAudit).where(eq(inventoryAudit.productId, DEMO_PRODUCT_ID));
    expect(stockAudits.at(-1)).toMatchObject({
      eventType: "adjusted",
      quantityDelta: 2,
      reason: "Synthetic demo reset restored the fixed fixture quantity; not seller-reported stock.",
      versionAfter: 3,
    });
    expect(stockAudits.at(-1)?.idempotencyKey).toBeTruthy();
    expect(await getDb().select().from(inventoryAdjustments).where(eq(inventoryAdjustments.shopId, DEMO_SHOP_ID))).toHaveLength(1);

    // The same rows as a fresh seed, plus the one search somebody really made.
    const { events, ...rest } = await rowIds();
    const { events: seededEvents, ...seededRest } = seeded;
    expect(rest).toEqual(seededRest);
    expect(afterFirst).toEqual({ ...(await rowIds()) });
    expect(events).toHaveLength(seededEvents.length + 1);
    const observed = await getDb().select().from(searchEvents).where(eq(searchEvents.origin, "observed"));
    expect(observed.map((event) => event.queryNormalized)).toEqual(["seen by a real buyer"]);
    const [restored] = await getDb().select().from(searchEvents).where(eq(searchEvents.id, DEMO_FIXTURE_EVENT_IDS[0]));
    expect(restored.queryNormalized).toBe("magsafe charger");
  });

  it("keeps the money records and provider references of the demo shops", async () => {
    await seedDemoData(getDb(), DEMO_ENV);
    const paypal = createFakePayPal();
    const paypalFor = createPayPalProvider(
      {
        PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP: "phone-client",
        PAYPAL_CLIENT_SECRET_DEMO_PHONE_WORKSHOP: "phone-secret",
      },
      paypal.adapter,
    );
    // A listing the seed does not know, which a real order refers to, and one nobody ordered.
    const sold = await createTrackedProduct(getDb(), DEMO_SHOP_ID, { title: "Sold extra", priceMinor: 500 });
    const unsold = await createProduct(getDb(), DEMO_SHOP_ID, { title: "Unsold extra", priceMinor: 500 });
    await createCheckout(
      getDb(),
      { items: [{ productId: sold.id, quantity: 1 }], idempotencyKey: randomUUID() },
      { paypalFor },
    );
    await getDb().update(products).set({ paypalProductId: "AS-KEPT", paypalSyncStatus: "synced", paypalSyncedAt: new Date() }).where(eq(products.id, DEMO_PRODUCT_ID));
    const [orderBefore] = await getDb().select().from(orders);
    expect(orderBefore.paypalOrderId).toBeTruthy();

    // An unresolved checkout hold refuses reset. Nothing about its order, stock or provider
    // references may be rewritten while PayPal's outcome is unknown.
    await expect(
      resetDemoData(getDb(), { DEMO_ENVIRONMENT: "true", DEMO_DATE: "2026-11-09" }),
    ).rejects.toThrow("active or unresolved");

    const [orderAfter] = await getDb().select().from(orders);
    expect(orderAfter).toEqual(orderBefore);
    expect(await getDb().select({ n: count() }).from(orderLines)).toEqual([{ n: 1 }]);
    expect(await getDb().select().from(products).where(eq(products.id, sold.id))).toHaveLength(1);
    expect(await getDb().select().from(products).where(eq(products.id, unsold.id))).toHaveLength(1);
    const [glass] = await getDb().select().from(products).where(eq(products.id, DEMO_PRODUCT_ID));
    expect(glass).toMatchObject({ paypalProductId: "AS-KEPT", paypalSyncStatus: "synced" });
    const merchants = await getDb().select({ id: shops.id, merchant: shops.paypalMerchantId }).from(shops).orderBy(asc(shops.id));
    expect(merchants.map((shop) => shop.merchant)).toEqual(["PHONEMERCHANT1", "CANDLEMERCHANT1"]);
  });

  it("keeps a booking with the extra service and technician it was made on", async () => {
    await seedDemoData(getDb(), DEMO_ENV);
    const paypalFor = createPayPalProvider(
      {
        PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP: "phone-client",
        PAYPAL_CLIENT_SECRET_DEMO_PHONE_WORKSHOP: "phone-secret",
      },
      createFakePayPal().adapter,
    );
    const now = new Date("2026-11-09T07:00:00Z");
    const service = await createService(getDb(), DEMO_SHOP_ID, {
      title: "Extra repair",
      priceMinor: 5000,
      depositMinor: 1000,
      serviceDurationMinutes: 30,
    });
    const person = await createTechnician(getDb(), DEMO_SHOP_ID);
    await createWindow(getDb(), person, { weekday: 1 });
    const { slots } = await getSlots(
      getDb(),
      {
        shopId: DEMO_SHOP_ID,
        serviceId: service.id,
        from: "2026-11-09T10:00:00Z",
        to: "2026-11-09T12:00:00Z",
      },
      now,
    );
    const slot = slots.find((candidate) => candidate.technicianId === person.id);
    expect(slot).toBeDefined();
    await bookSlot(
      getDb(),
      { slotId: slot!.slotId, serviceId: service.id, idempotencyKey: randomUUID() },
      { paypalFor, now: () => now },
    );

    await resetDemoData(getDb(), DEMO_ENV);

    expect(await getDb().select({ n: count() }).from(bookings)).toEqual([{ n: 1 }]);
    expect(await getDb().select().from(products).where(eq(products.id, service.id))).toHaveLength(1);
    expect(await getDb().select().from(technicians).where(eq(technicians.id, person.id))).toHaveLength(1);
  });
});
