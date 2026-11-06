import { count, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTemporaryDatabase } from "../../../test/database";
import { createDb } from "./client";
import { prepareDatabase, runMigrations } from "./migrate";
import { products, shops, technicians, technicianWindows } from "./schema";
import {
  DEMO_PRODUCT_ID,
  DEMO_SERVICE_ID,
  DEMO_SHOP_ID,
  seedDemoData,
} from "./seed";

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
      { n: 2 },
    ]);
    expect(await connection.db.select({ n: count() }).from(products)).toEqual([
      { n: 8 },
    ]);
    expect(await connection.db.select({ n: count() }).from(technicians)).toEqual([
      { n: 2 },
    ]);
    expect(
      await connection.db.select({ n: count() }).from(technicianWindows),
    ).toEqual([{ n: 12 }]);

    const [shop] = await connection.db
      .select()
      .from(shops)
      .where(eq(shops.id, DEMO_SHOP_ID));
    expect(shop).toMatchObject({
      id: DEMO_SHOP_ID,
      currency: "EUR",
      timezone: "Europe/Riga",
    });

    const [product] = await connection.db
      .select()
      .from(products)
      .where(eq(products.id, DEMO_PRODUCT_ID));
    expect(product).toMatchObject({
      shopId: DEMO_SHOP_ID,
      status: "published",
      priceMinor: 990,
    });

    const [service] = await connection.db
      .select()
      .from(products)
      .where(eq(products.id, DEMO_SERVICE_ID));
    expect(service).toMatchObject({
      shopId: DEMO_SHOP_ID,
      kind: "service",
      status: "published",
      priceMinor: 8000,
      serviceDurationMinutes: 60,
      depositMinor: 2000,
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

describe("starting the service", () => {
  const ON_RENDER = { RENDER: "true" };
  let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;
  let connection: ReturnType<typeof createDb>;

  beforeEach(async () => {
    temporary = await createTemporaryDatabase();
    connection = createDb(temporary.url);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await connection.close();
    await temporary.drop();
  });

  const countOf = async (table: typeof shops | typeof products) => {
    const [{ n }] = await connection.db.select({ n: count() }).from(table);
    return n;
  };

  it("gives an empty database the demo data on Render", async () => {
    await prepareDatabase(temporary.url, ON_RENDER);

    expect(await countOf(shops)).toBe(2);
    expect(await countOf(products)).toBe(8);
  });

  it.each([
    ["no flag", {}],
    ["another value", { RENDER: "false" }],
  ])("migrates and seeds nothing outside Render, with %s", async (_name, env) => {
    await prepareDatabase(temporary.url, env);

    expect(await countOf(shops)).toBe(0);
  });

  it("leaves a database holding any shop alone", async () => {
    await prepareDatabase(temporary.url, {});
    await connection.db.insert(shops).values({
      slug: "a-real-shop",
      name: "A real shop",
      location: "Riga",
      currency: "EUR",
      timezone: "Europe/Riga",
      paypalCredentialRef: "A_REAL_SHOP",
    });

    await prepareDatabase(temporary.url, ON_RENDER);

    expect(await countOf(shops)).toBe(1);
    expect(await countOf(products)).toBe(0);
  });

  it("keeps what was changed in the demo on every later start", async () => {
    await prepareDatabase(temporary.url, ON_RENDER);
    await connection.db
      .update(products)
      .set({ priceMinor: 1234 })
      .where(eq(products.id, DEMO_PRODUCT_ID));

    await prepareDatabase(temporary.url, ON_RENDER);

    const [product] = await connection.db
      .select()
      .from(products)
      .where(eq(products.id, DEMO_PRODUCT_ID));
    expect(product.priceMinor).toBe(1234);
  });

  it("still starts when the seed fails, and logs no detail", async () => {
    await prepareDatabase(temporary.url, {
      ...ON_RENDER,
      DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID: "THESAMEMERCHANT",
      DEMO_SECOND_SHOP_PAYPAL_MERCHANT_ID: "THESAMEMERCHANT",
    });

    expect(await countOf(shops)).toBe(0);
    expect(console.error).toHaveBeenCalledWith("Demo seed failed", { error: "Error" });

    await prepareDatabase(temporary.url, ON_RENDER);
    expect(await countOf(shops)).toBe(2);
  });

  it("does not start when a migration fails", async () => {
    await expect(
      prepareDatabase("postgres://postgres@127.0.0.1:1/nothing", ON_RENDER),
    ).rejects.toThrow();
  });
});
