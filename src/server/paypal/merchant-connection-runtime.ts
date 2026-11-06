import "server-only";

import type { Pool } from "pg";

import type { IdentityStore } from "../seller-identity/service";
import { createMerchantConnectionService } from "./merchant-connection";
import { createPartnerReferralsAdapter } from "./partner-referrals";
import { PostgresMerchantConnectionRepository } from "./postgres-merchant-connection";

type MerchantConnectionIdentityStore = Pick<IdentityStore, "findOwnedShop">;
type Environment = Record<string, string | undefined>;
const PLATFORM_KEYS = [
  "PAYPAL_PLATFORM_CLIENT_ID",
  "PAYPAL_PLATFORM_CLIENT_SECRET",
  "PAYPAL_PLATFORM_MERCHANT_ID",
  "PAYPAL_PARTNER_ATTRIBUTION_ID",
] as const;

/** Creates the persistent Partner Referrals service for the app's existing database pool. */
export function createMerchantConnectionRuntime(input: {
  pool: Pool;
  identityStore: MerchantConnectionIdentityStore;
  env?: Environment;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}) {
  const env = input.env ?? process.env;
  const appOrigin = env.APP_ORIGIN?.trim();
  if (!appOrigin) throw new Error("APP_ORIGIN is not configured");
  const returnUrl = new URL("/api/seller/paypal/connection/callback", appOrigin).toString();
  const repository = new PostgresMerchantConnectionRepository(input.pool);
  const paypal = createPartnerReferralsAdapter(env, input.fetchImpl ?? fetch);
  const platformConfigured = PLATFORM_KEYS.every((key) => Boolean(env[key]?.trim()));
  const webhookConfigured = Boolean(env.PAYPAL_PLATFORM_WEBHOOK_ID?.trim());
  const service = createMerchantConnectionService({
    repository,
    paypal,
    authorizeShop: async (principal, shopId) =>
      principal.shopId === shopId && Boolean(await input.identityStore.findOwnedShop(principal.actorId, shopId)),
    returnUrl,
    now: input.now,
  });
  return { service, repository, paypal, platformConfigured, webhookConfigured };
}
