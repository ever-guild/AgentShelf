import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  book,
  createBookingHarness,
  createWorkshop,
  minutes,
  MONDAY_MORNING,
  NOON_SLOT,
  ONE_PM_SLOT,
  openEveryDay,
  paypalIdOf,
  slotAt,
  type BookingHarness,
} from "../../../test/bookings";
import { setupMigratedDatabase } from "../../../test/database";
import {
  createBooking,
  createOrder,
  createService,
  createShop,
  createTechnician,
  createWindow,
} from "../../../test/fixtures";
import { readOrder } from "../../../test/payments";
import { BOOKING_POLICY } from "../domain/booking-policy";
import { ServiceError } from "../errors";
import { reconcileOrder } from "./payment-reconciliation";
import { getSellerSchedule } from "./seller-schedule";

const getDb = setupMigratedDatabase();

const MONDAY = "2026-11-09";
const HOLD_MS = minutes(BOOKING_POLICY.holdMinutes);

let harness: BookingHarness;

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  harness = createBookingHarness();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const scheduleOf = (shop: { id: string; timezone: string }, date = MONDAY, now = harness.now()) =>
  getSellerSchedule(getDb(), shop, { date }, now);

async function holdAt(workshop: Awaited<ReturnType<typeof createWorkshop>>, startsAt = NOON_SLOT) {
  const slotId = await slotAt(getDb(), harness, workshop, startsAt);
  return book(getDb(), harness, slotId, workshop.service.id);
}

describe("a deposit moving through the schedule", () => {
  it("shows a hold, then the verified capture, on the technician it was booked with", async () => {
    const workshop = await createWorkshop(getDb());
    const other = await createTechnician(getDb(), workshop.shop.id);
    await openEveryDay(getDb(), other);

    const held = await holdAt(workshop);
    const before = await scheduleOf(workshop.shop);
    expect(before.technicians.map((person) => person.technicianId).sort()).toEqual(
      [workshop.technician.id, other.id].sort(),
    );
    const heldRow = before.bookings.find(({ bookingId }) => bookingId === held.bookingId);
    expect(heldRow).toMatchObject({ status: "held", paymentStatus: expect.any(String) });
    expect(heldRow?.paymentStatus).not.toBe("paid");

    const technicianId = heldRow?.technicianId;
    harness.paypal.approve(await paypalIdOf(getDb(), held.orderId));
    harness.advance(minutes(5));
    await reconcileOrder(getDb(), held.orderId, harness.reconcileDeps);

    const after = await scheduleOf(workshop.shop);
    expect(after.bookings).toHaveLength(1);
    expect(after.bookings[0]).toMatchObject({
      bookingId: held.bookingId,
      technicianId,
      status: "confirmed",
      paymentStatus: "paid",
      startsLocal: `${MONDAY}T12:00:00`,
      endsLocal: `${MONDAY}T13:00:00`,
      depositMinor: 2000,
      remainingMinor: 6000,
      currency: "EUR",
    });
  });

  it("does not confirm on approval alone", async () => {
    const workshop = await createWorkshop(getDb());
    const held = await holdAt(workshop);
    harness.paypal.approve(await paypalIdOf(getDb(), held.orderId));

    const { bookings } = await scheduleOf(workshop.shop);
    expect(bookings[0].status).toBe("held");
  });

  it("reads a hold as expired from its exact instant, before any sweep has run", async () => {
    const workshop = await createWorkshop(getDb());
    await holdAt(workshop);

    harness.advance(HOLD_MS - 1);
    expect((await scheduleOf(workshop.shop)).bookings[0].status).toBe("held");

    harness.advance(1);
    expect((await scheduleOf(workshop.shop)).bookings[0].status).toBe("expired");
  });

  it("keeps a late deposit in view as needing review, with the reason", async () => {
    const workshop = await createWorkshop(getDb());
    const held = await holdAt(workshop);
    harness.paypal.approve(await paypalIdOf(getDb(), held.orderId));
    harness.advance(HOLD_MS + minutes(1));
    await reconcileOrder(getDb(), held.orderId, harness.reconcileDeps);

    const { bookings } = await scheduleOf(workshop.shop);
    expect(bookings[0]).toMatchObject({
      status: "review_required",
      reviewReason: "late_capture",
      paymentStatus: "paid",
    });
  });

  it("shows an expired hold beside the booking that took its time", async () => {
    const workshop = await createWorkshop(getDb());
    const first = await holdAt(workshop);
    harness.advance(HOLD_MS + 1);
    const second = await holdAt(workshop);

    const { bookings } = await scheduleOf(workshop.shop);
    expect(bookings.map(({ bookingId, status }) => [bookingId, status]).sort()).toEqual(
      [
        [first.bookingId, "expired"],
        [second.bookingId, "held"],
      ].sort(),
    );
  });

  it("does not hand the capture ID or the order to the page", async () => {
    const workshop = await createWorkshop(getDb());
    const held = await holdAt(workshop);
    const paypalOrderId = await paypalIdOf(getDb(), held.orderId);
    harness.paypal.approve(paypalOrderId);
    await reconcileOrder(getDb(), held.orderId, harness.reconcileDeps);
    const order = await readOrder(getDb(), held.orderId);
    expect(order.paypalCaptureId).toBeTruthy();

    const text = JSON.stringify(await scheduleOf(workshop.shop));
    expect(text).not.toContain(order.paypalCaptureId as string);
    expect(text).not.toContain(paypalOrderId);
    expect(text).not.toContain(held.orderId);
  });
});

