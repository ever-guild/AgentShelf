import "server-only";

import { createHash } from "node:crypto";

import { and, eq, gt, inArray, isNull, lte, lt, or, sql } from "drizzle-orm";
import type { z } from "zod";

import { issueOrderStatusToken } from "../auth/order-status-token";
import {
  bookSlotInput,
  bookSlotResult,
  getSlotsInput,
  getSlotsResult,
} from "../contracts/commerce";
import type { Db } from "../db/client";
import {
  bookings,
  orderLines,
  orders,
  products,
  shops,
  technicians,
  technicianWindows,
} from "../db/schema";
import { BOOKING_POLICY } from "../domain/booking-policy";
import { isSupportedCurrency } from "../domain/money";
import { decodeSlotId, encodeSlotId, generateSlots } from "../domain/slots";
import { ServiceError, parseInput } from "../errors";
import { paypalFor } from "../paypal/orders";
import {
  isReadyConnectedMerchant,
  merchantEligibilityPool,
  resolveShopPayPalRoute,
} from "../paypal/merchant-eligibility";
import { isHoldLive } from "./booking-schedule";
import {
  ensureApprovalLink,
  notConfigured,
  type CheckoutDeps,
  type StoredOrder,
} from "./checkout";
import type { Tx } from "./payment-reconciliation";

// Holding and confirming a technician's time. The database is what stops two buyers from having the
// same slot: a hold is simply inserted, and `bookings_technician_no_overlap` refuses it if the time
// is taken. Everything read before that insert only decides what to offer.

const MINUTE_MS = 60_000;
const OVERLAP_CONSTRAINT = "bookings_technician_no_overlap";

export type BookingDeps = CheckoutDeps & {
  now: () => Date;
  // Asked once per new hold. A retry of a stored key takes no new time, so it does not count.
  allowNewHold?: () => boolean;
};

export const defaultBookingDeps: BookingDeps = {
  paypalFor,
  now: () => new Date(),
};

type OrderRow = typeof orders.$inferSelect;
type BookingRow = typeof bookings.$inferSelect;
type StoredBooking = StoredOrder & { booking: BookingRow | null };

const slotUnavailable = () =>
  new ServiceError(
    "SLOT_UNAVAILABLE",
    "This slot cannot be booked any more. Call get_slots again and choose another.",
  );

const holdEnded = () =>
  new ServiceError(
    "BOOKING_HOLD_ENDED",
    "The hold on this slot has ended, so its link should not be used. Call get_slots again and book with a new idempotencyKey.",
  );

const serviceNotFound = () =>
  new ServiceError(
    "PRODUCT_NOT_FOUND",
    "This shop has no service with this ID open for booking.",
  );

// The rule for what buyers can reach is the same as everywhere else: published, and only then.
// Another shop's service gets the same answer as one that does not exist.
async function loadBookableService(db: Db, serviceId: string) {
  const [row] = await db
    .select({
      id: products.id,
      shopId: products.shopId,
      kind: products.kind,
      status: products.status,
      title: products.title,
      priceMinor: products.priceMinor,
      depositMinor: products.depositMinor,
      durationMinutes: products.serviceDurationMinutes,
      availability: products.availability,
      timezone: shops.timezone,
      currency: shops.currency,
      merchantId: shops.paypalMerchantId,
      credentialRef: shops.paypalCredentialRef,
    })
    .from(products)
    .innerJoin(shops, eq(products.shopId, shops.id))
    .where(eq(products.id, serviceId));
  if (
    !row ||
    row.kind !== "service" ||
    row.status !== "published" ||
    row.priceMinor === null ||
    row.depositMinor === null ||
    row.durationMinutes === null
  ) {
    throw serviceNotFound();
  }
  if (row.availability !== "available") {
    throw new ServiceError(
      "PRODUCT_UNAVAILABLE",
      "This service is currently unavailable.",
      { productId: row.id },
    );
  }
  return {
    ...row,
    priceMinor: row.priceMinor,
    depositMinor: row.depositMinor,
    durationMinutes: row.durationMinutes,
  };
}

