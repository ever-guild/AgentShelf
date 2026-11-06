import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { AdjustInventoryInput, InventoryLine } from "../contracts/inventory";
import { adjustInventoryInput, inventoryLines } from "../contracts/inventory";
import type { InventoryPrincipal, Reservation, StockLevel } from "./types";

type Queryable = Pick<PoolClient, "query">;
type StockRow = QueryResultRow & {
  product_id: string;
  mode: "tracked" | "untracked";
  on_hand: number | null;
  reserved: number | null;
  version: number;
};
const MAX_STOCK = 1_000_000;

export class InventoryError extends Error {
  constructor(readonly code: "INVALID" | "NOT_FOUND" | "INSUFFICIENT" | "CONFLICT" | "REVIEW_REQUIRED", message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

function assertPrincipal(principal: InventoryPrincipal): void {
  if (!principal.shopId || !principal.actorId) throw new InventoryError("INVALID", "Authenticated seller context is required.");
}

function checksum(lines: readonly InventoryLine[]): string {
  const normalized = [...lines].sort((a, b) => a.productId.localeCompare(b.productId));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function parseLines(input: unknown): InventoryLine[] {
  const parsed = inventoryLines.safeParse(input);
  if (!parsed.success) throw new InventoryError("INVALID", "Inventory lines must contain unique products and positive integer quantities.");
  return parsed.data;
}

function rowToLevel(row: StockRow): StockLevel {
  return {
    productId: row.product_id,
    mode: row.mode,
    onHand: row.on_hand,
    reserved: row.reserved,
    available: row.mode === "tracked" ? Number(row.on_hand) - Number(row.reserved) : null,
    version: Number(row.version),
  };
}

export async function readStock(pool: Pool, principal: InventoryPrincipal, productId: string): Promise<StockLevel> {
  assertPrincipal(principal);
  const result = await pool.query<StockRow>(
    `SELECT product_id, mode, on_hand, reserved, version FROM inventory_stock
     WHERE shop_id = $1 AND product_id = $2`,
    [principal.shopId, productId],
  );
  if (!result.rowCount) throw new InventoryError("NOT_FOUND", "Inventory record was not found.");
  return rowToLevel(result.rows[0]);
}

export async function setInventoryMode(
  pool: Pool,
  principal: InventoryPrincipal,
  productId: string,
  decision: { mode: "tracked"; onHand: number; idempotencyKey: string; reason: string } | { mode: "untracked"; idempotencyKey: string; reason: string },
): Promise<StockLevel> {
  assertPrincipal(principal);
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(decision.idempotencyKey) || decision.reason.trim().length < 3 || decision.reason.trim().length > 500) {
    throw new InventoryError("INVALID", "An explicit inventory decision requires a stable key and a reason.");
  }
  if (decision.mode === "tracked" && (!Number.isSafeInteger(decision.onHand) || decision.onHand < 0 || decision.onHand > MAX_STOCK)) {
    throw new InventoryError("INVALID", "Initial on-hand quantity must be a non-negative integer up to 1,000,000.");
  }
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [principal.shopId, decision.idempotencyKey]);
    const reason = decision.reason.trim();
    const requestHash = createHash("sha256").update(JSON.stringify({ productId, ...decision, reason })).digest("hex");
    const priorDecision = await client.query<{ request_hash: string }>(
      "SELECT request_hash FROM inventory_adjustments WHERE shop_id=$1 AND idempotency_key=$2",
      [principal.shopId, decision.idempotencyKey],
    );
    if (priorDecision.rowCount) {
      if (priorDecision.rows[0].request_hash !== requestHash) throw new InventoryError("CONFLICT", "Idempotency key was already used for another inventory action.");
      const current = await client.query<StockRow>("SELECT product_id, mode, on_hand, reserved, version FROM inventory_stock WHERE shop_id=$1 AND product_id=$2", [principal.shopId, productId]);
      if (!current.rowCount) throw new InventoryError("NOT_FOUND", "Inventory record was not found.");
      return rowToLevel(current.rows[0]);
    }
    const product = await client.query(
      "SELECT id FROM products WHERE shop_id = $1 AND id = $2 AND kind = 'product' FOR UPDATE",
      [principal.shopId, productId],
    );
    if (!product.rowCount) throw new InventoryError("NOT_FOUND", "Product was not found in this shop.");
    const existing = await client.query<StockRow>(
      "SELECT product_id, mode, on_hand, reserved, version FROM inventory_stock WHERE shop_id = $1 AND product_id = $2 FOR UPDATE",
      [principal.shopId, productId],
    );
    if (existing.rowCount) throw new InventoryError("CONFLICT", "Inventory policy is already set; change tracked quantities with an adjustment.");
    const onHand = decision.mode === "tracked" ? decision.onHand : null;
    const inserted = await client.query<StockRow>(
      `INSERT INTO inventory_stock (shop_id, product_id, mode, on_hand, reserved, version, updated_at)
       VALUES ($1, $2, $3, $4, 0, 0, now())
       RETURNING product_id, mode, on_hand, reserved, version`,
      [principal.shopId, productId, decision.mode, onHand],
    );
    await client.query("INSERT INTO inventory_adjustments (shop_id, idempotency_key, request_hash, result_version) VALUES ($1,$2,$3,0)", [principal.shopId, decision.idempotencyKey, requestHash]);
    await client.query(
      `INSERT INTO inventory_audit (shop_id, product_id, actor_id, event_type, quantity_delta, reason, idempotency_key, version_after)
       VALUES ($1, $2, $3, 'mode_set', $4, $5, $6, $7)`,
      [principal.shopId, productId, principal.actorId, onHand, reason, decision.idempotencyKey, inserted.rows[0].version],
    );
    return rowToLevel(inserted.rows[0]);
  });
}

