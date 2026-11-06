import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTemporaryDatabase } from "../../../test/database";
import type { MerchantStatusEvidence } from "./merchant-connection";
import { PostgresMerchantConnectionRepository } from "./postgres-merchant-connection";

const now = new Date("2026-11-06T12:00:00.000Z");
const seller = "sandboxSellerMerchant123";
const tracking = "a".repeat(43);
const evidence: MerchantStatusEvidence = {
  merchantId: seller,
  trackingId: tracking,
  paymentsReceivable: true,
  primaryEmailConfirmed: true,
  consentGranted: true,
  activeProducts: ["EXPRESS_CHECKOUT"],
  grantedScopes: ["https://uri.paypal.com/services/payments/payment/authcapture"],
};

describe("Postgres merchant connection repository", () => {
  let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;
  let pool: Pool;
  let repository: PostgresMerchantConnectionRepository;
  let shopId: string;

  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new Pool({ connectionString: temporary.url, max: 8 });
    await pool.query(`CREATE TABLE shops (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`);
    const draft = await readFile(new URL("../../../drizzle/drafts/paypal-merchant-connection.sql", import.meta.url), "utf8");
    await pool.query(draft);
    repository = new PostgresMerchantConnectionRepository(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE paypal_merchant_connection_webhook_events, paypal_merchant_connections, shops CASCADE");
    shopId = randomUUID();
    await pool.query("INSERT INTO shops (id) VALUES ($1)", [shopId]);
  });

  afterAll(async () => {
    await pool?.end();
    await temporary?.drop();
  });

  it("serializes idempotent starts and blocks a second referral while the first is pending", async () => {
    const input = { shopId, requestKeyHash: "1".repeat(64), trackingId: tracking, now };
    const [first, duplicate] = await Promise.all([repository.reserveStart(input), repository.reserveStart(input)]);
    expect([first.kind, duplicate.kind].sort()).toEqual(["created", "replay"]);
    const other = await repository.reserveStart({ ...input, requestKeyHash: "2".repeat(64), trackingId: "b".repeat(43) });
    expect(other).toMatchObject({ kind: "active", record: { shopId, trackingId: tracking, status: "pending" } });
  });

  it("replays a stored request key, preserves failed attempts, and only retries a definite rejection", async () => {
    const firstInput = { shopId, requestKeyHash: "1".repeat(64), trackingId: tracking, now };
    await repository.reserveStart(firstInput);
    await repository.markStartFailure({
      shopId, trackingId: tracking, status: "pending", errorCode: "provider_outcome_unknown", now,
    });
    const unknownReplay = await repository.reserveStart({ ...firstInput, trackingId: "b".repeat(43) });
    expect(unknownReplay).toMatchObject({ kind: "replay", record: { status: "pending", errorCode: "provider_outcome_unknown" } });
    const blocked = await repository.reserveStart({ ...firstInput, requestKeyHash: "2".repeat(64), trackingId: "b".repeat(43) });
    expect(blocked.kind).toBe("active");

    await repository.markStartFailure({
      shopId, trackingId: tracking, status: "error", errorCode: "referral_rejected", now,
    });
    const retry = await repository.reserveStart({ ...firstInput, requestKeyHash: "2".repeat(64), trackingId: "b".repeat(43) });
    expect(retry).toMatchObject({ kind: "created", record: { trackingId: "b".repeat(43), status: "pending" } });
  });

  it("binds verified status to the tracking row and applies only deduplicated revocation events", async () => {
    await repository.reserveStart({ shopId, requestKeyHash: "1".repeat(64), trackingId: tracking, now });
    const status = await repository.saveStatus({
      shopId, trackingId: tracking, sellerMerchantId: seller, status: "ready", evidence, now,
    });
    expect(status).toMatchObject({ status: "ready", sellerMerchantId: seller, evidence: { trackingId: tracking } });
    await expect(repository.markRevoked({ sellerMerchantId: "unknownMerchant123", eventId: "event-unknown", now })).resolves.toBe("unmatched");
    await expect(repository.markRevoked({ sellerMerchantId: seller, eventId: "event-1", now })).resolves.toBe("revoked");
    await expect(repository.markRevoked({ sellerMerchantId: seller, eventId: "event-1", now })).resolves.toBe("duplicate");
    const lateStatus = await repository.saveStatus({
      shopId, trackingId: tracking, sellerMerchantId: seller, status: "ready", evidence, now,
    });
    expect(lateStatus.status).toBe("revoked");
    expect(await repository.getByShop(shopId)).toMatchObject({ status: "revoked", sellerMerchantId: seller });
  });

  it("revokes the active reconnected row and ignores a late status update for the historical row", async () => {
    const oldTracking = "c".repeat(43);
    await repository.reserveStart({ shopId, requestKeyHash: "3".repeat(64), trackingId: oldTracking, now });
    await repository.saveStatus({
      shopId, trackingId: oldTracking, sellerMerchantId: seller, status: "ready", evidence: { ...evidence, trackingId: oldTracking }, now,
    });
    await repository.markRevoked({ sellerMerchantId: seller, eventId: "event-old", now });

    const newTracking = "d".repeat(43);
    await repository.reserveStart({ shopId, requestKeyHash: "4".repeat(64), trackingId: newTracking, now: new Date(now.getTime() + 1_000) });
    await repository.saveStatus({
      shopId, trackingId: newTracking, sellerMerchantId: seller, status: "ready", evidence: { ...evidence, trackingId: newTracking }, now: new Date(now.getTime() + 2_000),
    });
    const lateHistoricalStatus = await repository.saveStatus({
      shopId, trackingId: oldTracking, sellerMerchantId: seller, status: "ready", evidence: { ...evidence, trackingId: oldTracking }, now: new Date(now.getTime() + 3_000),
    });
    expect(lateHistoricalStatus.status).toBe("revoked");

    await expect(repository.markRevoked({ sellerMerchantId: seller, eventId: "event-new", now: new Date(now.getTime() + 4_000) })).resolves.toBe("revoked");
    expect(await repository.getByTrackingId(oldTracking)).toMatchObject({ status: "revoked" });
    expect(await repository.getByShop(shopId)).toMatchObject({ trackingId: newTracking, status: "revoked" });
  });
});