describe("two shops", () => {
  it("never see each other's technicians, bookings or neighbouring days", async () => {
    const mine = await createWorkshop(getDb());
    const theirs = await createWorkshop(getDb(), {});
    await holdAt(mine);
    const theirBooking = await createBooking(
      getDb(),
      theirs.shop.id,
      theirs.service.id,
      theirs.technician.id,
      {
        startsAt: ONE_PM_SLOT,
        endsAt: new Date(ONE_PM_SLOT.getTime() + minutes(60)),
        holdExpiresAt: new Date(ONE_PM_SLOT.getTime() - minutes(60)),
      },
    );
    // Another day's booking that would otherwise show up as the next booking to jump to.
    const nextWeek = new Date(NOON_SLOT.getTime() + 7 * 24 * 60 * 60 * 1000);
    await createBooking(getDb(), theirs.shop.id, theirs.service.id, theirs.technician.id, {
      startsAt: nextWeek,
      endsAt: new Date(nextWeek.getTime() + minutes(60)),
      holdExpiresAt: new Date(nextWeek.getTime() - minutes(60)),
    });

    const view = await scheduleOf(mine.shop);
    expect(view.shopId).toBe(mine.shop.id);
    expect(view.technicians.map(({ technicianId }) => technicianId)).toEqual([mine.technician.id]);
    expect(view.bookings).toHaveLength(1);
    expect(view.bookings[0].technicianId).toBe(mine.technician.id);
    expect(view.nextBookingDate).toBeNull();
    expect(JSON.stringify(view)).not.toContain(theirBooking.id);
    expect(JSON.stringify(view)).not.toContain(theirs.technician.id);

    const theirView = await scheduleOf(theirs.shop);
    expect(theirView.shopId).toBe(theirs.shop.id);
    expect(theirView.bookings.map(({ bookingId }) => bookingId)).toEqual([theirBooking.id]);
    expect(theirView.nextBookingDate).toBe("2026-11-16");
  });

  it("refuses a request that names a shop rather than ignoring it", async () => {
    const mine = await createWorkshop(getDb());
    const theirs = await createWorkshop(getDb(), {});
    await expect(
      getSellerSchedule(getDb(), mine.shop, { date: MONDAY, shopId: theirs.shop.id }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("days in shop time", () => {
  async function bookingAt(startsAt: string, durationMinutes = 60) {
    const { shop, service, technician } = await createWorkshop(getDb());
    const start = new Date(startsAt);
    await createBooking(getDb(), shop.id, service.id, technician.id, {
      status: "held",
      startsAt: start,
      endsAt: new Date(start.getTime() + minutes(durationMinutes)),
      holdExpiresAt: new Date(start.getTime() + minutes(durationMinutes)),
    });
    return shop;
  }

  it("puts the last hour of a Riga day on that day, though UTC has not reached its end", async () => {
    const shop = await bookingAt("2026-11-09T21:00:00Z");
    const monday = await scheduleOf(shop, "2026-11-09");
    expect(monday.bookings[0]).toMatchObject({
      startsLocal: "2026-11-09T23:00:00",
      endsLocal: "2026-11-10T00:00:00",
    });
    expect(monday.timelineEnd).toBe("2026-11-10T00:00:00");
    expect((await scheduleOf(shop, "2026-11-10")).bookings).toHaveLength(0);
  });

  it("puts the first hour of a Riga day on that day, though UTC is still on the day before", async () => {
    const shop = await bookingAt("2026-11-09T22:00:00Z");
    const tuesday = await scheduleOf(shop, "2026-11-10");
    expect(tuesday.bookings[0].startsLocal).toBe("2026-11-10T00:00:00");
    expect(tuesday.timelineStart).toBe("2026-11-10T00:00:00");
    expect((await scheduleOf(shop, "2026-11-09")).bookings).toHaveLength(0);
  });

  it("uses summer time for a summer booking", async () => {
    const shop = await bookingAt("2027-07-01T09:00:00Z");
    const { bookings } = await scheduleOf(shop, "2027-07-01");
    expect(bookings[0].startsLocal).toBe("2027-07-01T12:00:00");
  });

  it("keeps a bar's length when the clocks going back make the wall clock repeat", async () => {
    // Riga goes from 04:00 back to 03:00 at 01:00 UTC on 31 October 2027.
    const shop = await bookingAt("2027-10-31T00:30:00Z");
    const { bookings } = await scheduleOf(shop, "2027-10-31");
    expect(bookings[0]).toMatchObject({
      startsLocal: "2027-10-31T03:30:00",
      endsLocal: "2027-10-31T03:30:00",
      barEndLocal: "2027-10-31T04:30:00",
    });
  });

  it("takes today from the shop's clock when no day is asked for", async () => {
    const { shop } = await createWorkshop(getDb());
    const lateMonday = new Date("2026-11-09T22:30:00Z");
    const view = await getSellerSchedule(getDb(), shop, {}, lateMonday);
    expect(view).toMatchObject({ date: "2026-11-10", today: "2026-11-10" });
  });

  it("refuses a day that does not exist", async () => {
    const { shop } = await createWorkshop(getDb());
    for (const date of ["2026-02-31", "tomorrow", "1999-12-31", "2026-11-09T00:00:00Z"]) {
      await expect(getSellerSchedule(getDb(), shop, { date })).rejects.toBeInstanceOf(ServiceError);
    }
  });
});

describe("the day's frame", () => {
  it("covers working time and anything booked outside it", async () => {
    const shop = await createShop(getDb());
    const technician = await createTechnician(getDb(), shop.id);
    const service = await createService(getDb(), shop.id);
    await createWindow(getDb(), technician, { weekday: 1, startMinute: 10 * 60, endMinute: 19 * 60 + 30 });
    const early = new Date("2026-11-09T05:30:00Z");
    await createBooking(getDb(), shop.id, service.id, technician.id, {
      startsAt: early,
      endsAt: new Date(early.getTime() + minutes(30)),
      holdExpiresAt: new Date(early.getTime() - minutes(30)),
    });

    expect(await scheduleOf(shop, MONDAY, MONDAY_MORNING)).toMatchObject({
      timelineStart: `${MONDAY}T07:00:00`,
      timelineEnd: `${MONDAY}T20:00:00`,
    });
  });

  it("gives a shop with no technicians an empty answer, not an error", async () => {
    const shop = await createShop(getDb());
    expect(await scheduleOf(shop)).toMatchObject({
      technicians: [],
      bookings: [],
      timelineStart: `${MONDAY}T09:00:00`,
      timelineEnd: `${MONDAY}T18:00:00`,
    });
  });
});

describe("jumping to the nearest booking", () => {
  it("skips empty days, and bookings that no longer matter", async () => {
    const { shop, service, technician } = await createWorkshop(getDb());
    const at = (iso: string, overrides = {}) => {
      const start = new Date(iso);
      return createBooking(getDb(), shop.id, service.id, technician.id, {
        startsAt: start,
        endsAt: new Date(start.getTime() + minutes(60)),
        holdExpiresAt: new Date(start.getTime() - minutes(60)),
        ...overrides,
      });
    };
    const captureId = randomUUID();
    await at("2026-11-02T10:00:00Z", {
      status: "confirmed",
      orderId: (
        await createOrder(getDb(), shop.id, {
          kind: "booking_deposit",
          paymentStatus: "paid",
          paypalCaptureId: captureId,
        })
      ).id,
      depositCaptureId: captureId,
    });
    await at("2026-11-05T10:00:00Z", { status: "expired" });
    await at("2026-11-12T10:00:00Z", { holdExpiresAt: new Date("2026-11-08T00:00:00Z") });
    await at("2026-11-20T10:00:00Z");

    expect(await scheduleOf(shop, MONDAY, MONDAY_MORNING)).toMatchObject({
      previousBookingDate: "2026-11-02",
      nextBookingDate: "2026-11-20",
    });
  });
});