export async function adjustInventory(pool: Pool, principal: InventoryPrincipal, raw: unknown): Promise<StockLevel> {
  assertPrincipal(principal);
  const parsed = adjustInventoryInput.safeParse(raw);
  if (!parsed.success) throw new InventoryError("INVALID", "The inventory adjustment is invalid.");
  const input: AdjustInventoryInput = parsed.data;
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [principal.shopId, input.idempotencyKey]);
    const found = await client.query<StockRow>(
      `SELECT s.product_id, s.mode, s.on_hand, s.reserved, s.version
       FROM inventory_stock s JOIN products p ON p.id=s.product_id AND p.shop_id=s.shop_id
       WHERE s.shop_id=$1 AND s.product_id=$2 FOR UPDATE OF s`,
      [principal.shopId, input.productId],
    );
    if (!found.rowCount) throw new InventoryError("NOT_FOUND", "Tracked inventory was not found in this shop.");
    const row = found.rows[0];
    const existing = await client.query<{ request_hash: string; result_version: number }>(
      "SELECT request_hash, result_version FROM inventory_adjustments WHERE shop_id=$1 AND idempotency_key=$2",
      [principal.shopId, input.idempotencyKey],
    );
    const hash = createHash("sha256").update(JSON.stringify({ productId: input.productId, delta: input.delta, expectedVersion: input.expectedVersion, reason: input.reason })).digest("hex");
    if (existing.rowCount) {
      if (existing.rows[0].request_hash !== hash) throw new InventoryError("CONFLICT", "Idempotency key was already used for another adjustment.");
      const current = await client.query<StockRow>("SELECT product_id, mode, on_hand, reserved, version FROM inventory_stock WHERE shop_id=$1 AND product_id=$2", [principal.shopId, input.productId]);
      return rowToLevel(current.rows[0]);
    }
    if (row.mode !== "tracked" || row.on_hand === null) throw new InventoryError("CONFLICT", "Untracked inventory cannot be adjusted as a quantity.");
    if (Number(row.version) !== input.expectedVersion) throw new InventoryError("CONFLICT", "Inventory changed; read the latest version and retry.");
    const next = Number(row.on_hand) + input.delta;
    if (!Number.isSafeInteger(next) || next < Number(row.reserved)) throw new InventoryError("INSUFFICIENT", "Adjustment cannot reduce on-hand below reserved quantity.");
    if (next > MAX_STOCK) throw new InventoryError("INVALID", "On-hand quantity cannot exceed 1,000,000.");
    const updated = await client.query<StockRow>(
      `UPDATE inventory_stock SET on_hand=$3, version=version+1, updated_at=now()
       WHERE shop_id=$1 AND product_id=$2 RETURNING product_id, mode, on_hand, reserved, version`,
      [principal.shopId, input.productId, next],
    );
    await client.query("INSERT INTO inventory_adjustments (shop_id, idempotency_key, request_hash, result_version) VALUES ($1,$2,$3,$4)", [principal.shopId, input.idempotencyKey, hash, updated.rows[0].version]);
    await client.query(
      `INSERT INTO inventory_audit (shop_id, product_id, actor_id, event_type, quantity_delta, reason, idempotency_key, version_after)
       VALUES ($1,$2,$3,'adjusted',$4,$5,$6,$7)`,
      [principal.shopId, input.productId, principal.actorId, input.delta, input.reason, input.idempotencyKey, updated.rows[0].version],
    );
    return rowToLevel(updated.rows[0]);
  });
}

