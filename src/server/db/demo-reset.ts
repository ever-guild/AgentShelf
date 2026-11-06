import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import type { Db } from "./client";
import { products, searchEvents, shops, technicians, technicianWindows } from "./schema";
import {
  DEMO_PRODUCTS,
  DEMO_SHOP_IDS,
  DEMO_TECHNICIANS,
  DEMO_WINDOWS,
  seedDemoData,
} from "./seed";

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

export async function assertOnlyDemoShops(db: Db): Promise<void> {
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

export type ResetSummary = { removedProducts: number; removedFixtures: number };

// Puts the demo's own rows back as the seed writes them, for the date in DEMO_DATE or today. It
// never touches anything that records money or PayPal: orders, their lines, bookings, webhook
// receipts and every provider reference on a shop or a product stay exactly as they are. Rows that
// the seed does not know about go only while nothing of that kind refers to them. Safe to repeat.
export async function resetDemoData(
  db: Db,
  env: Record<string, string | undefined> = process.env,
): Promise<ResetSummary> {
  assertDemoEnvironment(env);
  await assertOnlyDemoShops(db);

  // Fixtures are rewritten by the seed, at the dates of this run. Observed searches are not touched.
  const removedFixtures = await db
    .delete(searchEvents)
    .where(eq(searchEvents.origin, "fixture"))
    .returning({ id: searchEvents.id });

  await seedDemoData(db, env);

  return db.transaction(async (tx) => {
    const kept = DEMO_PRODUCTS.map((product) => product.id as string);
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
    };
  });
}
