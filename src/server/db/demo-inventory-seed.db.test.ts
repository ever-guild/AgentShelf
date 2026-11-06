import { readFileSync } from "node:fs";

import { eq, inArray } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTemporaryDatabase } from "../../../test/database";
import { reserveInventory } from "../inventory/postgres";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import {
  DEMO_CABLE_ID,
  DEMO_CANDLE_GIFT_SET_ID,
  DEMO_CANDLE_ID,
  DEMO_CEDAR_CANDLE_ID,
  DEMO_CHARGER_ID,
  DEMO_PRODUCT_ID,
  DEMO_SERVICE_ID,
  DEMO_SHOP_ID,
  DEMO_SECOND_SHOP_ID,
  DEMO_WICK_TRIMMER_ID,
  seedDemoData,
} from "./seed";
import { importJobs, inventoryAudit, inventoryStock, products, shops } from "./schema";

const expectedDemoStock = [
  { productId: DEMO_PRODUCT_ID, shopId: DEMO_SHOP_ID, onHand: 10 },
  { productId: DEMO_CHARGER_ID, shopId: DEMO_SHOP_ID, onHand: 4 },
  { productId: DEMO_CABLE_ID, shopId: DEMO_SHOP_ID, onHand: 12 },
  { productId: DEMO_CANDLE_ID, shopId: DEMO_SECOND_SHOP_ID, onHand: 8 },
  { productId: DEMO_CEDAR_CANDLE_ID, shopId: DEMO_SECOND_SHOP_ID, onHand: 6 },
  { productId: DEMO_CANDLE_GIFT_SET_ID, shopId: DEMO_SECOND_SHOP_ID, onHand: 3 },
  { productId: DEMO_WICK_TRIMMER_ID, shopId: DEMO_SECOND_SHOP_ID, onHand: 5 },
];

describe("demo inventory seeding", () => {
  let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;
  let connection: ReturnType<typeof createDb>;
  let pool: Pool;

  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    await runMigrations(temporary.url);
    connection = createDb(temporary.url);
    pool = new Pool({ connectionString: temporary.url });
  });

  afterAll(async () => {
    await pool?.end();
    await connection?.close();
    await temporary?.drop();
  });

  it("sets audited demo quantities once and migrates legacy rows as untracked", async () => {
    await seedDemoData(connection.db, {});

    const seeded = await connection.db
      .select({ shopId: inventoryStock.shopId, productId: inventoryStock.productId, mode: inventoryStock.mode, onHand: inventoryStock.onHand, reserved: inventoryStock.reserved, version: inventoryStock.version })
      .from(inventoryStock);
    expect(seeded).toHaveLength(expectedDemoStock.length);
    for (const expected of expectedDemoStock) {
      expect(seeded).toContainEqual({ ...expected, mode: "tracked", reserved: 0, version: 0 });
    }
    expect(seeded.some((stock) => stock.productId === DEMO_SERVICE_ID)).toBe(false);
    const seedAudits = await connection.db
      .select({ productId: inventoryAudit.productId, reason: inventoryAudit.reason })
      .from(inventoryAudit);
    expect(seedAudits).toHaveLength(expectedDemoStock.length);
    expect(seedAudits.every((event) => event.reason.includes("Synthetic demo fixture quantity"))).toBe(true);

    await reserveInventory(
      pool,
      DEMO_SHOP_ID,
      "demo-seed-reservation-0001",
      [{ productId: DEMO_PRODUCT_ID, quantity: 2 }],
      new Date(Date.now() + 60_000),
    );
    await seedDemoData(connection.db, {});
    const [afterReseed] = await connection.db
      .select({ onHand: inventoryStock.onHand, reserved: inventoryStock.reserved, version: inventoryStock.version })
      .from(inventoryStock)
      .where(eq(inventoryStock.productId, DEMO_PRODUCT_ID));
    expect(afterReseed).toEqual({ onHand: 10, reserved: 2, version: 1 });
    expect(
      await connection.db
        .select({ id: inventoryAudit.id })
        .from(inventoryAudit)
        .where(inArray(inventoryAudit.productId, expectedDemoStock.map(({ productId }) => productId))),
    ).toHaveLength(expectedDemoStock.length);

    const legacyProductId = "20000000-0000-4000-8000-000000000201";
    await connection.db.insert(products).values({
      id: legacyProductId,
      shopId: DEMO_SHOP_ID,
      kind: "product",
      status: "published",
      title: "Legacy manual catalog item",
      priceMinor: 500,
    });
    const migrationSql = readFileSync(
      new URL("../../../drizzle/0015_legacy_and_demo_inventory.sql", import.meta.url),
      "utf8",
    );
    await pool.query(migrationSql);
    const [legacyStock] = await connection.db
      .select({ mode: inventoryStock.mode, onHand: inventoryStock.onHand })
      .from(inventoryStock)
      .where(eq(inventoryStock.productId, legacyProductId));
    expect(legacyStock).toEqual({ mode: "untracked", onHand: null });
    const [legacyAudit] = await connection.db
      .select({ reason: inventoryAudit.reason })
      .from(inventoryAudit)
      .where(eq(inventoryAudit.productId, legacyProductId));
    expect(legacyAudit.reason).toContain("quantity was unknown");

    const [importJob] = await connection.db
      .insert(importJobs)
      .values({ shopId: DEMO_SHOP_ID, sourceKind: "csv" })
      .returning({ id: importJobs.id });
    const importedProductId = "20000000-0000-4000-8000-000000000202";
    await connection.db.insert(products).values({
      id: importedProductId,
      shopId: DEMO_SHOP_ID,
      kind: "product",
      status: "published",
      title: "Newly imported item awaiting stock decision",
      priceMinor: 600,
      importJobId: importJob.id,
      importPosition: 0,
    });
    await pool.query(migrationSql);
    expect(
      await connection.db
        .select({ productId: inventoryStock.productId })
        .from(inventoryStock)
        .where(eq(inventoryStock.productId, importedProductId)),
    ).toEqual([]);

    const demoShopRows = await connection.db.select({ id: shops.id }).from(shops);
    expect(demoShopRows).toHaveLength(2);
  });
});
