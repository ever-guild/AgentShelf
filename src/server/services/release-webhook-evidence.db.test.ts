import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import {
  MERCHANT_ID,
  createPaymentHarness,
  placeOrder,
  readOrder,
  type PaymentHarness,
} from "../../../test/payments";
import { createBooking, createOrder, createService, createShop, createTechnician } from "../../../test/fixtures";
import { orders, webhookReceipts } from "../db/schema";
import { beginPhysicalOrderCapture } from "../inventory/physical-orders";
import { PLATFORM_PAYPAL_CREDENTIAL_REF, createPayPalProvider } from "../paypal/orders";
import { createCheckout } from "./checkout";
import { reconcileForBuyer } from "./payment-reconciliation";
import { handlePlatformPayPalWebhook } from "./paypal-webhook";

// Pins which stored rows prove that a PAYMENT.CAPTURE.COMPLETED delivery for a captured order was
// received (signature verified) and processed. A receipt row is written only after the signature
// verifies, so there is no separate "verified" column: the row's existence is the verification
// and its status says how far processing got. The receipts aggregate below is the statement of
// the release evidence audit, with the shop, the UTC window and the expected count as parameters.

const getDb = setupMigratedDatabase();

const SLUG = "liepaja-phone-workshop";
const WINDOW_START = "2026-11-09T20:15:00Z";
const WINDOW_END = "2026-11-09T21:00:00Z";
const INSIDE = new Date("2026-11-09T20:30:00Z");
const OUTSIDE = new Date("2026-11-09T19:00:00Z");
const PLATFORM_WEBHOOK_ID = "WH-PLATFORM-PAYMENTS";
const PLATFORM_ENV = {
  PAYPAL_PLATFORM_CLIENT_ID: "sandbox-platform-client-id",
  PAYPAL_PLATFORM_CLIENT_SECRET: "sandbox-platform-client-secret",
  PAYPAL_PARTNER_ATTRIBUTION_ID: "AGENT_SHELF_BN_CODE",
};

const RECEIPTS_AGGREGATE = `
WITH target_shop AS (
  SELECT id FROM shops WHERE slug = $1::text
), target_capture_orders AS (
  SELECT o.id, o.paypal_capture_id, o.payment_status,
    (SELECT max(CASE r.status
        WHEN 'processed' THEN 4 WHEN 'failed' THEN 3 WHEN 'received' THEN 2 WHEN 'ignored' THEN 1
      END)
     FROM webhook_receipts AS r
     WHERE r.order_id = o.id
       AND r.resource_id = o.paypal_capture_id
       AND r.event_type = 'PAYMENT.CAPTURE.COMPLETED') AS best_rank,
    EXISTS (SELECT 1 FROM webhook_receipts AS r
     WHERE r.order_id = o.id
       AND r.resource_id = o.paypal_capture_id
       AND r.event_type = 'PAYMENT.CAPTURE.COMPLETED'
       AND r.status = 'processed' AND r.processed_at IS NOT NULL) AS processed_stamped
  FROM orders AS o
  JOIN target_shop AS s ON s.id = o.shop_id
  WHERE o.created_at >= $2::timestamptz
    AND o.created_at < $3::timestamptz
    AND o.paypal_capture_id IS NOT NULL
)
SELECT
  $4::integer AS expected_capture_orders,
  count(*)::integer AS found_capture_orders,
  count(*) FILTER (WHERE payment_status = 'paid')::integer AS paid_capture_orders,
  count(*) FILTER (WHERE best_rank = 4)::integer AS captures_with_processed_verified_receipt,
  count(*) FILTER (WHERE best_rank IS NOT NULL)::integer AS captures_with_any_matching_receipt,
  count(*) FILTER (WHERE best_rank IS NOT NULL AND best_rank < 4)::integer
    AS captures_with_only_nonprocessed_receipts,
  count(*) FILTER (WHERE best_rank = 4)::integer AS best_processed,
  count(*) FILTER (WHERE best_rank = 3)::integer AS best_failed,
  count(*) FILTER (WHERE best_rank = 2)::integer AS best_received,
  count(*) FILTER (WHERE best_rank = 1)::integer AS best_ignored,
  count(*) FILTER (WHERE best_rank IS NULL)::integer AS best_none,
  count(*) FILTER (WHERE processed_stamped)::integer AS processed_with_timestamp
FROM target_capture_orders AS o`;

