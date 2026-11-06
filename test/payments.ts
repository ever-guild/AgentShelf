import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { eq } from "drizzle-orm";

import type { Db } from "../src/server/db/client";
import { createSellerInventoryAdapter } from "../src/server/inventory/seller-adapter";
import { orders } from "../src/server/db/schema";
import { createPayPalProvider } from "../src/server/paypal/orders";
import { createCheckout } from "../src/server/services/checkout";
import type { ReconcileDeps } from "../src/server/services/payment-reconciliation";
import { createProduct, createShop } from "./fixtures";
import { createFakePayPal, type FakePayPal } from "./paypal-fake";

export const MERCHANT_ID = "STOREDMERCHANT1";
export const WEBHOOK_ID = "WH-TEST-SHOP";
export const CLIENT_SECRET = "test-client-secret-value";

export type PaymentHarness = {
  paypal: FakePayPal;
  deps: ReconcileDeps;
  // Order IDs in the order the payment-confirmed hook saw them.
  confirmed: string[];
};

export function createPaymentHarness(): PaymentHarness {
  const paypal = createFakePayPal();
  const confirmed: string[] = [];
  return {
    paypal,
    confirmed,
    deps: {
      paypalFor: createPayPalProvider(
        {
          PAYPAL_CLIENT_ID_TEST_SHOP: "test-client-id",
          PAYPAL_CLIENT_SECRET_TEST_SHOP: CLIENT_SECRET,
          PAYPAL_WEBHOOK_ID_TEST_SHOP: WEBHOOK_ID,
        },
        paypal.adapter,
      ),
      onPaymentConfirmed: async (_tx, order) => {
        confirmed.push(order.id);
      },
      onPhysicalPaymentConfirmed: async (_client, orderId) => {
        confirmed.push(orderId);
      },
      closeIfHoldEnded: async () => false,
    },
  };
}

// An order as create_checkout leaves it: stored, with PayPal waiting for the buyer.
export async function placeOrder(
  db: Db,
  { deps }: PaymentHarness,
  shopOverrides: Parameters<typeof createShop>[1] = { paypalMerchantId: MERCHANT_ID },
) {
  const shop = await createShop(db, shopOverrides);
  const product = await createProduct(db, shop.id, { priceMinor: 990 });
  const pool = (db as Db & { $client: Pool }).$client;
  await createSellerInventoryAdapter(pool).setMode(
    { actorId: "00000000-0000-4000-8000-000000000099", shopId: shop.id },
    {
      productId: product.id,
      mode: "tracked",
      onHand: 100,
      idempotencyKey: `payment-seed-${product.id}`,
      reason: "Seeded physical stock for payment test",
    },
  );
  const checkout = await createCheckout(
    db,
    {
      items: [{ productId: product.id, quantity: 1 }],
      idempotencyKey: randomUUID(),
    },
    deps,
  );
  const stored = await readOrder(db, checkout.orderId);
  return {
    shop,
    product,
    orderId: checkout.orderId,
    statusToken: checkout.statusToken,
    paypalOrderId: stored.paypalOrderId as string,
  };
}

export async function readOrder(db: Db, orderId: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
  return row;
}
