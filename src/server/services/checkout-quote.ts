import "server-only";

import { eq, inArray } from "drizzle-orm";

import { createCheckoutInput } from "../contracts/commerce";
import type { Db } from "../db/client";
import { products, shops } from "../db/schema";
import {
  isSupportedCurrency,
  multiplyMinor,
  sumMinor,
} from "../domain/money";
import { ServiceError, parseInput } from "../errors";

export type CheckoutQuoteLine = {
  productId: string;
  title: string;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
};

// Internal to the server: holds the recipient and the credential reference, so it must never
// be returned to a client. The checkout service turns it into a persisted order.
export type CheckoutQuote = {
  shopId: string;
  currency: string;
  totalMinor: number;
  lines: CheckoutQuoteLine[];
  payeeMerchantId: string;
  paypalCredentialRef: string;
};

// Resolves a cart into authoritative amounts and the seller to be paid, using stored data
// only, and rejects everything that must not reach PayPal.
export async function quoteCheckout(
  db: Db,
  rawInput: unknown,
): Promise<CheckoutQuote> {
  const { items } = parseInput(createCheckoutInput, rawInput);

  const rows = await db
    .select({
      productId: products.id,
      shopId: products.shopId,
      kind: products.kind,
      status: products.status,
      title: products.title,
      priceMinor: products.priceMinor,
      availability: products.availability,
      currency: shops.currency,
      merchantId: shops.paypalMerchantId,
      credentialRef: shops.paypalCredentialRef,
    })
    .from(products)
    .innerJoin(shops, eq(products.shopId, shops.id))
    .where(
      inArray(
        products.id,
        items.map((item) => item.productId),
      ),
    );

  const rowsById = new Map(rows.map((row) => [row.productId, row]));
  const resolved = items.map((item) => {
    const row = rowsById.get(item.productId);
    if (!row || row.status !== "published" || row.priceMinor === null) {
      throw new ServiceError(
        "PRODUCT_NOT_FOUND",
        "A product in this order is not on sale.",
        { productId: item.productId },
      );
    }
    return { ...row, priceMinor: row.priceMinor, quantity: item.quantity };
  });

  if (new Set(resolved.map((row) => row.shopId)).size > 1) {
    throw new ServiceError(
      "MIXED_SHOPS",
      "An order can only contain products from one shop.",
    );
  }

  for (const row of resolved) {
    if (row.kind === "service") {
      throw new ServiceError(
        "PRODUCT_REQUIRES_BOOKING",
        "This service is bought by booking a slot, not through checkout.",
        { productId: row.productId },
      );
    }
    if (row.availability !== "available") {
      throw new ServiceError(
        "PRODUCT_UNAVAILABLE",
        "A product in this order is currently unavailable.",
        { productId: row.productId },
      );
    }
  }

  const [{ shopId, currency, merchantId, credentialRef }] = resolved;
  if (!isSupportedCurrency(currency)) {
    throw new ServiceError(
      "UNSUPPORTED_CURRENCY",
      `Currency ${currency} is not supported.`,
    );
  }
  if (!merchantId) {
    throw new ServiceError(
      "PAYMENT_NOT_CONFIGURED",
      "This shop cannot take payments yet.",
    );
  }

  const lines = resolved.map((row) => ({
    productId: row.productId,
    title: row.title,
    unitPriceMinor: row.priceMinor,
    quantity: row.quantity,
    lineTotalMinor: multiplyMinor(row.priceMinor, row.quantity),
  }));

  return {
    shopId,
    currency,
    totalMinor: sumMinor(lines.map((line) => line.lineTotalMinor)),
    lines,
    payeeMerchantId: merchantId,
    paypalCredentialRef: credentialRef,
  };
}