// The 10 November cohort statement of root-readonly-check.mjs and receipts/cohorts.sql: public
// 8-hex ID prefixes bounded by the shop and a UTC window; a booking resolves to its deposit order.
const COHORT = `
WITH target_shop AS (SELECT id FROM shops WHERE slug = $1::text),
cohort AS (
  SELECT * FROM unnest($4::text[], $5::text[], $6::text[]) AS c(label, kind, prefix)
),
cand AS (
  SELECT c.label, o.id AS order_id, o.paypal_capture_id, o.payment_status::text AS payment_status,
    NULL::text AS booking_status
  FROM cohort AS c
  JOIN orders AS o ON c.kind = 'order' AND o.id::text LIKE c.prefix || '%'
  JOIN target_shop AS s ON s.id = o.shop_id
  WHERE o.created_at >= $2::timestamptz AND o.created_at < $3::timestamptz
  UNION ALL
  SELECT c.label, o.id, o.paypal_capture_id, o.payment_status::text, b.status::text
  FROM cohort AS c
  JOIN bookings AS b ON c.kind = 'booking' AND b.id::text LIKE c.prefix || '%'
  JOIN orders AS o ON o.id = b.order_id AND o.shop_id = b.shop_id
  JOIN target_shop AS s ON s.id = o.shop_id
  WHERE o.created_at >= $2::timestamptz AND o.created_at < $3::timestamptz
),
counted AS (
  SELECT c.label, count(a.order_id)::integer AS matches
  FROM cohort AS c LEFT JOIN cand AS a ON a.label = c.label
  GROUP BY c.label
),
single AS (
  SELECT a.* FROM cand AS a JOIN counted AS n ON n.label = a.label AND n.matches = 1
)
SELECT n.label, n.matches, (n.matches <> 1) AS ambiguous_or_missing,
  x.payment_status, x.booking_status,
  CASE WHEN x.order_id IS NULL THEN NULL ELSE x.paypal_capture_id IS NOT NULL END AS has_capture,
  CASE WHEN x.order_id IS NULL THEN NULL ELSE
    CASE (SELECT max(CASE r.status WHEN 'processed' THEN 4 WHEN 'failed' THEN 3 WHEN 'received' THEN 2 WHEN 'ignored' THEN 1 END)
            FROM webhook_receipts AS r
           WHERE r.order_id = x.order_id AND r.resource_id = x.paypal_capture_id
             AND r.event_type = 'PAYMENT.CAPTURE.COMPLETED')
      WHEN 4 THEN 'processed' WHEN 3 THEN 'failed' WHEN 2 THEN 'received' WHEN 1 THEN 'ignored' ELSE 'none'
    END END AS capture_receipt_best_status,
  CASE WHEN x.order_id IS NULL THEN NULL ELSE EXISTS (
    SELECT 1 FROM webhook_receipts AS r
     WHERE r.order_id = x.order_id AND r.resource_id = x.paypal_capture_id
       AND r.event_type = 'PAYMENT.CAPTURE.COMPLETED'
       AND r.status = 'processed' AND r.processed_at IS NOT NULL) END AS processed_with_timestamp,
  CASE WHEN x.order_id IS NULL THEN NULL ELSE (
    SELECT count(*)::integer FROM webhook_receipts AS r
     WHERE r.order_id = x.order_id AND r.event_type = 'PAYMENT.CAPTURE.COMPLETED'
       AND r.resource_id IS DISTINCT FROM x.paypal_capture_id) END AS foreign_or_other_resource,
  CASE WHEN x.order_id IS NULL THEN NULL ELSE COALESCE((
    SELECT jsonb_agg(jsonb_build_object('event_type', t.event_type, 'status', t.status, 'receipts', t.n)
                     ORDER BY t.event_type, t.status)
      FROM (SELECT r.event_type, r.status::text AS status, count(*)::integer AS n
              FROM webhook_receipts AS r
             WHERE r.order_id = x.order_id AND r.event_type <> 'PAYMENT.CAPTURE.COMPLETED'
             GROUP BY r.event_type, r.status) AS t), '[]'::jsonb) END AS other_event_receipts
FROM counted AS n
LEFT JOIN single AS x ON x.label = n.label
ORDER BY n.label`;

