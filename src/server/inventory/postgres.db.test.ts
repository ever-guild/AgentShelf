import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDb, type Db } from "../db/client";
import { runMigrations } from "../db/migrate";
import { createProduct, createShop } from "../../../test/fixtures";
import { createTemporaryDatabase } from "../../../test/database";
import { beginInventoryCapture, commitReservation, releaseReservation, reserveInventory } from "./postgres";
import { createSellerInventoryAdapter } from "./seller-adapter";

const seller = { shopId: "", actorId: "00000000-0000-4000-8000-000000000099" };
let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;
let connection: ReturnType<typeof createDb>;
let db: Db;
let pool: Pool;
let stockAdapter: ReturnType<typeof createSellerInventoryAdapter>;
let productId = "";

function chooseTracked(product: string, quantity: number, idempotencyKey = "inventory-decision-key-0001") {
  return stockAdapter.setMode(seller, {
    productId: product,
    mode: "tracked",
    onHand: quantity,
    idempotencyKey,
    reason: "Initial physical stock count",
  });
}

describe("inventory Postgres module", () => {
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    await runMigrations(temporary.url);
    connection = createDb(temporary.url);
    db = connection.db;
    pool = new Pool({ connectionString: temporary.url });
    stockAdapter = createSellerInventoryAdapter(pool);
    const draft = await readFile(resolve(process.cwd(), "drizzle/inventory-module-draft.sql"), "utf8");
    await pool.query(draft);
  });

  beforeEach(async () => {
    const shop = await createShop(db);
    seller.shopId = shop.id;
    const product = await createProduct(db, shop.id);
    productId = product.id;
  });

  afterAll(async () => {
    await pool?.end();
    await connection?.close();
    await temporary?.drop();
  });

  it("fails closed before an inventory decision and keeps multi-line reservations atomic", async () => {
    const second = await createProduct(db, seller.shopId);
    await chooseTracked(productId, 1);
    await chooseTracked(productId, 1);
    expect(await stockAdapter.read(seller, productId)).toMatchObject({ onHand: 1, version: 0 });
    await chooseTracked(second.id, 0, "inventory-decision-key-0002");
    const noDecision = await createProduct(db, seller.shopId);
    await expect(reserveInventory(pool, seller.shopId, "reservation-key-0001", [{ productId: noDecision.id, quantity: 1 }], new Date(Date.now() + 60_000))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(reserveInventory(pool, seller.shopId, "reservation-key-0002", [
      { productId: productId, quantity: 1 }, { productId: second.id, quantity: 1 },
    ], new Date(Date.now() + 60_000))).rejects.toMatchObject({ code: "INSUFFICIENT" });
    expect(await stockAdapter.read(seller, productId)).toMatchObject({ onHand: 1, reserved: 0, available: 1 });
  });

  it("serializes competing carts so they cannot reserve the same final unit", async () => {
    await chooseTracked(productId, 1);
    const attempts = await Promise.allSettled([
      reserveInventory(pool, seller.shopId, "reservation-key-race-1", [{ productId, quantity: 1 }], new Date(Date.now() + 60_000)),
      reserveInventory(pool, seller.shopId, "reservation-key-race-2", [{ productId, quantity: 1 }], new Date(Date.now() + 60_000)),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await stockAdapter.read(seller, productId)).toMatchObject({ onHand: 1, reserved: 1, available: 0 });
  });

  it("serializes retries with the same key and refuses a different cart fingerprint", async () => {
    await chooseTracked(productId, 4);
    const expiry = new Date(Date.now() + 60_000);
    const [first, retry] = await Promise.all([
      reserveInventory(pool, seller.shopId, "reservation-key-repeat-1", [{ productId, quantity: 2 }], expiry),
      reserveInventory(pool, seller.shopId, "reservation-key-repeat-1", [{ productId, quantity: 2 }], expiry),
    ]);
    expect(first.id).toBe(retry.id);
    expect(await stockAdapter.read(seller, productId)).toMatchObject({ reserved: 2, available: 2 });
    await expect(reserveInventory(pool, seller.shopId, "reservation-key-repeat-1", [{ productId, quantity: 1 }], expiry)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps stock reads scoped to the seller principal's shop", async () => {
    await chooseTracked(productId, 3);
    const otherShop = await createShop(db);
    const otherProduct = await createProduct(db, otherShop.id);
    await stockAdapter.setMode({ shopId: otherShop.id, actorId: seller.actorId }, {
      productId: otherProduct.id,
      mode: "tracked",
      onHand: 9,
      idempotencyKey: "other-shop-decision-01",
      reason: "Initial physical stock count",
    });
    await expect(stockAdapter.read(seller, otherProduct.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("makes adjustments versioned and idempotent, then commits a verified capture exactly once", async () => {
    await chooseTracked(productId, 3);
    await expect(chooseTracked(productId, 99, "inventory-decision-key-0002")).rejects.toMatchObject({ code: "CONFLICT" });
    const adjusted = await stockAdapter.adjust(seller, { productId, delta: 2, expectedVersion: 0, idempotencyKey: "adjustment-key-0001", reason: "Received five new units" });
    await stockAdapter.adjust(seller, { productId, delta: 2, expectedVersion: 0, idempotencyKey: "adjustment-key-0001", reason: "Received five new units" });
    expect(adjusted).toMatchObject({ onHand: 5, version: 1 });
    const audit = await pool.query<{ id: string }>("SELECT id FROM inventory_audit WHERE shop_id=$1 AND product_id=$2 AND event_type='adjusted'", [seller.shopId, productId]);
    await expect(pool.query("UPDATE inventory_audit SET reason='rewritten' WHERE id=$1", [audit.rows[0].id])).rejects.toThrow("immutable");
    await expect(stockAdapter.adjust(seller, { productId, delta: 1, expectedVersion: 0, idempotencyKey: "adjustment-key-0002", reason: "Counted one more" })).rejects.toMatchObject({ code: "CONFLICT" });

    const reservation = await reserveInventory(pool, seller.shopId, "reservation-key-commit-1", [{ productId, quantity: 2 }], new Date(Date.now() + 60_000));
    const captureStartedAt = new Date();
    const permits = await Promise.all([
      beginInventoryCapture(pool, seller.shopId, reservation.id, captureStartedAt),
      beginInventoryCapture(pool, seller.shopId, reservation.id, captureStartedAt),
    ]);
    expect(permits.filter((permit) => permit.allowed)).toHaveLength(1);
    expect(permits.filter((permit) => !permit.allowed)).toEqual([{ allowed: false, reason: "already_started" }]);
    const proof = { captureId: "capture-unique-1", providerStatus: "COMPLETED" as const, capturedAt: new Date(captureStartedAt.getTime() + 1000), verified: true as const };
    await Promise.all([
      commitReservation(pool, seller.shopId, reservation.id, proof),
      commitReservation(pool, seller.shopId, reservation.id, proof),
    ]);
    expect(await stockAdapter.read(seller, productId)).toMatchObject({ onHand: 3, reserved: 0, available: 3 });
    await expect(commitReservation(pool, seller.shopId, reservation.id, { ...proof, captureId: "different-capture-id" })).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
  });

  it("releases only verified unpaid reservations and routes a late capture to review", async () => {
    await chooseTracked(productId, 2);
    const released = await reserveInventory(pool, seller.shopId, "reservation-key-release-1", [{ productId, quantity: 1 }], new Date(Date.now() + 60_000));
    await releaseReservation(pool, seller.shopId, released.id, "verified_cancelled");
    await expect(commitReservation(pool, seller.shopId, released.id, { captureId: "capture-late-release", providerStatus: "COMPLETED", capturedAt: new Date(), verified: true })).resolves.toMatchObject({ state: "review_required" });
    await expect(commitReservation(pool, seller.shopId, released.id, { captureId: "different-late-capture", providerStatus: "COMPLETED", capturedAt: new Date(), verified: true })).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    const stored = await pool.query<{ capture_id: string }>("SELECT capture_id FROM inventory_reservations WHERE id=$1", [released.id]);
    expect(stored.rows[0].capture_id).toBe("capture-late-release");
    expect(await stockAdapter.read(seller, productId)).toMatchObject({ onHand: 2, reserved: 0, available: 2 });

    const expired = await reserveInventory(pool, seller.shopId, "reservation-key-expiry-1", [{ productId, quantity: 2 }], new Date(Date.now() + 60_000));
    await pool.query("UPDATE inventory_reservations SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
    await expect(beginInventoryCapture(pool, seller.shopId, expired.id)).resolves.toMatchObject({ allowed: false, reason: "expired" });
    await expect(commitReservation(pool, seller.shopId, expired.id, { captureId: "capture-after-expiry", providerStatus: "COMPLETED", capturedAt: new Date(), verified: true })).resolves.toMatchObject({ state: "review_required" });
    expect(await stockAdapter.read(seller, productId)).toMatchObject({ onHand: 2, reserved: 2, available: 0 });
  });

});
