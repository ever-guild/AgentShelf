import "server-only";

import { inArray } from "drizzle-orm";

import type { Db } from "../db/client";
import { paypalMerchantConnections } from "../db/schema";
import { merchantEligibilityPool, resolveShopPayPalRoute } from "../paypal/merchant-eligibility";
import { PLATFORM_PAYPAL_CREDENTIAL_REF, type PayPalProvider } from "../paypal/orders";

export type PaymentReadiness =
  | { paymentReady: true; paymentUnavailableReason: null }
  | { paymentReady: false; paymentUnavailableReason: "not_connected" | "not_ready" };

export type ShopPaymentInput = {
  shopId: string;
  credentialRef: string;
  legacyMerchantId: string | null;
};

const READY: PaymentReadiness = { paymentReady: true, paymentUnavailableReason: null };

// Read-only snapshot of whether checkout could start for each shop: the same route and sender
// lookup create_checkout and book_slot perform, with no PayPal call and no write. Those tools
// check again, so a stale answer here never authorizes anything.
export async function resolvePaymentReadiness(
  db: Db,
  shopInputs: ShopPaymentInput[],
  paypalFor: PayPalProvider,
): Promise<Map<string, PaymentReadiness>> {
  const unique = [...new Map(shopInputs.map((shop) => [shop.shopId, shop])).values()];
  const result = new Map<string, PaymentReadiness>();
  const pool = merchantEligibilityPool(db);
  const unready: ShopPaymentInput[] = [];

  await Promise.all(
    unique.map(async (shop) => {
      const route = await resolveShopPayPalRoute(pool, {
        shopId: shop.shopId,
        credentialRef: shop.credentialRef,
        legacyMerchantId: shop.legacyMerchantId,
      });
      if (route && paypalFor(route.credentialRef, route.payeeMerchantId)) {
        result.set(shop.shopId, READY);
      } else if (route) {
        result.set(shop.shopId, { paymentReady: false, paymentUnavailableReason: "not_ready" });
      } else {
        unready.push(shop);
      }
    }),
  );

  const connectable = unready.filter(
    (shop) =>
      shop.credentialRef === "UNCONFIGURED" || shop.credentialRef === PLATFORM_PAYPAL_CREDENTIAL_REF,
  );
  const withConnection = new Set<string>();
  if (connectable.length > 0) {
    const rows = await db
      .selectDistinct({ shopId: paypalMerchantConnections.shopId })
      .from(paypalMerchantConnections)
      .where(inArray(paypalMerchantConnections.shopId, connectable.map((shop) => shop.shopId)));
    for (const row of rows) withConnection.add(row.shopId);
  }
  for (const shop of unready) {
    result.set(shop.shopId, {
      paymentReady: false,
      paymentUnavailableReason: withConnection.has(shop.shopId) ? "not_ready" : "not_connected",
    });
  }
  return result;
}