const earliestStartAfter = (now: Date) =>
  new Date(now.getTime() + BOOKING_POLICY.minLeadMinutes * MINUTE_MS);

// Read-only, and only ever advice: the slot can be gone by the time book_slot asks for it.
export async function getSlots(
  db: Db,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<z.infer<typeof getSlotsResult>> {
  const input = parseInput(getSlotsInput, rawInput);
  const from = new Date(input.from);
  const to = new Date(input.to);

  const service = await loadBookableService(db, input.serviceId);
  if (service.shopId !== input.shopId) {
    throw serviceNotFound();
  }

  const windows = await db
    .select({
      technicianId: technicianWindows.technicianId,
      technicianName: technicians.name,
      weekday: technicianWindows.weekday,
      startMinute: technicianWindows.startMinute,
      endMinute: technicianWindows.endMinute,
    })
    .from(technicianWindows)
    .innerJoin(technicians, eq(technicianWindows.technicianId, technicians.id))
    .where(eq(technicianWindows.shopId, service.shopId));

  const busy = await db
    .select({
      technicianId: bookings.technicianId,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.shopId, service.shopId),
        lt(bookings.startsAt, to),
        gt(bookings.endsAt, from),
        // A hold past its expiry is free to take, because book_slot expires it first.
        or(
          eq(bookings.status, "confirmed"),
          and(eq(bookings.status, "held"), gt(bookings.holdExpiresAt, now)),
        ),
      ),
    );

  const names = new Map(
    windows.map(({ technicianId, technicianName }) => [technicianId, technicianName]),
  );
  const free = generateSlots({
    windows,
    timezone: service.timezone,
    durationMinutes: service.durationMinutes,
    stepMinutes: BOOKING_POLICY.slotStepMinutes,
    from,
    to,
    earliestStart: earliestStartAfter(now),
  }).filter(
    (slot) =>
      !busy.some(
        (taken) =>
          taken.technicianId === slot.technicianId &&
          taken.startsAt < slot.endsAt &&
          taken.endsAt > slot.startsAt,
      ),
  );

  return getSlotsResult.parse({
    slots: free.slice(0, BOOKING_POLICY.maxSlotsPerAnswer).map((slot) => ({
      slotId: encodeSlotId({
        serviceId: service.id,
        technicianId: slot.technicianId,
        startsAt: slot.startsAt,
        durationMinutes: service.durationMinutes,
      }),
      technicianId: slot.technicianId,
      technicianName: names.get(slot.technicianId),
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
      timezone: service.timezone,
    })),
    truncated: free.length > BOOKING_POLICY.maxSlotsPerAnswer,
  });
}

// A hold past its expiry still counts for the exclusion constraint until it is marked, so this runs
// in the sweep and in front of every new hold. With a technician, it only touches that one's holds.
export async function expireHolds(
  db: Pick<Db, "update">,
  now: Date = new Date(),
  technicianId?: string,
): Promise<number> {
  const expired = await db
    .update(bookings)
    .set({ status: "expired" })
    .where(
      and(
        eq(bookings.status, "held"),
        lte(bookings.holdExpiresAt, now),
        technicianId ? eq(bookings.technicianId, technicianId) : undefined,
      ),
    )
    .returning({ id: bookings.id });
  return expired.length;
}

function fingerprintOf(slotId: string, serviceId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([slotId, serviceId]))
    .digest("hex");
}

async function findByKey(
  db: Db,
  idempotencyKey: string,
): Promise<StoredBooking | undefined> {
  const [row] = await db
    .select({
      order: orders,
      credentialRef: sql<string>`coalesce(${orders.paypalCredentialRef}, ${shops.paypalCredentialRef})`,
      booking: bookings,
    })
    .from(orders)
    .innerJoin(shops, eq(orders.shopId, shops.id))
    .leftJoin(bookings, eq(bookings.orderId, orders.id))
    .where(eq(orders.idempotencyKey, idempotencyKey));
  return row;
}

