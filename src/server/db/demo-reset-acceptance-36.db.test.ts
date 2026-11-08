import { randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import { createFakePayPal } from "../../../test/paypal-fake";
import { createPayPalProvider } from "../paypal/orders";
import { createCheckout } from "../services/checkout";
import { resetDemoData } from "./demo-reset";
import {
  inventoryAdjustments,
  inventoryAudit,
  inventoryReservationLines,
  inventoryReservations,
  inventoryStock,
  products,
  searchEvents,
} from "./schema";
import { DEMO_PRODUCT_ID, DEMO_SHOP_ID, seedDemoData } from "./seed";

// Independent acceptance of the #36 F6 demo reset (d495da1): every unresolved hold refuses the
// whole reset, and a reset racing real checkouts leaves either the old or the restored state,
// with stock.reserved always equal to the live reservations.
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

async function snapshot() {
  const db = getDb();
  const [product] = await db.select({ priceMinor: products.priceMinor }).from(products).where(eq(products.id, DEMO_PRODUCT_ID));
  const [stock] = await db
    .select({ onHand: inventoryStock.onHand, reserved: inventoryStock.reserved, version: inventoryStock.version })
    .from(inventoryStock)
    .where(eq(inventoryStock.productId, DEMO_PRODUCT_ID));
  const [live] = await db
    .select({ quantity: sql<number>`coalesce(sum(${inventoryReservationLines.quantity}), 0)::int` })
    .from(inventoryReservationLines)
    .innerJoin(inventoryReservations, eq(inventoryReservations.id, inventoryReservationLines.reservationId))
    .where(
      inArray(inventoryReservations.state, ["reserved", "capture_pending"]),
    );
  return {
    priceMinor: product.priceMinor,
    stock,
    liveReserved: live.quantity,
    audit: (await db.select().from(inventoryAudit)).length,
    adjustments: (await db.select().from(inventoryAdjustments)).length,
    fixtures: await db.select().from(searchEvents).where(eq(searchEvents.origin, "fixture")),
  };
}

async function divergeFromSeed() {
  await seedDemoData(getDb(), DEMO_ENV);
  await getDb().update(products).set({ priceMinor: 1 }).where(eq(products.id, DEMO_PRODUCT_ID));
  await getDb().update(inventoryStock).set({ onHand: 8, version: 2 }).where(eq(inventoryStock.productId, DEMO_PRODUCT_ID));
}

describe("#36 F6 acceptance: demo reset", () => {
  it.each(["reserved", "review_required"] as const)(
    "refuses a %s reservation without changing any demo row",
    async (state) => {
      await divergeFromSeed();
      const reservationId = randomUUID();
      await getDb().insert(inventoryReservations).values({
        id: reservationId,
        shopId: DEMO_SHOP_ID,
        idempotencyKey: `demo-reset-acceptance-${state}`,
        requestHash: "b".repeat(64),
        state,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await getDb().insert(inventoryReservationLines).values({ reservationId, shopId: DEMO_SHOP_ID, productId: DEMO_PRODUCT_ID, quantity: 1 });
      const before = await snapshot();

      await expect(resetDemoData(getDb(), DEMO_ENV)).rejects.toThrow("active or unresolved");

      expect(await snapshot()).toEqual(before);
      const [reservation] = await getDb().select().from(inventoryReservations).where(eq(inventoryReservations.id, reservationId));
      expect(reservation.state).toBe(state);
    },
  );

  it.each([0, 0, 2, 5, 10, 20, 40, 80])("race with reset delayed %ims: reset and checkouts end all-or-nothing with consistent holds", async (delayMs) => {
    await divergeFromSeed();
    const paypal = createFakePayPal();
    const paypalFor = createPayPalProvider(
      { PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP: "phone-client", PAYPAL_CLIENT_SECRET_DEMO_PHONE_WORKSHOP: "phone-secret" },
      paypal.adapter,
    );
    const before = await snapshot();
    const checkout = () => createCheckout(getDb(), { items: [{ productId: DEMO_PRODUCT_ID, quantity: 1 }], idempotencyKey: randomUUID() }, { paypalFor });

    const delayedReset = new Promise<void>((resolve) => setTimeout(resolve, delayMs)).then(() => resetDemoData(getDb(), DEMO_ENV));
    const [reset, ...checkouts] = await Promise.allSettled([delayedReset, checkout(), checkout(), checkout()]);
    const after = await snapshot();
    const created = checkouts.filter((result) => result.status === "fulfilled").length;
    const errorCode = (reason: unknown) => {
      const error = reason as { code?: string; cause?: { code?: string } };
      return String(error?.cause?.code ?? error?.code ?? reason);
    };
    const failures = checkouts.flatMap((result) => (result.status === "rejected" ? [errorCode(result.reason)] : []));

    // All-or-nothing holds even when a transaction is aborted.
    expect(after.stock.reserved).toBe(after.liveReserved);
    expect(after.liveReserved).toBe(created);
    if (reset.status === "fulfilled") {
      expect(after).toMatchObject({ priceMinor: 990, stock: { onHand: 10, version: 3 + created }, audit: before.audit + 1, adjustments: before.adjustments + 1 });
    } else {
      expect(after).toMatchObject({ priceMinor: 1, stock: { onHand: 8, version: 2 + created }, audit: before.audit, adjustments: before.adjustments, fixtures: before.fixtures });
    }

    // The reset's lock order must not deadlock with checkout: buyers keep succeeding and a reset
    // that cannot run refuses with its own reason (PostgreSQL 40P01 here means a lock-order bug).
    expect(failures).toEqual([]);
    if (reset.status === "rejected") expect(String(reset.reason)).toMatch(/Refusing to reset: .*(active or unresolved|unresolved payment)/);
  });
});
