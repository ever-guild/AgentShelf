import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  book,
  createBookingHarness,
  createWorkshop,
  MONDAY_MORNING,
  NOON_SLOT,
  ONE_PM_SLOT,
  paypalIdOf,
  slotAt,
  type BookingHarness,
} from "../../../test/bookings";
import { setupMigratedDatabase } from "../../../test/database";
import {
  createBooking,
  createOrder,
  createOrderLine,
  createProduct,
  createService,
  createShop,
  createTechnician,
} from "../../../test/fixtures";
import { searchEvents } from "../db/schema";
import { ServiceError } from "../errors";
import { reconcileOrder } from "./payment-reconciliation";
import {
  getDashboardBookings,
  getDashboardDemand,
  getDashboardOrders,
  getDashboardPayments,
} from "./seller-dashboard";

const getDb = setupMigratedDatabase();

const NOW = MONDAY_MORNING;
const daysBefore = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
const at = { now: NOW };

const totalOf = (
  totals: { group: string; kind: string; amountMinor: number; orderCount: number }[],
  group: string,
  kind = "purchase",
) => totals.find((total) => total.group === group && total.kind === kind);

async function codeOf(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => {
      throw new Error("Expected this to be refused");
    },
    (rejection) => rejection,
  );
  expect(error).toBeInstanceOf(ServiceError);
  return (error as ServiceError).code;
}

async function paidOrder(shopId: string, totalMinor: number, overrides = {}) {
  return createOrder(getDb(), shopId, {
    totalMinor,
    paymentStatus: "paid",
    paypalCaptureId: `CAP-${randomUUID()}`,
    approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=SECRET-LINK",
    createdAt: daysBefore(1),
    ...overrides,
  });
}

