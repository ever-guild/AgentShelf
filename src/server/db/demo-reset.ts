import { createHash } from "node:crypto";

import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";

import type { Db } from "./client";
import {
  inventoryAdjustments,
  inventoryAudit,
  inventoryReservations,
  inventoryStock,
  products,
  searchEvents,
  shops,
  technicians,
  technicianWindows,
} from "./schema";
import {
  DEMO_INVENTORY,
  DEMO_PRODUCTS,
  DEMO_SHOP_IDS,
  DEMO_TECHNICIANS,
  DEMO_WINDOWS,
  seedDemoData,
} from "./seed";

const DEMO_RESET_ACTOR_ID = "00000000-0000-0000-0000-000000000000";
const ACTIVE_RESERVATION_STATES = ["reserved", "capture_pending", "review_required"] as const;
const DEMO_RESET_REASON =
  "Synthetic demo reset restored the fixed fixture quantity; not seller-reported stock.";

export class DemoResetRefused extends Error {
  constructor(reason: string) {
    super(`Refusing to reset: ${reason}`);
    this.name = "DemoResetRefused";
  }
}

// The reset deletes rows, so it asks twice. The environment must say that it is a demo, and the
// database must hold no shop that is not one of the demo's. Neither check can be skipped, and a
// database with an unknown shop in it is not a demo database however it is configured.
export function assertDemoEnvironment(env: Record<string, string | undefined>): void {
  if (env.DEMO_ENVIRONMENT?.trim() !== "true") {
    throw new DemoResetRefused(
      "DEMO_ENVIRONMENT is not `true`. Set it only on a demo or sandbox service.",
    );
  }
}

export async function assertOnlyDemoShops(db: Pick<Db, "select">): Promise<void> {
  const [other] = await db
    .select({ others: sql<number>`count(*)::int` })
    .from(shops)
    .where(notInArray(shops.id, [...DEMO_SHOP_IDS]));
  if (other.others > 0) {
    throw new DemoResetRefused(
      `the database holds ${other.others} shop(s) that are not part of the demo.`,
    );
  }
}

export type ResetSummary = {
  removedProducts: number;
  removedFixtures: number;
  restoredStock: number;
};

function resetAdjustmentKey(productId: string, resultVersion: number): string {
  return `demo-reset:stock:v1:${productId}:${resultVersion}`;
}

// Restores only the fixed synthetic SKU/shop pairs from seed.ts. Row locks serialize this with
// reservations and seller adjustments; the audit and idempotency rows share the reset transaction.
async function restoreDemoStock(tx: Parameters<Parameters<Db["transaction"]>[0]>[0]): Promise<number> {
  const productsToRestore = DEMO_INVENTORY.map(({ productId }) => productId);
  await tx
    .select({ id: products.id })
    .from(products)
    .where(inArray(products.id, productsToRestore))
    .orderBy(asc(products.id))
    .for("update");

  const stockRows = await tx
    .select({
      shopId: inventoryStock.shopId,
      productId: inventoryStock.productId,
      mode: inventoryStock.mode,
      onHand: inventoryStock.onHand,
      reserved: inventoryStock.reserved,
      version: inventoryStock.version,
    })
    .from(inventoryStock)
    .where(inArray(inventoryStock.productId, productsToRestore))
    .orderBy(asc(inventoryStock.productId))
    .for("update");

  const active = await tx
    .select({ id: inventoryReservations.id })
    .from(inventoryReservations)
    .where(
      and(
        inArray(inventoryReservations.shopId, [...DEMO_SHOP_IDS]),
        inArray(inventoryReservations.state, [...ACTIVE_RESERVATION_STATES]),
      ),
    )
    .limit(1);
  if (active.length > 0 || stockRows.some((row) => row.reserved > 0)) {
    throw new DemoResetRefused(
      "a demo inventory reservation is still active or unresolved; resolve it before restoring stock.",
    );
  }

  const byProduct = new Map(stockRows.map((row) => [row.productId, row]));
  let restored = 0;
  for (const expected of DEMO_INVENTORY) {
    const row = byProduct.get(expected.productId);
    if (!row) {
      throw new DemoResetRefused("a seeded stock item could not be restored safely.");
    }
    if (row.shopId !== expected.shopId) {
      throw new DemoResetRefused("a seeded stock item is attached to an unexpected shop.");
    }
    if (row.mode !== "tracked" || row.onHand === null) {
      throw new DemoResetRefused(
        "a seeded stock item no longer uses its synthetic tracked policy; review it before resetting.",
      );
    }
    const delta = expected.onHand - row.onHand;
    if (delta === 0) continue;

    const resultVersion = row.version + 1;
    const idempotencyKey = resetAdjustmentKey(row.productId, resultVersion);
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          productId: row.productId,
          delta,
          expectedVersion: row.version,
          reason: DEMO_RESET_REASON,
        }),
      )
      .digest("hex");
    const [updated] = await tx
      .update(inventoryStock)
      .set({ onHand: expected.onHand, version: resultVersion, updatedAt: new Date() })
      .where(
        and(
          eq(inventoryStock.shopId, expected.shopId),
          eq(inventoryStock.productId, expected.productId),
          eq(inventoryStock.version, row.version),
        ),
      )
      .returning({ version: inventoryStock.version });
    if (!updated) {
      throw new DemoResetRefused("inventory changed during reset; run it again after resolving the change.");
    }

    await tx.insert(inventoryAdjustments).values({
      shopId: expected.shopId,
      idempotencyKey,
      requestHash,
      resultVersion: updated.version,
    });
    await tx.insert(inventoryAudit).values({
      shopId: expected.shopId,
      productId: expected.productId,
      actorId: DEMO_RESET_ACTOR_ID,
      eventType: "adjusted",
      quantityDelta: delta,
      reason: DEMO_RESET_REASON,
      idempotencyKey,
      versionAfter: updated.version,
    });
    restored += 1;
  }
  return restored;
}