// Checks a slot against the rule that offered it, using today's service, windows and clock.
async function resolveSlot(db: Db, slotId: string, serviceId: string, now: Date) {
  const service = await loadBookableService(db, serviceId);
  if (!isSupportedCurrency(service.currency)) {
    throw new ServiceError(
      "UNSUPPORTED_CURRENCY",
      `Currency ${service.currency} is not supported.`,
    );
  }

  const slot = decodeSlotId(slotId);
  if (
    !slot ||
    slot.serviceId !== service.id ||
    slot.durationMinutes !== service.durationMinutes
  ) {
    throw slotUnavailable();
  }
  const endsAt = new Date(slot.startsAt.getTime() + slot.durationMinutes * MINUTE_MS);

  const windows = await db
    .select({
      technicianId: technicianWindows.technicianId,
      weekday: technicianWindows.weekday,
      startMinute: technicianWindows.startMinute,
      endMinute: technicianWindows.endMinute,
    })
    .from(technicianWindows)
    .where(
      and(
        eq(technicianWindows.technicianId, slot.technicianId),
        eq(technicianWindows.shopId, service.shopId),
      ),
    );
  const offered = generateSlots({
    windows,
    timezone: service.timezone,
    durationMinutes: service.durationMinutes,
    stepMinutes: BOOKING_POLICY.slotStepMinutes,
    from: slot.startsAt,
    to: endsAt,
    earliestStart: earliestStartAfter(now),
  });
  if (!offered.some(({ startsAt }) => startsAt.getTime() === slot.startsAt.getTime())) {
    throw slotUnavailable();
  }
  return { service, technicianId: slot.technicianId, startsAt: slot.startsAt, endsAt };
}

function isOverlap(thrown: unknown): boolean {
  const error = thrown as { cause?: { constraint?: string }; constraint?: string };
  return (error.cause?.constraint ?? error.constraint) === OVERLAP_CONSTRAINT;
}

// One transaction for the hold and its order, so there is never one without the other.
async function placeHold(
  db: Db,
  idempotencyKey: string,
  fingerprint: string,
  { service, technicianId, startsAt, endsAt }: Awaited<ReturnType<typeof resolveSlot>>,
  paymentRoute: { credentialRef: string; payeeMerchantId: string },
  now: Date,
): Promise<StoredBooking | undefined> {
  return db.transaction(async (tx) => {
    // Takes turns per technician. The constraint alone would also hold, but two inserts that see
    // each other can deadlock, and a buyer would wait a second to be told about it.
    await tx
      .select({ id: technicians.id })
      .from(technicians)
      .where(eq(technicians.id, technicianId))
      .for("no key update");
    await expireHolds(tx, now, technicianId);

    const [order] = await tx
      .insert(orders)
      .values({
        shopId: service.shopId,
        kind: "booking_deposit",
        currency: service.currency,
        totalMinor: service.depositMinor,
        idempotencyKey,
        requestFingerprint: fingerprint,
        payeeMerchantId: paymentRoute.payeeMerchantId,
        paypalCredentialRef: paymentRoute.credentialRef,
      })
      .onConflictDoNothing({ target: orders.idempotencyKey })
      .returning();
    if (!order) {
      return undefined;
    }
    await tx.insert(orderLines).values({
      orderId: order.id,
      shopId: order.shopId,
      productId: service.id,
      title: `Deposit: ${service.title}`,
      unitPriceMinor: service.depositMinor,
      quantity: 1,
      lineTotalMinor: service.depositMinor,
    });

    try {
      const [booking] = await tx
        .insert(bookings)
        .values({
          shopId: service.shopId,
          serviceId: service.id,
          technicianId,
          orderId: order.id,
          startsAt,
          endsAt,
          holdExpiresAt: new Date(
            now.getTime() + BOOKING_POLICY.holdMinutes * MINUTE_MS,
          ),
          servicePriceMinor: service.priceMinor,
        })
        .returning();
      return { order, credentialRef: paymentRoute.credentialRef, booking };
    } catch (error) {
      if (isOverlap(error)) {
        throw slotUnavailable();
      }
      throw error;
    }
  });
}