describe("paid totals and awaiting payment", () => {
  it("counts only captured orders as paid, and keeps every other state apart", async () => {
    const shop = await createShop(getDb());
    const link = { approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=T", createdAt: daysBefore(1) };
    await paidOrder(shop.id, 1000);
    await paidOrder(shop.id, 250);
    await createOrder(getDb(), shop.id, { totalMinor: 300, paymentStatus: "pending", ...link });
    await createOrder(getDb(), shop.id, { totalMinor: 400, paymentStatus: "approved", ...link });
    await createOrder(getDb(), shop.id, { totalMinor: 500, paymentStatus: "review_required", ...link });
    await createOrder(getDb(), shop.id, { totalMinor: 600, paymentStatus: "cancelled", ...link });
    await createOrder(getDb(), shop.id, { totalMinor: 700, paymentStatus: "failed", ...link });
    // PayPal never issued a link, so nobody can pay this one.
    await createOrder(getDb(), shop.id, { totalMinor: 800, paymentStatus: "pending", createdAt: daysBefore(1) });

    const { totals, captures } = await getDashboardPayments(getDb(), shop, {}, at);

    expect(totalOf(totals, "paid")).toMatchObject({ amountMinor: 1250, orderCount: 2 });
    expect(totalOf(totals, "awaiting")).toMatchObject({ amountMinor: 700, orderCount: 2 });
    expect(totalOf(totals, "review")).toMatchObject({ amountMinor: 500, orderCount: 1 });
    expect(totalOf(totals, "closed")).toMatchObject({ amountMinor: 2100, orderCount: 3 });
    expect(captures.map(({ amountMinor }) => amountMinor).sort()).toEqual([1000, 250]);
  });

  it("gives every order the same group its total was counted in", async () => {
    const shop = await createShop(getDb());
    const statuses = ["pending", "approved", "review_required", "cancelled", "failed"] as const;
    for (const paymentStatus of statuses) {
      await createOrder(getDb(), shop.id, { paymentStatus, createdAt: daysBefore(1) });
    }
    await paidOrder(shop.id, 990);

    const { orders } = await getDashboardOrders(getDb(), shop, {}, at);
    const { totals } = await getDashboardPayments(getDb(), shop, {}, at);

    for (const group of ["paid", "awaiting", "review", "closed"]) {
      const rows = orders.filter((order) => order.paymentGroup === group);
      const summed = rows.reduce((sum, order) => sum + order.totalMinor, 0);
      expect(totalOf(totals, group)?.amountMinor ?? 0).toBe(summed);
      expect(totalOf(totals, group)?.orderCount ?? 0).toBe(rows.length);
    }
  });

  it("keeps purchases and deposits apart, and totals whole past the row limit", async () => {
    const shop = await createShop(getDb());
    await paidOrder(shop.id, 1000);
    await paidOrder(shop.id, 2000);
    await paidOrder(shop.id, 4000);
    await paidOrder(shop.id, 2000, { kind: "booking_deposit" });

    const limited = await getDashboardPayments(getDb(), shop, {}, { now: NOW, maxRows: 2 });
    const orders = await getDashboardOrders(getDb(), shop, {}, { now: NOW, maxRows: 2 });

    expect(limited.truncated).toBe(true);
    expect(limited.captures).toHaveLength(2);
    expect(totalOf(limited.totals, "paid")?.amountMinor).toBe(7000);
    expect(totalOf(limited.totals, "paid", "booking_deposit")?.amountMinor).toBe(2000);
    expect(orders.truncated).toBe(true);
    expect(orders.orders).toHaveLength(2);
  });

  it("does not call a shop's answer truncated when it fits", async () => {
    const shop = await createShop(getDb());
    await paidOrder(shop.id, 1000);
    const answers = await Promise.all([
      getDashboardOrders(getDb(), shop, {}, at),
      getDashboardPayments(getDb(), shop, {}, at),
    ]);
    expect(answers.map(({ truncated }) => truncated)).toEqual([false, false]);
  });
});

describe("the period", () => {
  it("counts days in shop time, and leaves out what came before", async () => {
    const shop = await createShop(getDb());
    await paidOrder(shop.id, 100, { createdAt: daysBefore(2) });
    await paidOrder(shop.id, 200, { createdAt: daysBefore(20) });
    await paidOrder(shop.id, 400, { createdAt: daysBefore(50) });
    await paidOrder(shop.id, 800, { createdAt: daysBefore(70) });

    const paidIn = async (days: string) =>
      totalOf((await getDashboardPayments(getDb(), shop, { days }, at)).totals, "paid")?.amountMinor;

    expect(await paidIn("7")).toBe(100);
    expect(await paidIn("30")).toBe(300);
    expect(await paidIn("60")).toBe(700);
    // Monday 9 November in Riga, counting today, goes back to Tuesday 3 November.
    expect((await getDashboardOrders(getDb(), shop, { days: "7" }, at)).periodStartDate).toBe("2026-11-03");
    // The default is 30 days.
    expect((await getDashboardOrders(getDb(), shop, {}, at)).periodDays).toBe(30);
  });
});

describe("what a request may ask for", () => {
  it.each([
    [{ shopId: randomUUID() }],
    [{ days: "8" }],
    [{ days: "30", shop: "other" }],
    [{ currency: "EUR" }],
  ])("refuses %j on every dataset", async (query) => {
    const shop = await createShop(getDb());
    for (const dataset of [getDashboardOrders, getDashboardPayments, getDashboardBookings, getDashboardDemand]) {
      expect(await codeOf(dataset(getDb(), shop, query, at))).toBe("INVALID_INPUT");
    }
  });
});

describe("seller isolation", () => {
  it("shows a shop none of another shop's orders, captures, bookings or demand", async () => {
    const mine = await createShop(getDb());
    const theirs = await createShop(getDb());
    const theirService = await createService(getDb(), theirs.id, { title: "Their secret repair" });
    const theirTechnician = await createTechnician(getDb(), theirs.id);
    const theirProduct = await createProduct(getDb(), theirs.id, { title: "Their secret cable" });
    const theirOrder = await paidOrder(theirs.id, 5555);
    await createOrderLine(getDb(), theirOrder, theirProduct.id, { title: "Their secret cable" });
    await createBooking(getDb(), theirs.id, theirService.id, theirTechnician.id, {
      startsAt: new Date("2026-11-10T10:00:00Z"),
      endsAt: new Date("2026-11-10T11:00:00Z"),
      holdExpiresAt: new Date("2026-11-10T09:00:00Z"),
    });
    await getDb()
      .insert(searchEvents)
      .values({
        queryNormalized: "their secret query",
        resultCount: 0,
        attributedShopId: theirs.id,
        attributionWords: ["secret"],
        attributionProductIds: [theirProduct.id],
        createdAt: daysBefore(1),
      });

    const answers = await Promise.all([
      getDashboardOrders(getDb(), mine, {}, at),
      getDashboardPayments(getDb(), mine, {}, at),
      getDashboardBookings(getDb(), mine, {}, at),
      getDashboardDemand(getDb(), mine, {}, at),
    ]);
    const text = JSON.stringify(answers);

    expect(text).not.toContain("secret");
    expect(text).not.toContain(theirOrder.id);
    expect(text).not.toContain(theirOrder.paypalCaptureId);
    expect(text).not.toContain("5555");
    expect(answers.map(({ shopId }) => shopId)).toEqual(new Array(4).fill(mine.id));

    // And the same data does reach its own shop, so the check above is not passing on empty answers.
    const own = JSON.stringify(
      await Promise.all([
        getDashboardOrders(getDb(), theirs, {}, at),
        getDashboardBookings(getDb(), theirs, {}, at),
        getDashboardDemand(getDb(), theirs, {}, at),
      ]),
    );
    expect(own).toContain("Their secret cable");
    expect(own).toContain("Their secret repair");
    expect(own).toContain("their secret query");
  });

  it("names no other shop's listing, even if an event's array holds one", async () => {
    const mine = await createShop(getDb());
    const theirs = await createShop(getDb());
    const myProduct = await createProduct(getDb(), mine.id, { title: "My charger" });
    const theirProduct = await createProduct(getDb(), theirs.id, { title: "Their charger" });
    await getDb()
      .insert(searchEvents)
      .values({
        queryNormalized: "magsafe charger",
        resultCount: 0,
        attributedShopId: mine.id,
        attributionWords: ["charger"],
        attributionProductIds: [myProduct.id, theirProduct.id],
        createdAt: daysBefore(1),
      });

    const { demand } = await getDashboardDemand(getDb(), mine, {}, at);

    expect(demand[0].listings).toEqual(["My charger"]);
  });

  it("sends nothing that belongs on the server", async () => {
    const shop = await createShop(getDb(), { paypalMerchantId: "SERVERONLYMERCHANT" });
    const product = await createProduct(getDb(), shop.id);
    const order = await paidOrder(shop.id, 990, {
      payeeMerchantId: "SERVERONLYMERCHANT",
      paypalOrderId: "SERVERONLYPAYPALORDER",
      idempotencyKey: "server-only-key",
      requestFingerprint: "server-only-fingerprint",
    });
    await createOrderLine(getDb(), order, product.id);

    const text = JSON.stringify([
      await getDashboardOrders(getDb(), shop, {}, at),
      await getDashboardPayments(getDb(), shop, {}, at),
    ]);

    for (const secret of [
      "SERVERONLYMERCHANT",
      "SERVERONLYPAYPALORDER",
      "server-only-key",
      "server-only-fingerprint",
      "SECRET-LINK",
      "approvalUrl",
      "TEST_SHOP",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("a booking moving through the dashboard", () => {
  let harness: BookingHarness;

  beforeEach(() => {
    vi.stubEnv("APP_ORIGIN", "https://shop.example");
    harness = createBookingHarness();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("shows a hold as awaiting, then the verified deposit as paid with the rest due at the shop", async () => {
    const workshop = await createWorkshop(getDb());
    const slotId = await slotAt(getDb(), harness, workshop, NOON_SLOT);
    const { orderId, bookingId } = await book(getDb(), harness, slotId, workshop.service.id);
    const read = async () => ({
      payments: await getDashboardPayments(getDb(), workshop.shop, {}, { now: harness.now() }),
      orders: await getDashboardOrders(getDb(), workshop.shop, {}, { now: harness.now() }),
      bookings: await getDashboardBookings(getDb(), workshop.shop, {}, { now: harness.now() }),
    });

    const held = await read();
    expect(totalOf(held.payments.totals, "awaiting", "booking_deposit")).toMatchObject({ amountMinor: 2000 });
    expect(totalOf(held.payments.totals, "paid", "booking_deposit")).toBeUndefined();
    expect(held.bookings.bookings[0]).toMatchObject({ bookingId, status: "held", captureId: null });

    // The buyer approves in PayPal, and reconciliation is what moves the money.
    harness.paypal.approve(await paypalIdOf(getDb(), orderId));
    await reconcileOrder(getDb(), orderId, harness.reconcileDeps);

    const paid = await read();
    expect(totalOf(paid.payments.totals, "paid", "booking_deposit")).toMatchObject({
      amountMinor: 2000,
      orderCount: 1,
    });
    expect(totalOf(paid.payments.totals, "awaiting", "booking_deposit")).toBeUndefined();
    expect(paid.payments.captures).toHaveLength(1);
    expect(paid.bookings.bookings[0]).toMatchObject({
      bookingId,
      status: "confirmed",
      paymentStatus: "paid",
      priceMinor: 8000,
      depositMinor: 2000,
      remainingMinor: 6000,
      currency: "EUR",
      startsLocal: "2026-11-09T12:00:00",
      captureId: paid.payments.captures[0].captureId,
    });
    expect(paid.orders.orders[0]).toMatchObject({
      orderId,
      kind: "booking_deposit",
      paymentGroup: "paid",
      totalMinor: 2000,
      captureId: paid.payments.captures[0].captureId,
      booking: { bookingId, status: "confirmed", servicePriceMinor: 8000, remainingMinor: 6000 },
    });
  });

  it("reads a hold past its instant as expired, in the orders and the bookings", async () => {
    const workshop = await createWorkshop(getDb());
    const slotId = await slotAt(getDb(), harness, workshop, ONE_PM_SLOT);
    const { orderId } = await book(getDb(), harness, slotId, workshop.service.id);

    const later = new Date(harness.now().getTime() + 16 * 60_000);
    const { bookings } = await getDashboardBookings(getDb(), workshop.shop, {}, { now: later });
    const { orders } = await getDashboardOrders(getDb(), workshop.shop, {}, { now: later });

    expect(bookings[0].status).toBe("expired");
    expect(orders.find((order) => order.orderId === orderId)?.booking?.status).toBe("expired");
  });

  it("reads bookings from the period's start to 31 days ahead, and no further", async () => {
    const shop = await createShop(getDb());
    const service = await createService(getDb(), shop.id);
    const technician = await createTechnician(getDb(), shop.id);
    const bookingOn = (startsAt: string, endsAt: string) =>
      createBooking(getDb(), shop.id, service.id, technician.id, {
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        holdExpiresAt: new Date(startsAt),
      });
    const inside = await bookingOn("2026-12-09T10:00:00Z", "2026-12-09T11:00:00Z");
    const outside = await bookingOn("2026-12-11T10:00:00Z", "2026-12-11T11:00:00Z");

    const { bookings, rangeEndDate } = await getDashboardBookings(getDb(), shop, {}, at);

    expect(rangeEndDate).toBe("2026-12-09");
    expect(bookings.map(({ bookingId }) => bookingId)).toEqual([inside.id]);
    expect(JSON.stringify(bookings)).not.toContain(outside.id);
  });
});

describe("search demand", () => {
  async function recordEvent(overrides: Partial<typeof searchEvents.$inferInsert>) {
    await getDb()
      .insert(searchEvents)
      .values({ queryNormalized: "magsafe charger", resultCount: 0, createdAt: daysBefore(1), ...overrides });
  }

  it("groups attributed misses by query with their basis, and never counts a global miss", async () => {
    const shop = await createShop(getDb());
    const charger = await createProduct(getDb(), shop.id, { title: "USB-C wall charger" });
    const basis = { attributedShopId: shop.id, attributionWords: ["charger"], attributionProductIds: [charger.id] };
    await recordEvent({ ...basis, origin: "fixture", createdAt: daysBefore(3) });
    await recordEvent({ ...basis, degraded: true, createdAt: daysBefore(1), location: "Liepaja", maxPriceMinor: 1500, currency: "EUR", kind: "product" });
    await recordEvent({ ...basis, queryNormalized: "wireless charger", createdAt: daysBefore(2) });
    await recordEvent({ queryNormalized: "horse saddle" });
    await recordEvent({ ...basis, createdAt: daysBefore(45) });

    const answer = await getDashboardDemand(getDb(), shop, {}, at);

    expect(answer.unmetSearches).toBe(3);
    expect(answer.demand.map(({ query }) => query)).toEqual(["magsafe charger", "wireless charger"]);
    expect(answer.demand[0]).toMatchObject({
      searches: 2,
      sampleSearches: 1,
      degradedSearches: 1,
      sharedWords: ["charger"],
      listings: ["USB-C wall charger"],
      // From the most recent of them.
      location: "Liepaja",
      maxPriceMinor: 1500,
      currency: "EUR",
      kind: "product",
      lastSearchedLocal: "2026-11-08T09:00:00",
    });
    expect(JSON.stringify(answer)).not.toContain("horse saddle");
  });

  it("counts a search that returned this shop's listing once, as served and not as unmet", async () => {
    const shop = await createShop(getDb());
    const other = await createShop(getDb());
    const product = await createProduct(getDb(), shop.id);
    const otherProduct = await createProduct(getDb(), other.id);
    const both = randomUUID();
    await recordEvent({ searchId: both, resultCount: 2, matchedProductIds: [product.id, otherProduct.id] });
    await recordEvent({ resultCount: 1, matchedProductIds: [otherProduct.id] });
    await recordEvent({ resultCount: 1, matchedProductIds: [product.id], createdAt: daysBefore(45) });

    const answer = await getDashboardDemand(getDb(), shop, {}, at);

    expect(answer.servedSearches).toBe(1);
    expect(answer.unmetSearches).toBe(0);
    expect(answer.demand).toEqual([]);
  });

  it("answers an empty shop with empty lists", async () => {
    const shop = await createShop(getDb());
    const answers = await Promise.all([
      getDashboardOrders(getDb(), shop, {}, at),
      getDashboardPayments(getDb(), shop, {}, at),
      getDashboardBookings(getDb(), shop, {}, at),
      getDashboardDemand(getDb(), shop, {}, at),
    ]);
    expect(answers[0].orders).toEqual([]);
    expect(answers[1].totals).toEqual([]);
    expect(answers[1].captures).toEqual([]);
    expect(answers[2].bookings).toEqual([]);
    expect(answers[3]).toMatchObject({ demand: [], unmetSearches: 0, servedSearches: 0 });
  });
});

describe("order details", () => {
  it("carries each order's lines as sold, in its own shop", async () => {
    const shop = await createShop(getDb());
    const glass = await createProduct(getDb(), shop.id, { title: "Glass" });
    const cable = await createProduct(getDb(), shop.id, { title: "Cable" });
    const order = await paidOrder(shop.id, 2730);
    await createOrderLine(getDb(), order, glass.id, {
      title: "Glass",
      unitPriceMinor: 990,
      quantity: 2,
      lineTotalMinor: 1980,
    });
    await createOrderLine(getDb(), order, cable.id, {
      title: "Cable",
      unitPriceMinor: 750,
      quantity: 1,
      lineTotalMinor: 750,
    });

    const { orders } = await getDashboardOrders(getDb(), shop, {}, at);

    expect(orders[0].items).toBe("2 x Glass, Cable");
    expect(orders[0].lines.map(({ title, lineTotalMinor }) => [title, lineTotalMinor])).toEqual([
      ["Glass", 1980],
      ["Cable", 750],
    ]);
    expect(orders[0].reference).toBe(order.id.slice(0, 8).toUpperCase());
    expect(orders[0].captureId).toBe(order.paypalCaptureId);
  });
});
