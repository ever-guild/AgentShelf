import { randomBytes } from "node:crypto";
import type { Pool } from "pg";

import type { Db } from "../src/server/db/client";
import { createSellerInventoryAdapter } from "../src/server/inventory/seller-adapter";
import {
  bookings,
  orderLines,
  orders,
  products,
  shops,
  technicians,
  technicianWindows,
} from "../src/server/db/schema";

const unique = () => randomBytes(8).toString("hex");

export async function createShop(
  db: Db,
  overrides: Partial<typeof shops.$inferInsert> = {},
) {
  const suffix = unique();
  const [shop] = await db
    .insert(shops)
    .values({
      slug: `test-shop-${suffix}`,
      name: `Test Shop ${suffix}`,
      currency: "EUR",
      timezone: "Europe/Riga",
      paypalCredentialRef: "TEST_SHOP",
      paypalMerchantId: `MERCHANT${suffix.toUpperCase()}`,
      ...overrides,
    })
    .returning();
  return shop;
}

export async function createProduct(
  db: Db,
  shopId: string,
  overrides: Partial<typeof products.$inferInsert> = {},
) {
  const [product] = await db
    .insert(products)
    .values({
      shopId,
      kind: "product",
      status: "published",
      title: "Test cable",
      priceMinor: 990,
      ...overrides,
    })
    .returning();
  return product;
}

/** Explicit synthetic stock for tests that exercise a physical checkout. */
export async function setTestTrackedStock(
  db: Db,
  shopId: string,
  productId: string,
  onHand = 100,
) {
  const pool = (db as Db & { $client: Pool }).$client;
  return createSellerInventoryAdapter(pool).setMode(
    { actorId: "00000000-0000-4000-8000-000000000099", shopId },
    {
      productId,
      mode: "tracked",
      onHand,
      idempotencyKey: `test-stock:${productId}`,
      reason: "Synthetic tracked quantity for a physical checkout test.",
    },
  );
}

export async function createTrackedProduct(
  db: Db,
  shopId: string,
  overrides: Partial<typeof products.$inferInsert> = {},
  onHand = 100,
) {
  const product = await createProduct(db, shopId, overrides);
  await setTestTrackedStock(db, shopId, product.id, onHand);
  return product;
}

export function createService(
  db: Db,
  shopId: string,
  overrides: Partial<typeof products.$inferInsert> = {},
) {
  return createProduct(db, shopId, {
    kind: "service",
    title: "Test repair",
    priceMinor: 8000,
    serviceDurationMinutes: 60,
    depositMinor: 2000,
    ...overrides,
  });
}

export async function createTechnician(db: Db, shopId: string) {
  const [technician] = await db
    .insert(technicians)
    .values({ shopId, name: `Technician ${unique()}` })
    .returning();
  return technician;
}

// A weekly working window, in the shop's own time. 09:00 to 18:00 on a Monday unless overridden.
export async function createWindow(
  db: Db,
  technician: { id: string; shopId: string },
  overrides: Partial<typeof technicianWindows.$inferInsert> = {},
) {
  const [window] = await db
    .insert(technicianWindows)
    .values({
      technicianId: technician.id,
      shopId: technician.shopId,
      weekday: 1,
      startMinute: 9 * 60,
      endMinute: 18 * 60,
      ...overrides,
    })
    .returning();
  return window;
}

export async function createOrder(
  db: Db,
  shopId: string,
  overrides: Partial<typeof orders.$inferInsert> = {},
) {
  const [order] = await db
    .insert(orders)
    .values({
      shopId,
      kind: "purchase",
      currency: "EUR",
      totalMinor: 990,
      idempotencyKey: `key-${unique()}`,
      requestFingerprint: "test-fingerprint",
      payeeMerchantId: "TESTMERCHANT",
      ...overrides,
    })
    .returning();
  return order;
}

export async function createOrderLine(
  db: Db,
  order: { id: string; shopId: string },
  productId: string,
  overrides: Partial<typeof orderLines.$inferInsert> = {},
) {
  const [line] = await db
    .insert(orderLines)
    .values({
      orderId: order.id,
      shopId: order.shopId,
      productId,
      title: "Test cable",
      unitPriceMinor: 990,
      quantity: 1,
      lineTotalMinor: 990,
      ...overrides,
    })
    .returning();
  return line;
}

export const NOON = new Date("2026-11-10T10:00:00Z");
export const hoursAfterNoon = (hours: number) =>
  new Date(NOON.getTime() + hours * 60 * 60 * 1000);

// A held booking on a fresh deposit order, unless overridden.
export async function createBooking(
  db: Db,
  shopId: string,
  serviceId: string,
  technicianId: string,
  overrides: Partial<typeof bookings.$inferInsert> = {},
) {
  const orderId =
    overrides.orderId ??
    (await createOrder(db, shopId, { kind: "booking_deposit" })).id;
  const [booking] = await db
    .insert(bookings)
    .values({
      shopId,
      serviceId,
      technicianId,
      orderId,
      startsAt: NOON,
      endsAt: hoursAfterNoon(1),
      holdExpiresAt: hoursAfterNoon(-1),
      servicePriceMinor: 8000,
      ...overrides,
    })
    .returning();
  return booking;
}

// Resolves to the name of the constraint the database enforced. Fails the test if the write
// succeeded, or if it failed for a reason other than a named constraint.
export async function violatedConstraint(
  write: PromiseLike<unknown>,
): Promise<string> {
  const error: { cause?: { constraint?: string }; constraint?: string } =
    await write.then(
      () => {
        throw new Error("Expected the database to reject this write");
      },
      (rejection) => rejection,
    );
  const constraint = error.cause?.constraint ?? error.constraint;
  if (!constraint) {
    throw error;
  }
  return constraint;
}