type Json = Record<string, unknown>;
type Aggregate = Record<string, number>;

let harness: PaymentHarness;
let platformDeps: PaymentHarness["deps"];
let eventNumber = 0;

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  vi.stubEnv("PAYPAL_PLATFORM_PAYMENT_WEBHOOK_ID", PLATFORM_WEBHOOK_ID);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  harness = createPaymentHarness();
  platformDeps = {
    ...harness.deps,
    paypalFor: createPayPalProvider(PLATFORM_ENV, harness.paypal.adapter),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const pool = () => (getDb() as ReturnType<typeof getDb> & { $client: Pool }).$client;
const rawOf = (event: Json) => JSON.stringify(event, null, 3);

type Placed = {
  orderId: string;
  statusToken: string;
  paypalOrderId: string;
};

async function platformOrder(base: { shopId: string; productId: string }): Promise<Placed> {
  const checkout = await createCheckout(
    getDb(),
    { items: [{ productId: base.productId, quantity: 1 }], idempotencyKey: randomUUID() },
    harness.deps,
  );
  const stored = await readOrder(getDb(), checkout.orderId);
  await getDb()
    .update(orders)
    .set({ paypalCredentialRef: PLATFORM_PAYPAL_CREDENTIAL_REF, createdAt: INSIDE })
    .where(eq(orders.id, checkout.orderId));
  return {
    orderId: checkout.orderId,
    statusToken: checkout.statusToken,
    paypalOrderId: stored.paypalOrderId as string,
  };
}

// PayPal captured while the buyer was away: nothing is stored until a webhook reconciles it.
async function captureAtPayPal(order: Placed) {
  expect(await beginPhysicalOrderCapture(pool(), order.orderId)).toMatchObject({ allowed: true });
  harness.paypal.approve(order.paypalOrderId);
  const api = platformDeps.paypalFor(PLATFORM_PAYPAL_CREDENTIAL_REF, MERCHANT_ID);
  await api!.captureOrder({
    id: order.paypalOrderId,
    paypalRequestId: `capture-${order.orderId}`,
    body: {},
  });
}

// The buyer's return: the captured order is read back and marked paid with its capture id.
async function payByReturn(order: Placed) {
  await captureAtPayPal(order);
  await reconcileForBuyer(
    getDb(),
    { orderId: order.orderId, statusToken: order.statusToken },
    platformDeps,
  );
  const stored = await readOrder(getDb(), order.orderId);
  expect(stored).toMatchObject({ paymentStatus: "paid" });
  expect(stored.paypalCaptureId).toBeTruthy();
}

function captureEvent(order: Placed, resourceId?: string, eventType = "PAYMENT.CAPTURE.COMPLETED"): Json {
  eventNumber += 1;
  return {
    id: `WH-EVIDENCE-${eventNumber}`,
    event_type: eventType,
    resource_type: "capture",
    create_time: "2026-11-09T20:31:00Z",
    resource: {
      id: resourceId ?? harness.paypal.captureIdOf(order.paypalOrderId),
      status: "COMPLETED",
      amount: { currency_code: "EUR", value: "9.90" },
      supplementary_data: { related_ids: { order_id: order.paypalOrderId } },
    },
  };
}

function deliver(event: Json, headers?: Headers, rawBody = rawOf(event)) {
  return handlePlatformPayPalWebhook(
    getDb(),
    { rawBody, headers: headers ?? harness.paypal.signDelivery(PLATFORM_WEBHOOK_ID, rawBody) },
    platformDeps,
  );
}

async function receiptsOf(orderId: string) {
  const rows = await getDb()
    .select({
      providerEventId: webhookReceipts.providerEventId,
      status: webhookReceipts.status,
      resourceId: webhookReceipts.resourceId,
      processedAt: webhookReceipts.processedAt,
    })
    .from(webhookReceipts)
    .where(eq(webhookReceipts.orderId, orderId));
  return rows;
}

async function aggregate(expected = 7): Promise<Aggregate> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    const result = await client.query(RECEIPTS_AGGREGATE, [SLUG, WINDOW_START, WINDOW_END, expected]);
    expect(result.rows).toHaveLength(1);
    return result.rows[0] as Aggregate;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function seedShop() {
  const first = await placeOrder(getDb(), harness, { paypalMerchantId: MERCHANT_ID, slug: SLUG });
  await getDb()
    .update(orders)
    .set({ paypalCredentialRef: PLATFORM_PAYPAL_CREDENTIAL_REF, createdAt: INSIDE })
    .where(eq(orders.id, first.orderId));
  const base = { shopId: first.shop.id, productId: first.product.id };
  return { base, first: { ...first } as Placed & typeof first };
}

describe("receipts evidence for captured orders", () => {
  it("counts only a verified, fully processed delivery for this order and capture", async () => {
    const { base, first } = await seedShop();

    // 1. captured, never delivered
    const noReceipt = first as Placed;
    await payByReturn(noReceipt);

    // 2. delivery whose signature fails
    const badSignature = await platformOrder(base);
    await payByReturn(badSignature);
    const forged = captureEvent(badSignature);
    const forgedHeaders = harness.paypal.signDelivery(PLATFORM_WEBHOOK_ID, rawOf(forged));
    forgedHeaders.set("paypal-transmission-sig", "invalid-signature");
    expect(await deliver(forged, forgedHeaders)).toBe(400);
    expect(await receiptsOf(badSignature.orderId)).toEqual([]);

    // 3. verified, reconciliation fails
    const failed = await platformOrder(base);
    await payByReturn(failed);
    harness.paypal.nextRead({ type: "timeout" });
    expect(await deliver(captureEvent(failed))).toBe(503);
    expect(await receiptsOf(failed.orderId)).toEqual([
      expect.objectContaining({ status: "failed", processedAt: null }),
    ]);

    // 4. verified and left at received, as a crash between the insert and the settle would
    const received = await platformOrder(base);
    await payByReturn(received);
    await getDb().insert(webhookReceipts).values({
      providerEventId: `WH-CRASHED-${randomUUID()}`,
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      resourceId: (await readOrder(getDb(), received.orderId)).paypalCaptureId,
      shopId: base.shopId,
      orderId: received.orderId,
      status: "received",
      payload: {},
    });

    // 5. captured while the buyer was away, settled by the webhook itself
    const viaWebhook = await platformOrder(base);
    await captureAtPayPal(viaWebhook);
    expect((await readOrder(getDb(), viaWebhook.orderId)).paypalCaptureId).toBeNull();
    expect(await deliver(captureEvent(viaWebhook))).toBe(200);
    expect(await readOrder(getDb(), viaWebhook.orderId)).toMatchObject({ paymentStatus: "paid" });

    // 6. already paid by the buyer's return, then two distinct verified events for one capture
    const paidThenWebhook = await platformOrder(base);
    await payByReturn(paidThenWebhook);
    expect(await deliver(captureEvent(paidThenWebhook))).toBe(200);
    expect(await deliver(captureEvent(paidThenWebhook))).toBe(200);
    expect(await receiptsOf(paidThenWebhook.orderId)).toEqual([
      expect.objectContaining({ status: "processed" }),
      expect.objectContaining({ status: "processed" }),
    ]);

    // 7. the same event delivered twice
    const duplicate = await platformOrder(base);
    await payByReturn(duplicate);
    const repeated = captureEvent(duplicate);
    expect(await deliver(repeated)).toBe(200);
    expect(await deliver(repeated)).toBe(200);
    expect(await receiptsOf(duplicate.orderId)).toHaveLength(1);

    // 8. verified event naming another capture id for this order
    const otherCapture = await platformOrder(base);
    await payByReturn(otherCapture);
    expect(await deliver(captureEvent(otherCapture, "SOMEOTHERCAPTURE1"))).toBe(200);

    // 9. verified event of another type naming this order
    const otherType = await platformOrder(base);
    await payByReturn(otherType);
    const approved = captureEvent(otherType, otherType.paypalOrderId, "CHECKOUT.ORDER.APPROVED");
    expect(await deliver(approved)).toBe(200);

    // 10. failed once, then the same event is redelivered and succeeds
    const retried = await platformOrder(base);
    await payByReturn(retried);
    const retriedEvent = captureEvent(retried);
    harness.paypal.nextRead({ type: "timeout" });
    expect(await deliver(retriedEvent)).toBe(503);
    expect(await receiptsOf(retried.orderId)).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(await deliver(retriedEvent)).toBe(200);
    expect(await receiptsOf(retried.orderId)).toEqual([
      expect.objectContaining({ status: "processed" }),
    ]);

    // Outside the evidence set: before the window, another shop, and an uncaptured order
    const early = await platformOrder(base);
    await payByReturn(early);
    expect(await deliver(captureEvent(early))).toBe(200);
    await getDb().update(orders).set({ createdAt: OUTSIDE }).where(eq(orders.id, early.orderId));
    const elsewhere = await placeOrder(getDb(), harness, { paypalMerchantId: "ELSEWHERESELLER1" });
    await getDb()
      .update(orders)
      .set({ paypalCredentialRef: PLATFORM_PAYPAL_CREDENTIAL_REF, createdAt: INSIDE })
      .where(eq(orders.id, elsewhere.orderId));
    await payByReturn(elsewhere);
    expect(await deliver(captureEvent(elsewhere))).toBe(200);
    await platformOrder(base);

    // The verified-and-processed signal, per case, read back from the stored rows
    expect(await receiptsOf(viaWebhook.orderId)).toEqual([
      expect.objectContaining({
        status: "processed",
        resourceId: (await readOrder(getDb(), viaWebhook.orderId)).paypalCaptureId,
        processedAt: expect.any(Date),
      }),
    ]);

    const result = await aggregate(7);
    expect(result).toEqual({
      expected_capture_orders: 7,
      // cases 1 to 10; the early, other-shop and uncaptured orders are outside the filters
      found_capture_orders: 10,
      paid_capture_orders: 10,
      // cases 5, 6, 7 and 10
      captures_with_processed_verified_receipt: 4,
      // plus failed (3) and received (4)
      captures_with_any_matching_receipt: 6,
      captures_with_only_nonprocessed_receipts: 2,
      best_processed: 4,
      best_failed: 1,
      best_received: 1,
      best_ignored: 0,
      // cases 1, 2, 8 and 9
      best_none: 4,
      processed_with_timestamp: 4,
    });
    // The window alone does not fix the set: a caller must check found against the expected count
    expect(result.found_capture_orders).not.toBe(result.expected_capture_orders);
  });

  it("is a read-only statement that reports zeros for an empty shop", async () => {
    const empty = await aggregate(7);
    expect(empty).toMatchObject({
      found_capture_orders: 0,
      captures_with_processed_verified_receipt: 0,
      captures_with_any_matching_receipt: 0,
      best_none: 0,
    });
    const client = await pool().connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await expect(client.query("DELETE FROM webhook_receipts")).rejects.toThrow(/read-only/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("receipts evidence for the prefix cohort", () => {
  const COHORT_WINDOW = ["2026-11-10T11:00:00Z", "2026-11-10T14:30:00Z"];
  const IN_COHORT = new Date("2026-11-10T12:00:00Z");
  const LABELS = ["cap", "booking", "dup", "late", "none"];
  const KINDS = ["order", "booking", "order", "order", "order"];
  const PREFIXES = ["daa49d33", "04a53b17", "38408297", "3f5873d1", "99999999"];

  async function cohortRows() {
    const client = await pool().connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await client.query(COHORT, [SLUG, ...COHORT_WINDOW, LABELS, KINDS, PREFIXES]);
      return Object.fromEntries(result.rows.map((row) => [row.label as string, row]));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  const receipt = (orderId: string, shopId: string, over: Partial<typeof webhookReceipts.$inferInsert>) =>
    getDb()
      .insert(webhookReceipts)
      .values({
        providerEventId: `WH-COHORT-${randomUUID()}`,
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        shopId,
        orderId,
        payload: {},
        ...over,
      });

  it("resolves a prefix to exactly one order in the shop and window, and a booking through its deposit order", async () => {
    const db = getDb();
    const shop = await createShop(db, { slug: SLUG });
    const other = await createShop(db);
    const service = await createService(db, shop.id);
    const technician = await createTechnician(db, shop.id);
    const at = { shopId: shop.id, createdAt: IN_COHORT };

    // A paid capture order: a processed capture receipt, an approval receipt that is only
    // received, and a capture event for some other resource that must not count for the verdict.
    const cap = await createOrder(db, shop.id, {
      ...at,
      id: "daa49d33-0000-4000-8000-000000000001",
      paymentStatus: "paid",
      paypalCaptureId: "CAP-A",
    });
    await receipt(cap.id, shop.id, { resourceId: "CAP-A", status: "processed", processedAt: IN_COHORT });
    await receipt(cap.id, shop.id, {
      eventType: "CHECKOUT.ORDER.APPROVED",
      resourceId: "ORDER-A",
      status: "received",
    });
    await receipt(cap.id, shop.id, { resourceId: "CAP-OTHER", status: "processed", processedAt: IN_COHORT });

    // The booking's own id has the public prefix; its deposit order has an unrelated id
    const deposit = await createOrder(db, shop.id, {
      ...at,
      id: "11111111-0000-4000-8000-000000000002",
      kind: "booking_deposit",
    });
    await createBooking(db, shop.id, service.id, technician.id, {
      id: "04a53b17-0000-4000-8000-000000000003",
      orderId: deposit.id,
    });

    // The same prefix twice, an order outside the window and an order of another shop
    for (const [n, over] of [
      ["4", at],
      ["5", at],
    ] as const) {
      await createOrder(db, shop.id, { ...over, id: `38408297-0000-4000-8000-00000000000${n}` });
    }
    await createOrder(db, shop.id, {
      shopId: shop.id,
      createdAt: new Date("2026-11-10T15:00:00Z"),
      id: "3f5873d1-0000-4000-8000-000000000006",
    });
    await createOrder(db, other.id, { createdAt: IN_COHORT, id: "99999999-0000-4000-8000-000000000007" });

    const rows = await cohortRows();
    expect(rows.cap).toMatchObject({
      matches: 1,
      ambiguous_or_missing: false,
      payment_status: "paid",
      has_capture: true,
      capture_receipt_best_status: "processed",
      processed_with_timestamp: true,
      foreign_or_other_resource: 1,
      other_event_receipts: [{ event_type: "CHECKOUT.ORDER.APPROVED", status: "received", receipts: 1 }],
    });
    expect(rows.booking).toMatchObject({
      matches: 1,
      booking_status: "held",
      has_capture: false,
      capture_receipt_best_status: "none",
      processed_with_timestamp: false,
    });
    // Ambiguous, out of the window and in another shop: no per-row data, only the count
    for (const label of ["dup", "late", "none"]) {
      expect(rows[label]).toMatchObject({
        ambiguous_or_missing: true,
        payment_status: null,
        has_capture: null,
        capture_receipt_best_status: null,
        processed_with_timestamp: null,
        other_event_receipts: null,
      });
    }
    expect(rows.dup.matches).toBe(2);
    expect(rows.late.matches).toBe(0);
    expect(rows.none.matches).toBe(0);
  });
});
