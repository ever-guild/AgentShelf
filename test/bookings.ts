import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type { Db } from "../src/server/db/client";
import { bookings } from "../src/server/db/schema";
import {
  bookSlot,
  confirmBookingPayment,
  getSlots,
  type BookingDeps,
} from "../src/server/services/bookings";
import type { ReconcileDeps } from "../src/server/services/payment-reconciliation";
import { createService, createShop, createTechnician, createWindow } from "./fixtures";
import { createPaymentHarness, MERCHANT_ID, readOrder } from "./payments";
import type { FakePayPal } from "./paypal-fake";

// Monday 9 November 2026, 09:00 in Riga. The tests read every instant against this clock.
export const MONDAY_MORNING = new Date("2026-11-09T07:00:00Z");
// 12:00 and 13:00 in Riga on that Monday.
export const NOON_SLOT = new Date("2026-11-09T10:00:00Z");
export const ONE_PM_SLOT = new Date("2026-11-09T11:00:00Z");

export const minutes = (count: number) => count * 60_000;

export type BookingHarness = {
  paypal: FakePayPal;
  bookingDeps: BookingDeps;
  reconcileDeps: ReconcileDeps;
  now: () => Date;
  setNow: (date: Date) => void;
  advance: (ms: number) => void;
};

// The real SDK against the PayPal stand-in, the real payment hook, and a clock the test moves.
export function createBookingHarness(): BookingHarness {
  const { paypal, deps } = createPaymentHarness();
  let current = MONDAY_MORNING;
  const now = () => current;
  return {
    paypal,
    now,
    setNow: (date) => {
      current = date;
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
    bookingDeps: { paypalFor: deps.paypalFor, now },
    reconcileDeps: {
      paypalFor: deps.paypalFor,
      onPaymentConfirmed: (tx, order) => confirmBookingPayment(tx, order, now()),
    },
  };
}

// A shop open every day from 09:00 to 18:00, one technician, one published service.
export async function createWorkshop(
  db: Db,
  overrides: Parameters<typeof createShop>[1] = { paypalMerchantId: MERCHANT_ID },
) {
  const shop = await createShop(db, overrides);
  const service = await createService(db, shop.id, {
    priceMinor: 8000,
    depositMinor: 2000,
    serviceDurationMinutes: 60,
  });
  const technician = await createTechnician(db, shop.id);
  await openEveryDay(db, technician);
  return { shop, service, technician };
}

export async function openEveryDay(db: Db, technician: { id: string; shopId: string }) {
  for (const weekday of [1, 2, 3, 4, 5, 6, 7]) {
    await createWindow(db, technician, { weekday });
  }
}

// The slot get_slots offers at this instant, for this technician if one is named.
export async function slotAt(
  db: Db,
  harness: BookingHarness,
  { shop, service, technician }: {
    shop: { id: string };
    service: { id: string; serviceDurationMinutes: number | null };
    technician?: { id: string };
  },
  startsAt: Date,
): Promise<string> {
  const { slots } = await getSlots(
    db,
    {
      shopId: shop.id,
      serviceId: service.id,
      from: startsAt.toISOString(),
      to: new Date(
        startsAt.getTime() + minutes(service.serviceDurationMinutes ?? 0),
      ).toISOString(),
    },
    harness.now(),
  );
  const slot = slots.find(
    (candidate) => !technician || candidate.technicianId === technician.id,
  );
  if (!slot) {
    throw new Error(`No slot is offered at ${startsAt.toISOString()}`);
  }
  return slot.slotId;
}

export function book(
  db: Db,
  harness: BookingHarness,
  slotId: string,
  serviceId: string,
  idempotencyKey: string = randomUUID(),
) {
  return bookSlot(db, { slotId, serviceId, idempotencyKey }, harness.bookingDeps);
}

export async function readBooking(db: Db, bookingId: string) {
  const [row] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  return row;
}

export async function paypalIdOf(db: Db, orderId: string): Promise<string> {
  return (await readOrder(db, orderId)).paypalOrderId as string;
}