async function lockStock(client: Queryable, shopId: string, lines: readonly InventoryLine[]): Promise<Map<string, StockRow>> {
  const ids = lines.map((line) => line.productId).sort();
  const result = await client.query<StockRow>(
    `SELECT s.product_id, s.mode, s.on_hand, s.reserved, s.version
     FROM inventory_stock s JOIN products p ON p.id=s.product_id AND p.shop_id=s.shop_id
     WHERE s.shop_id=$1 AND p.kind='product' AND s.product_id = ANY($2::uuid[]) ORDER BY s.product_id FOR UPDATE OF s`,
    [shopId, ids],
  );
  if (result.rowCount !== ids.length) throw new InventoryError("CONFLICT", "Every product must have an explicit inventory decision before checkout.");
  return new Map(result.rows.map((row) => [row.product_id, row]));
}

export async function reserveInventory(
  pool: Pool,
  shopId: string,
  key: string,
  rawLines: unknown,
  expiresAt: Date,
): Promise<Reservation> {
  const lines = parseLines(rawLines);
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key) || Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) throw new InventoryError("INVALID", "Reservation key and expiry must be valid and in the future.");
  return transaction(pool, (client) => reserveInventoryInTransaction(client, shopId, key, lines, expiresAt));
}

export async function reserveInventoryInTransaction(
  client: Queryable,
  shopId: string,
  key: string,
  rawLines: unknown,
  expiresAt: Date,
): Promise<Reservation> {
  const lines = parseLines(rawLines);
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key) || Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) throw new InventoryError("INVALID", "Reservation key and expiry must be valid and in the future.");
    // Serialize retries on a not-yet-existing key before checking the unique ledger row.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [shopId, key]);
    const hash = checksum(lines);
    const existing = await client.query<{ id: string; request_hash: string; state: Reservation["state"]; expires_at: Date }>(
      "SELECT id, request_hash, state, expires_at FROM inventory_reservations WHERE shop_id=$1 AND idempotency_key=$2 FOR UPDATE",
      [shopId, key],
    );
    if (existing.rowCount) {
      if (existing.rows[0].request_hash !== hash) throw new InventoryError("CONFLICT", "Reservation key was already used for a different cart.");
      return loadReservation(client, shopId, existing.rows[0].id);
    }
    const rows = await lockStock(client, shopId, lines);
    for (const line of lines) {
      const stock = rows.get(line.productId)!;
      if (stock.mode === "tracked" && Number(stock.on_hand) - Number(stock.reserved) < line.quantity) {
        throw new InventoryError("INSUFFICIENT", "Not enough available stock for this cart.");
      }
    }
    const reservationId = randomUUID();
    await client.query(
      "INSERT INTO inventory_reservations (id, shop_id, idempotency_key, request_hash, state, expires_at) VALUES ($1,$2,$3,$4,'reserved',$5)",
      [reservationId, shopId, key, hash, expiresAt],
    );
    for (const line of lines) {
      const stock = rows.get(line.productId)!;
      await client.query("INSERT INTO inventory_reservation_lines (reservation_id, shop_id, product_id, quantity) VALUES ($1,$2,$3,$4)", [reservationId, shopId, line.productId, line.quantity]);
      if (stock.mode === "tracked") await client.query("UPDATE inventory_stock SET reserved=reserved+$3, version=version+1, updated_at=now() WHERE shop_id=$1 AND product_id=$2", [shopId, line.productId, line.quantity]);
    }
    return loadReservation(client, shopId, reservationId);
}

