import "server-only";

import type { Pool } from "pg";

import type { Db } from "../db/client";
import { PLATFORM_PAYPAL_CREDENTIAL_REF } from "./orders";

const REQUIRED_PRODUCT = "EXPRESS_CHECKOUT";
const REQUIRED_SCOPE = "https://uri.paypal.com/services/payments/payment/authcapture";

export type ConnectedPayPalMerchant = {
  credentialRef: typeof PLATFORM_PAYPAL_CREDENTIAL_REF;
  payeeMerchantId: string;
};

export type ShopPayPalRoute = {
  credentialRef: string;
  payeeMerchantId: string;
};

export function merchantEligibilityPool(db: Db): Pick<Pool, "query"> {
  return (db as Db & { $client: Pool }).$client;
}

/**
 * Resolve only a current, owner-consented PayPal connection with the exact verified
 * capabilities required for checkout. Legacy shop merchant fields are deliberately ignored.
 */
export async function resolveReadyConnectedMerchant(
  pool: Pick<Pool, "query">,
  shopId: string,
): Promise<ConnectedPayPalMerchant | undefined> {
  const result = await pool.query<{ seller_merchant_id: string }>(
    `SELECT connection.seller_merchant_id
     FROM paypal_merchant_connections AS connection
     WHERE connection.shop_id = $1
       AND connection.status = 'ready'
       AND connection.consented_by_owner_id IS NOT NULL
       AND connection.share_data_consent_at IS NOT NULL
       AND connection.seller_merchant_id ~ '^[A-Za-z0-9_-]{3,128}$'
       AND connection.status_evidence->>'merchantId' = connection.seller_merchant_id
       AND connection.status_evidence->>'trackingId' = connection.tracking_id
       AND connection.status_evidence->>'consentGranted' = 'true'
       AND connection.status_evidence->>'paymentsReceivable' = 'true'
       AND connection.status_evidence->>'primaryEmailConfirmed' = 'true'
       AND connection.status_evidence->'activeProducts' ? $2
       AND connection.status_evidence->'grantedScopes' ? $3
       AND NOT EXISTS (
         SELECT 1
         FROM paypal_merchant_connection_webhook_events AS event
         WHERE event.seller_merchant_id = connection.seller_merchant_id
           AND event.received_at >= connection.updated_at
       )
     ORDER BY connection.updated_at DESC, connection.created_at DESC
     LIMIT 1`,
    [shopId, REQUIRED_PRODUCT, REQUIRED_SCOPE],
  );
  const sellerMerchantId = result.rows[0]?.seller_merchant_id;
  return sellerMerchantId
    ? { credentialRef: PLATFORM_PAYPAL_CREDENTIAL_REF, payeeMerchantId: sellerMerchantId }
    : undefined;
}

/** Fresh authorization is required before capturing an old platform order. */
export async function isReadyConnectedMerchant(
  pool: Pick<Pool, "query">,
  shopId: string,
  sellerMerchantId: string,
): Promise<boolean> {
  const current = await resolveReadyConnectedMerchant(pool, shopId);
  return current?.payeeMerchantId === sellerMerchantId;
}

/** New owner-created shops use UNCONFIGURED until the verified connection is ready. */
export async function resolveShopPayPalRoute(
  pool: Pick<Pool, "query">,
  input: { shopId: string; credentialRef: string; legacyMerchantId: string | null },
): Promise<ShopPayPalRoute | undefined> {
  if (input.credentialRef === "UNCONFIGURED" || input.credentialRef === PLATFORM_PAYPAL_CREDENTIAL_REF) {
    return resolveReadyConnectedMerchant(pool, input.shopId);
  }
  if (!input.legacyMerchantId) return undefined;
  return {
    credentialRef: input.credentialRef,
    payeeMerchantId: input.legacyMerchantId,
  };
}