// The one way to hold a slot. It returns a link and takes no money: a person pays the deposit in
// PayPal, and only a verified capture confirms the booking. Repeating a key answers from what is
// stored, so it cannot make a second booking or a second payment.
export async function bookSlot(
  db: Db,
  rawInput: unknown,
  deps: BookingDeps = defaultBookingDeps,
): Promise<z.infer<typeof bookSlotResult>> {
  const input = parseInput(bookSlotInput, rawInput);
  const now = deps.now();
  // A prefix of its own, so a key used for create_checkout can never reach a booking's order.
  const idempotencyKey = `booking:${input.idempotencyKey}`;
  const fingerprint = fingerprintOf(input.slotId, input.serviceId);

  let stored = await findByKey(db, idempotencyKey);
  if (!stored) {
    const resolved = await resolveSlot(db, input.slotId, input.serviceId, now);
    const paymentRoute = await resolveShopPayPalRoute(merchantEligibilityPool(db), {
      shopId: resolved.service.shopId,
      credentialRef: resolved.service.credentialRef,
      legacyMerchantId: resolved.service.merchantId,
    });
    if (!paymentRoute || !deps.paypalFor(paymentRoute.credentialRef, paymentRoute.payeeMerchantId)) {
      throw notConfigured();
    }
    if (deps.allowNewHold && !deps.allowNewHold()) {
      throw new ServiceError(
        "HOLD_LIMIT_REACHED",
        "Too many new holds have come from this connection. Try again in a few minutes.",
      );
    }
    stored =
      (await placeHold(db, idempotencyKey, fingerprint, resolved, paymentRoute, now)) ??
      // A concurrent request with this key committed first, and its booking is the one to continue.
      (await findByKey(db, idempotencyKey));
  }
  if (!stored?.booking || stored.order.requestFingerprint !== fingerprint) {
    throw new ServiceError(
      "IDEMPOTENCY_CONFLICT",
      "This idempotencyKey was already used for a different booking. Use a new key for a new booking.",
    );
  }
  const { order, booking } = stored;

  const ended =
    booking.status === "expired" ||
    booking.status === "cancelled" ||
    (booking.status === "held" && !isHoldLive(booking.holdExpiresAt, now));
  // A refused order has its own answer, and a retry gets the same one.
  if (ended && order.paymentStatus !== "failed") {
    throw holdEnded();
  }

  // Signed before PayPal is called, so a misconfigured server does not reach PayPal at all. The
  // hold is released again if PayPal refuses the order, by the trigger on orders.
  const statusToken = issueOrderStatusToken(order.id);
  if (
    !order.approvalUrl &&
    stored.credentialRef === "PAYPAL_PLATFORM" &&
    !(await isReadyConnectedMerchant(merchantEligibilityPool(db), order.shopId, order.payeeMerchantId))
  ) {
    throw notConfigured();
  }
  const routedDeps: BookingDeps = {
    ...deps,
    paypalFor: (credentialRef) => deps.paypalFor(credentialRef, order.payeeMerchantId),
  };
  const row = await ensureApprovalLink(db, stored, statusToken, routedDeps);
  return bookSlotResult.parse({
    bookingId: booking.id,
    orderId: row.id,
    expiresAt: booking.holdExpiresAt.toISOString(),
    approvalUrl: row.approvalUrl,
    depositMinor: row.totalMinor,
    remainingMinor: booking.servicePriceMinor - row.totalMinor,
    currency: row.currency,
    statusToken,
  });
}

export type DepositCaptureDecision =
  // The hold is live and the order is now `approved`. `repeat` means an earlier attempt already
  // took it there, and that attempt's capture may still be in progress at PayPal.
  | { action: "capture" }
  // The hold is live and PayPal is waiting for the buyer, so there is nothing to capture yet.
  | { action: "continue" }
  // Nothing is captured, and the order is as it should be for now.
  | { action: "stop" };

