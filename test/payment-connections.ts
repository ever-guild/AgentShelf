import { randomBytes, randomUUID } from "node:crypto";

import type { Db } from "../src/server/db/client";
import {
  paypalMerchantConnectionWebhookEvents,
  paypalMerchantConnections,
  sellerOwners,
  shopMemberships,
} from "../src/server/db/schema";

const SCOPE = "https://uri.paypal.com/services/payments/payment/authcapture";

export type TestConnection = {
  status?: string;
  /** Overrides for the evidence the readiness predicate checks. */
  evidence?: Record<string, unknown>;
};

/** Inserts one owner-consented PayPal connection that meets the checkout eligibility predicate. */
export async function createTestConnection(db: Db, shopId: string, options: TestConnection = {}) {
  const suffix = randomBytes(6).toString("hex");
  const ownerId = randomUUID();
  const sellerMerchantId = `SELLER${suffix.toUpperCase()}`;
  const trackingId = `test-tracking-${suffix}-${"x".repeat(30)}`;
  const now = new Date(Date.now() - 60_000);
  await db.insert(sellerOwners).values({
    id: ownerId,
    username: `owner-${suffix}`,
    passwordHash: `scrypt$16384$8$1$${"A".repeat(22)}$${"B".repeat(43)}`,
  });
  await db.insert(shopMemberships).values({ ownerId, shopId });
  await db.insert(paypalMerchantConnections).values({
    shopId,
    consentedByOwnerId: ownerId,
    shareDataConsentAt: now,
    status: options.status ?? "ready",
    trackingId,
    requestKeyHash: "2".repeat(64),
    sellerMerchantId,
    statusEvidence: {
      merchantId: sellerMerchantId,
      trackingId,
      paymentsReceivable: true,
      primaryEmailConfirmed: true,
      consentGranted: true,
      activeProducts: ["EXPRESS_CHECKOUT"],
      grantedScopes: [SCOPE],
      ...options.evidence,
    },
    createdAt: now,
    updatedAt: now,
  });
  return { sellerMerchantId, trackingId };
}

/** A webhook event received after the connection was last updated. */
export async function createLaterWebhookEvent(db: Db, sellerMerchantId: string) {
  await db.insert(paypalMerchantConnectionWebhookEvents).values({
    eventId: `WH-${randomBytes(6).toString("hex")}`,
    sellerMerchantId,
    receivedAt: new Date(),
  });
}
