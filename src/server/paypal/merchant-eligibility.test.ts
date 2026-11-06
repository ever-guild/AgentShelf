import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import {
  isReadyConnectedMerchant,
  resolveReadyConnectedMerchant,
  resolveShopPayPalRoute,
} from "./merchant-eligibility";
import { PLATFORM_PAYPAL_CREDENTIAL_REF } from "./orders";

const shopId = "d64b9b08-a6f8-4852-8719-d36c14d03420";
const sellerId = "SANDBOXMERCHANT1";

function poolWith(rows: Array<{ seller_merchant_id: string }>) {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const pool = {
    calls,
    query: vi.fn(async (query: string, values: unknown[]) => {
      calls.push({ query, values });
      return { rows };
    }),
  };
  return pool as unknown as Pick<Pool, "query"> & typeof pool;
}

describe("PayPal shop eligibility", () => {
  it("returns only the persisted ready seller mapping for a platform route", async () => {
    const pool = poolWith([{ seller_merchant_id: sellerId }]);

    await expect(resolveReadyConnectedMerchant(pool, shopId)).resolves.toEqual({
      credentialRef: PLATFORM_PAYPAL_CREDENTIAL_REF,
      payeeMerchantId: sellerId,
    });
    expect(pool.calls[0]).toEqual({
      query: expect.stringContaining("connection.status = 'ready'"),
      values: [
        shopId,
        "EXPRESS_CHECKOUT",
        "https://uri.paypal.com/services/payments/payment/authcapture",
      ],
    });
    const sql = pool.calls[0].query;
    expect(sql).toContain("connection.consented_by_owner_id IS NOT NULL");
    expect(sql).toContain("connection.share_data_consent_at IS NOT NULL");
    expect(sql).toContain("status_evidence->>'merchantId' = connection.seller_merchant_id");
    expect(sql).toContain("event.received_at >= connection.updated_at");
  });

  it("blocks an unconfigured shop until a current consented connection is ready", async () => {
    const pool = poolWith([]);
    await expect(resolveShopPayPalRoute(pool, {
      shopId,
      credentialRef: "UNCONFIGURED",
      legacyMerchantId: sellerId,
    })).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("keeps direct seller routes intact and ignores old merchant fields on platform shops", async () => {
    const pool = poolWith([{ seller_merchant_id: sellerId }]);
    await expect(resolveShopPayPalRoute(pool, {
      shopId,
      credentialRef: "SHOP_A",
      legacyMerchantId: "DIRECTMERCHANT1",
    })).resolves.toEqual({ credentialRef: "SHOP_A", payeeMerchantId: "DIRECTMERCHANT1" });
    expect(pool.query).not.toHaveBeenCalled();

    await expect(resolveShopPayPalRoute(pool, {
      shopId,
      credentialRef: PLATFORM_PAYPAL_CREDENTIAL_REF,
      legacyMerchantId: "LEGACYMERCHANT1",
    })).resolves.toEqual({ credentialRef: PLATFORM_PAYPAL_CREDENTIAL_REF, payeeMerchantId: sellerId });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("allows capture only when the original seller still matches the current ready mapping", async () => {
    await expect(isReadyConnectedMerchant(poolWith([{ seller_merchant_id: sellerId }]), shopId, sellerId)).resolves.toBe(true);
    await expect(isReadyConnectedMerchant(poolWith([{ seller_merchant_id: "OTHERSELLER1" }]), shopId, sellerId)).resolves.toBe(false);
    await expect(isReadyConnectedMerchant(poolWith([]), shopId, sellerId)).resolves.toBe(false);
  });
});
