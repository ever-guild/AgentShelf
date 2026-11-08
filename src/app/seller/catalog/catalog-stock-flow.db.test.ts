import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTemporaryDatabase } from "../../../../test/database";
import { createProduct, createShop } from "../../../../test/fixtures";
import { createPaymentHarness } from "../../../../test/payments";
import { createDb, type Db } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { createSellerInventoryAdapter } from "@/server/inventory/seller-adapter";
import { searchProducts } from "@/server/services/catalog";
import { createCheckout } from "@/server/services/checkout";
import { getStorefront } from "@/server/services/storefront";
import {
  classifyInventoryReadResult,
  formatSellerProductStockSummary,
} from "./stock-control-state";

const actorId = "00000000-0000-4000-8000-000000000077";

describe("#36 F1: imported product stock policy -> checkout reservation & buyer discovery inspection", () => {
  let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let pool: Pool;

  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    await runMigrations(temporary.url);
    connection = createDb(temporary.url);
    db = connection.db;
    pool = new Pool({ connectionString: temporary.url });
  });

  afterAll(async () => {
    await pool?.end();
    await connection?.close();
    await temporary?.drop();
  });

  it("blocks checkout before policy is set, enables checkout after tracked policy, and reflects held units in seller stock read", async () => {
    process.env.APP_ORIGIN = "https://shop.example";
    const harness = createPaymentHarness();
    const shop = await createShop(db);
    const product = await createProduct(db, shop.id, {
      title: "Imported Braided Cable",
      priceMinor: 1490,
    });
    const adapter = createSellerInventoryAdapter(pool);

    // 1. Before policy is set, adapter.read throws NOT_FOUND ("Inventory record was not found.")
    await expect(
      adapter.read({ actorId, shopId: shop.id }, product.id),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Inventory record was not found.",
    });

    const undecidedState = classifyInventoryReadResult(404, {
      error: { code: "NOT_FOUND", message: "Inventory record was not found." },
    });
    expect(undecidedState).toEqual({ status: "undecided" });
    expect(formatSellerProductStockSummary("available", undecidedState)).toBe(
      "Stock decision required",
    );

    // Buyer discovery (catalog.ts / storefront.ts) still exposes products.availability = "available"
    const searchBefore = await searchProducts(
      db,
      { query: "Braided Cable", limit: 10 },
      { recordDemand: false },
    );
    expect(
      searchBefore.products.find((p) => p.productId === product.id)?.availability,
    ).toBe("available");
    const storefrontBefore = await getStorefront(
      db,
      shop.slug,
      "en",
      harness.deps.paypalFor,
    );
    expect(
      storefrontBefore.products.find((p) => p.id === product.id)?.availability,
    ).toBe("available");

    // Checkout fails closed before stock policy is configured
    await expect(
      createCheckout(
        db,
        {
          items: [{ productId: product.id, quantity: 1 }],
          idempotencyKey: randomUUID(),
        },
        harness.deps,
      ),
    ).rejects.toMatchObject({
      code: "PRODUCT_UNAVAILABLE",
    });

    // 2. Seller sets policy to tracked with onHand = 3
    const afterPolicy = await adapter.setMode(
      { actorId, shopId: shop.id },
      {
        productId: product.id,
        mode: "tracked",
        onHand: 3,
        idempotencyKey: `policy-${randomUUID()}`,
        reason: "Initial stock count from CSV",
      },
    );
    expect(afterPolicy).toMatchObject({
      productId: product.id,
      mode: "tracked",
      onHand: 3,
      reserved: 0,
      available: 3,
      version: 0,
    });

    // 3. Buyer checkout for 1 unit now succeeds and holds 1 unit
    const checkout = await createCheckout(
      db,
      {
        items: [{ productId: product.id, quantity: 1 }],
        idempotencyKey: randomUUID(),
      },
      harness.deps,
    );
    expect(checkout.orderId).toBeTruthy();

    const afterHold = await adapter.read({ actorId, shopId: shop.id }, product.id);
    expect(afterHold).toMatchObject({
      mode: "tracked",
      onHand: 3,
      reserved: 1,
      available: 2,
      version: 1,
    });
  });

  it("blocks checkout when tracked stock is 0 and enables checkout after seller adjustment (+2)", async () => {
    process.env.APP_ORIGIN = "https://shop.example";
    const harness = createPaymentHarness();
    const shop = await createShop(db);
    const product = await createProduct(db, shop.id, {
      title: "Zero Stock Protector",
      priceMinor: 950,
    });
    const adapter = createSellerInventoryAdapter(pool);

    const zeroStock = await adapter.setMode(
      { actorId, shopId: shop.id },
      {
        productId: product.id,
        mode: "tracked",
        onHand: 0,
        idempotencyKey: `policy-zero-${randomUUID()}`,
        reason: "Out of stock at import",
      },
    );
    expect(zeroStock).toMatchObject({
      mode: "tracked",
      onHand: 0,
      reserved: 0,
      available: 0,
      version: 0,
    });

    // Buyer discovery still reports availability: "available" even when available = 0
    const searchAtZero = await searchProducts(
      db,
      { query: "Zero Stock Protector", limit: 10 },
      { recordDemand: false },
    );
    expect(
      searchAtZero.products.find((p) => p.productId === product.id)?.availability,
    ).toBe("available");

    // Checkout fails closed when available = 0
    await expect(
      createCheckout(
        db,
        {
          items: [{ productId: product.id, quantity: 1 }],
          idempotencyKey: randomUUID(),
        },
        harness.deps,
      ),
    ).rejects.toMatchObject({
      code: "PRODUCT_UNAVAILABLE",
    });

    // Seller adjusts quantity by +2 at expectedVersion = 0
    const adjusted = await adapter.adjust(
      { actorId, shopId: shop.id },
      {
        productId: product.id,
        delta: 2,
        expectedVersion: 0,
        idempotencyKey: `adjust-${randomUUID()}`,
        reason: "Restock shipment",
      },
    );
    expect(adjusted).toMatchObject({
      mode: "tracked",
      onHand: 2,
      reserved: 0,
      available: 2,
      version: 1,
    });

    // Checkout now succeeds
    const checkout = await createCheckout(
      db,
      {
        items: [{ productId: product.id, quantity: 1 }],
        idempotencyKey: randomUUID(),
      },
      harness.deps,
    );
    expect(checkout.orderId).toBeTruthy();
  });
});