// A deposit pays for time, and the time is there only while its hold is live, so this is asked
// before anything is captured, whenever PayPal reports the order approved or waiting for the buyer.
// PayPal cannot be told to stop a link it has issued, so a buyer can still approve after a hold has
// ended, and an approval moves no money until it is captured.
//
// The check and the write to `approved` are one transaction, so a reconciliation that saw a live hold
// cannot reopen an order that was closed a moment later. Locks take the order first and its booking
// second, the same order as any write that closes the order and so releases its hold.
//
// With the hold ended, nothing is captured and a `pending` order closes. An `approved` order had a
// capture sent inside the hold with no known outcome, so it closes only once that capture can no
// longer land: `captureSettleMinutes` after the hold ended, with PayPal still showing no capture. A
// capture PayPal makes after all is still recorded later, as paid, and its booking goes to review.
export async function gateDepositCapture(
  db: Db,
  order: OrderRow,
  reading: "ready_to_capture" | "awaiting_buyer",
  now: Date = new Date(),
): Promise<DepositCaptureDecision> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ paymentStatus: orders.paymentStatus })
      .from(orders)
      .where(eq(orders.id, order.id))
      .for("update");
    const [booking] = await tx
      .select({ status: bookings.status, holdExpiresAt: bookings.holdExpiresAt })
      .from(bookings)
      .where(eq(bookings.orderId, order.id))
      .for("update");
    // Paid or in review since this reconciliation loaded it, and never captured again.
    if (current?.paymentStatus !== "pending" && current?.paymentStatus !== "approved") {
      return { action: "stop" };
    }

    if (booking?.status === "held" && isHoldLive(booking.holdExpiresAt, now)) {
      if (reading === "awaiting_buyer") {
        return { action: "continue" };
      }
      if (current.paymentStatus === "approved") {
        return { action: "capture" };
      }
      await tx
        .update(orders)
        .set({ paymentStatus: "approved" })
        .where(and(eq(orders.id, order.id), eq(orders.paymentStatus, "pending")));
      return { action: "capture" };
    }

    // Marked first, because closing the order would release a hold still marked held as cancelled.
    await tx
      .update(bookings)
      .set({ status: "expired" })
      .where(and(eq(bookings.orderId, order.id), eq(bookings.status, "held")));
    const settled =
      !booking ||
      booking.holdExpiresAt.getTime() + BOOKING_POLICY.captureSettleMinutes * MINUTE_MS <=
        now.getTime();
    await tx
      .update(orders)
      .set({ paymentStatus: "cancelled" })
      .where(
        and(
          eq(orders.id, order.id),
          isNull(orders.paypalCaptureId),
          inArray(orders.paymentStatus, settled ? ["pending", "approved"] : ["pending"]),
        ),
      );
    return { action: "stop" };
  });
}

// Runs in the transaction that marks a deposit order paid, once per order. A capture inside the hold
// confirms. Nothing is captured once a hold has ended, so anything else is a capture PayPal had
// already made: one on its way as the hold ended, or one whose answer was lost. The time may belong
// to someone else by now, so the booking goes to review with the capture on record, for a person to
// refund or rebook. It claims no time in that state and so can never double-book, and it does not
// throw, because the money has moved and the order has to say so.
export async function confirmBookingPayment(
  tx: Tx,
  order: OrderRow,
  now: Date = new Date(),
): Promise<void> {
  if (order.kind !== "booking_deposit") {
    return;
  }

  const [confirmed] = await tx
    .update(bookings)
    .set({ status: "confirmed", depositCaptureId: order.paypalCaptureId })
    .where(
      and(
        eq(bookings.orderId, order.id),
        eq(bookings.status, "held"),
        gt(bookings.holdExpiresAt, now),
      ),
    )
    .returning({ id: bookings.id });
  if (confirmed) {
    return;
  }

  const [booking] = await tx
    .select({ id: bookings.id, status: bookings.status })
    .from(bookings)
    .where(eq(bookings.orderId, order.id))
    .for("update");
  if (!booking || booking.status === "confirmed") {
    console.error("Deposit captured with nothing to confirm", { orderId: order.id });
    return;
  }

  const reviewReason =
    booking.status === "cancelled" ? "captured_after_cancel" : "late_capture";
  await tx
    .update(bookings)
    .set({
      status: "review_required",
      depositCaptureId: order.paypalCaptureId,
      reviewReason,
    })
    .where(eq(bookings.id, booking.id));
  console.error("Booking needs review", { bookingId: booking.id, reviewReason });
}