// Puts the demo's own rows back as the seed writes them, for DEMO_DATE or today. It never touches
// orders, order lines, bookings, webhook receipts or provider references. Unknown demo listings
// are deleted only when nothing refers to them. Active or unresolved inventory holds refuse the
// entire reset; they are never released by this command.
export async function resetDemoData(
  db: Db,
  env: Record<string, string | undefined> = process.env,
): Promise<ResetSummary> {
  assertDemoEnvironment(env);

  return db.transaction(async (tx) => {
    await assertOnlyDemoShops(tx);

    // Lock the fixed SKU rows before checking holds. Reservation creation and seller adjustments
    // lock these same stock rows, so neither can race a restoration or be erased by it.
    const kept = DEMO_PRODUCTS.map((product) => product.id as string);
    await tx
      .select({ id: products.id })
      .from(products)
      .where(inArray(products.id, kept))
      .orderBy(asc(products.id))
      .for("update");

    // Check held stock before seed, fixture, or catalog writes so a refused reset is a no-op.
    const stockRowsBeforeSeed = await tx
      .select({
        shopId: inventoryStock.shopId,
        productId: inventoryStock.productId,
        mode: inventoryStock.mode,
        onHand: inventoryStock.onHand,
        reserved: inventoryStock.reserved,
      })
      .from(inventoryStock)
      .where(inArray(inventoryStock.productId, DEMO_INVENTORY.map(({ productId }) => productId)))
      .orderBy(asc(inventoryStock.productId))
      .for("update");
    const active = await tx
      .select({ id: inventoryReservations.id })
      .from(inventoryReservations)
      .where(
        and(
          inArray(inventoryReservations.shopId, [...DEMO_SHOP_IDS]),
          inArray(inventoryReservations.state, [...ACTIVE_RESERVATION_STATES]),
        ),
      )
      .limit(1);
    if (active.length > 0 || stockRowsBeforeSeed.some((row) => row.reserved > 0)) {
      throw new DemoResetRefused(
        "a demo inventory reservation is still active or unresolved; resolve it before restoring stock.",
      );
    }
    const expectedByProduct = new Map<string, (typeof DEMO_INVENTORY)[number]>(
      DEMO_INVENTORY.map((row) => [row.productId, row]),
    );
    for (const row of stockRowsBeforeSeed) {
      const expected = expectedByProduct.get(row.productId);
      if (!expected || row.shopId !== expected.shopId) {
        throw new DemoResetRefused("a seeded stock item is attached to an unexpected shop.");
      }
      if (row.mode !== "tracked" || row.onHand === null) {
        throw new DemoResetRefused(
          "a seeded stock item no longer uses its synthetic tracked policy; review it before resetting.",
        );
      }
    }

    const removedFixtures = await tx
      .delete(searchEvents)
      .where(eq(searchEvents.origin, "fixture"))
      .returning({ id: searchEvents.id });

    await seedDemoData(tx, env);

    const restoredStock = await restoreDemoStock(tx);

    const removedProducts = await tx
      .delete(products)
      .where(
        and(
          inArray(products.shopId, [...DEMO_SHOP_IDS]),
          notInArray(products.id, kept),
          sql`NOT EXISTS (SELECT 1 FROM order_lines WHERE order_lines.product_id = ${products.id})`,
          sql`NOT EXISTS (SELECT 1 FROM bookings WHERE bookings.service_id = ${products.id})`,
        ),
      )
      .returning({ id: products.id });

    const staff = DEMO_TECHNICIANS.map((person) => person.id);
    await tx
      .delete(technicianWindows)
      .where(
        and(
          // Only the seeded technicians' own hours. Another technician's go with that technician.
          inArray(technicianWindows.technicianId, staff),
          notInArray(technicianWindows.id, DEMO_WINDOWS.map((window) => window.id)),
        ),
      );
    await tx
      .delete(technicians)
      .where(
        and(
          inArray(technicians.shopId, [...DEMO_SHOP_IDS]),
          notInArray(technicians.id, staff),
          sql`NOT EXISTS (SELECT 1 FROM bookings WHERE bookings.technician_id = ${technicians.id})`,
        ),
      );

    return {
      removedProducts: removedProducts.length,
      removedFixtures: removedFixtures.length,
      restoredStock,
    };
  });
}