async function loadReservation(client: Queryable, shopId: string, id: string): Promise<Reservation> {
  const header = await client.query<{ id: string; idempotency_key: string; state: Reservation["state"]; expires_at: Date }>("SELECT id, idempotency_key, state, expires_at FROM inventory_reservations WHERE shop_id=$1 AND id=$2", [shopId, id]);
  if (!header.rowCount) throw new InventoryError("NOT_FOUND", "Reservation was not found.");
  const rows = await client.query<{ product_id: string; quantity: number }>("SELECT product_id, quantity FROM inventory_reservation_lines WHERE shop_id=$1 AND reservation_id=$2 ORDER BY product_id", [shopId, id]);
  const h = header.rows[0];
  return { id: h.id, shopId, idempotencyKey: h.idempotency_key, state: h.state, expiresAt: h.expires_at, lines: rows.rows.map((line) => ({ productId: line.product_id, quantity: Number(line.quantity) })) };
}

export type InventoryCapturePermit =
  | { allowed: true; reason: "started" }
  | { allowed: false; reason: "already_started" | "expired" | "terminal" };

/**
 * Atomically claims the single provider capture attempt for a live physical-order allocation.
 * Reconciliation must call this before sending a new capture request. A retry sees
 * `already_started` and must read PayPal instead of sending another capture.
 */
export async function beginInventoryCapture(
  pool: Pool,
  shopId: string,
  reservationId: string,
  now = new Date(),
): Promise<InventoryCapturePermit> {
  return transaction(pool, (client) => beginInventoryCaptureInTransaction(client, shopId, reservationId, now));
}

export async function beginInventoryCaptureInTransaction(
  client: Queryable,
  shopId: string,
  reservationId: string,
  now = new Date(),
): Promise<InventoryCapturePermit> {
    const result = await client.query<{ state: Reservation["state"]; expires_at: Date }>(
      "SELECT state, expires_at FROM inventory_reservations WHERE shop_id=$1 AND id=$2 FOR UPDATE",
      [shopId, reservationId],
    );
    if (!result.rowCount || result.rows[0].state !== "reserved") {
      return { allowed: false, reason: result.rowCount && result.rows[0].state === "capture_pending" ? "already_started" : "terminal" };
    }
    if (result.rows[0].expires_at <= now) return { allowed: false, reason: "expired" };
    await client.query(
      "UPDATE inventory_reservations SET state='capture_pending', updated_at=now() WHERE shop_id=$1 AND id=$2 AND state='reserved'",
      [shopId, reservationId],
    );
    return { allowed: true, reason: "started" };
}

// This records a capture the reconciliation layer has already verified. It never creates or
// captures a provider order. The provider timestamp, not webhook arrival time, defines lateness.
export async function commitReservation(pool: Pool, shopId: string, reservationId: string, proof: { captureId: string; providerStatus: "COMPLETED"; capturedAt: Date; verified: true }): Promise<Reservation> {
  if (!proof.captureId.trim() || proof.captureId.length > 256 || proof.providerStatus !== "COMPLETED" || proof.verified !== true || !(proof.capturedAt instanceof Date) || Number.isNaN(proof.capturedAt.getTime())) throw new InventoryError("INVALID", "A verified completed capture with its provider timestamp is required.");
  return transaction(pool, (client) => commitReservationInTransaction(client, shopId, reservationId, proof));
}

