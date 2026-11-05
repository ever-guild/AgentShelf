import { count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTemporaryDatabase } from "../../../test/database";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import { products, shops } from "./schema";
import { DEMO_PRODUCT_ID, DEMO_SHOP_ID, seedDemoData } from "./seed";

describe("a clean database", () => {
  let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;
  let connection: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    connection = createDb(temporary.url);
  });

  afterAll(async () => {
    await connection.close();
    await temporary.drop();
  });

  const appliedMigrations = async () => {
    const { rows } = await connection.db.execute(
      sql`SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations`,
    );
    return rows[0].applied;
  };

  it("migrates, and migrating again changes nothing", async () => {
    await runMigrations(temporary.url);
    const applied = await appliedMigrations();
    expect(applied).toBeGreaterThan(0);

    await runMigrations(temporary.url);
    expect(await appliedMigrations()).toBe(applied);
  });

  it("seeds twice without duplicating a row or changing an identifier", async () => {
    await seedDemoData(connection.db, {});
    await seedDemoData(connection.db, {});

    expect(await connection.db.select({ n: count() }).from(shops)).toEqual([
      { n: 1 },
    ]);
    expect(await connection.db.select({ n: count() }).from(products)).toEqual([
      { n: 1 },
    ]);

    const [shop] = await connection.db.select().from(shops);
    expect(shop).toMatchObject({
      id: DEMO_SHOP_ID,
      currency: "EUR",
      timezone: "Europe/Riga",
    });

    const [product] = await connection.db.select().from(products);
    expect(product).toMatchObject({
      id: DEMO_PRODUCT_ID,
      shopId: DEMO_SHOP_ID,
      status: "published",
      priceMinor: 990,
    });
  });

  it("stores account settings only as a hash or a reference, and a later seed keeps them", async () => {
    await seedDemoData(connection.db, {
      DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID: "SANDBOXMERCHANT",
      DEMO_PHONE_WORKSHOP_SELLER_CODE: "a-demo-access-code",
    });
    const readShop = async () =>
      (
        await connection.db
          .select()
          .from(shops)
          .where(eq(shops.id, DEMO_SHOP_ID))
      )[0];

    const first = await readShop();
    expect(first.paypalMerchantId).toBe("SANDBOXMERCHANT");
    expect(first.sellerAccessCodeHash).toMatch(/^scrypt\$/);
    expect(first.sellerAccessCodeHash).not.toContain("a-demo-access-code");

    await seedDemoData(connection.db, {});
    const second = await readShop();
    expect(second.paypalMerchantId).toBe("SANDBOXMERCHANT");
    expect(second.sellerAccessCodeHash).toBe(first.sellerAccessCodeHash);
  });
});