export async function commitReservationInTransaction(client: Queryable, shopId: string, reservationId: string, proof: { captureId: string; providerStatus: "COMPLETED"; capturedAt: Date; verified: true }): Promise<Reservation> {
  if (!proof.captureId.trim() || proof.captureId.length > 256 || proof.providerStatus !== "COMPLETED" || proof.verified !== true || !(proof.capturedAt instanceof Date) || Number.isNaN(proof.capturedAt.getTime())) throw new InventoryError("INVALID", "A verified completed capture with its provider timestamp is required.");
    const reservation = await client.query<{ state: Reservation["state"]; expires_at: Date; capture_id: string | null }>("SELECT state, expires_at, capture_id FROM inventory_reservations WHERE shop_id=$1 AND id=$2 FOR UPDATE", [shopId, reservationId]);
    if (!reservation.rowCount) throw new InventoryError("NOT_FOUND", "Reservation was not found.");
    const state = reservation.rows[0].state;
    if (state === "committed" || state === "review_required") {
      if (reservation.rows[0].capture_id !== proof.captureId) throw new InventoryError("REVIEW_REQUIRED", "This reservation already records a different capture.");
      return loadReservation(client, shopId, reservationId);
    }
    if (state !== "capture_pending" || proof.capturedAt >= reservation.rows[0].expires_at) {
      await client.query("UPDATE inventory_reservations SET state='review_required', capture_id=$3, updated_at=now() WHERE shop_id=$1 AND id=$2", [shopId, reservationId, proof.captureId]);
      return loadReservation(client, shopId, reservationId);
    }
    const linesResult = await client.query<{ product_id: string; quantity: number; mode: "tracked" | "untracked" }>(
      `SELECT l.product_id, l.quantity, s.mode FROM inventory_reservation_lines l
       JOIN inventory_stock s ON s.shop_id=l.shop_id AND s.product_id=l.product_id
       WHERE l.shop_id=$1 AND l.reservation_id=$2 ORDER BY l.product_id FOR UPDATE OF s`, [shopId, reservationId]);
    for (const line of linesResult.rows) if (line.mode === "tracked") await client.query("UPDATE inventory_stock SET reserved=reserved-$3, on_hand=on_hand-$3, version=version+1, updated_at=now() WHERE shop_id=$1 AND product_id=$2", [shopId, line.product_id, line.quantity]);
    await client.query("UPDATE inventory_reservations SET state='committed', capture_id=$3, updated_at=now() WHERE shop_id=$1 AND id=$2", [shopId, reservationId, proof.captureId]);
    return loadReservation(client, shopId, reservationId);
}

export async function releaseReservation(pool: Pool, shopId: string, reservationId: string, outcome: "verified_unpaid" | "verified_cancelled" | "verified_expired_unpaid"): Promise<Reservation> {
  if (!["verified_unpaid", "verified_cancelled", "verified_expired_unpaid"].includes(outcome)) throw new InventoryError("INVALID", "A verified unpaid outcome is required before releasing stock.");
  return transaction(pool, (client) => releaseReservationInTransaction(client, shopId, reservationId, outcome));
}

export async function releaseReservationInTransaction(client: Queryable, shopId: string, reservationId: string, outcome: "verified_unpaid" | "verified_cancelled" | "verified_expired_unpaid"): Promise<Reservation> {
  if (!["verified_unpaid", "verified_cancelled", "verified_expired_unpaid"].includes(outcome)) throw new InventoryError("INVALID", "A verified unpaid outcome is required before releasing stock.");
    const reservation = await client.query<{ state: Reservation["state"] }>("SELECT state FROM inventory_reservations WHERE shop_id=$1 AND id=$2 FOR UPDATE", [shopId, reservationId]);
    if (!reservation.rowCount) throw new InventoryError("NOT_FOUND", "Reservation was not found.");
    if (reservation.rows[0].state === "released") return loadReservation(client, shopId, reservationId);
    if (reservation.rows[0].state === "committed" || reservation.rows[0].state === "review_required") throw new InventoryError("REVIEW_REQUIRED", "A paid or ambiguous reservation cannot release stock.");
    const linesResult = await client.query<{ product_id: string; quantity: number; mode: "tracked" | "untracked" }>(
      `SELECT l.product_id, l.quantity, s.mode FROM inventory_reservation_lines l JOIN inventory_stock s ON s.shop_id=l.shop_id AND s.product_id=l.product_id
       WHERE l.shop_id=$1 AND l.reservation_id=$2 ORDER BY l.product_id FOR UPDATE OF s`, [shopId, reservationId]);
    for (const line of linesResult.rows) if (line.mode === "tracked") await client.query("UPDATE inventory_stock SET reserved=reserved-$3, version=version+1, updated_at=now() WHERE shop_id=$1 AND product_id=$2", [shopId, line.product_id, line.quantity]);
    await client.query("UPDATE inventory_reservations SET state='released', release_reason=$3, updated_at=now() WHERE shop_id=$1 AND id=$2", [shopId, reservationId, outcome]);
    return loadReservation(client, shopId, reservationId);
}
