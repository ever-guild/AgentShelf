import "server-only";

import { z } from "zod";

import { readBodyWithin, readJsonWithin } from "../http";
import { ServiceError } from "../errors";
import {
  MerchantConnectionError,
  type MerchantConnectionPrincipal,
  type MerchantConnectionService,
} from "./merchant-connection";
import type { MerchantConnectionRepository } from "./merchant-connection";

const startInput = z.strictObject({
  shopId: z.uuid(),
  idempotencyKey: z.string().trim().min(16).max(128),
  shareDataConsent: z.literal(true),
});
const shopIdInput = z.uuid();
const MAX_WEBHOOK_BYTES = 256 * 1024;

type AuthenticateOwnerShop = (request: Request, shopId: string) => Promise<MerchantConnectionPrincipal>;

function privateJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function connectionErrorResponse(error: unknown): Response {
  if (error instanceof MerchantConnectionError) {
    const status = error.code === "UNAUTHORIZED" ? 401
      : error.code === "CONSENT_REQUIRED" ? 422
      : error.code === "CONNECTION_CONFLICT" ? 409
        : error.code === "INVALID_CALLBACK" ? 400
          : error.code === "CONNECTION_OUTCOME_UNKNOWN" || error.code === "PROVIDER_STATUS_UNAVAILABLE" ? 503
            : 400;
    return privateJson({ error: { code: error.code, message: error.message } }, status);
  }
  if (error instanceof ServiceError) {
    return privateJson({ error: error.toJSON() }, error.httpStatus);
  }
  if (error instanceof Error && error.name === "IdentityError") {
    return privateJson({ error: { code: "UNAUTHORIZED", message: "This shop is not available to this account." } }, 401);
  }
  console.error("PayPal seller connection request failed", { error: error instanceof Error ? error.name : "unknown" });
  return privateJson({ error: { code: "INTERNAL_ERROR", message: "Something went wrong." } }, 500);
}

function originAllowed(request: Request, appOrigin: string) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

function queryValue(url: URL, key: string) {
  const values = url.searchParams.getAll(key);
  return values.length === 1 ? values[0] : undefined;
}

/** Framework-neutral HTTP handlers; route modules supply the shared owner+membership resolver. */
export function createMerchantConnectionHttpHandlers(input: {
  service: MerchantConnectionService;
  repository: MerchantConnectionRepository;
  authenticateOwnerShop: AuthenticateOwnerShop;
  appOrigin: string;
  platformConfigured: boolean;
  webhookConfigured: boolean;
}) {
  return {
    async start(request: Request) {
      if (!originAllowed(request, input.appOrigin)) {
        return privateJson({ error: { code: "UNAUTHORIZED", message: "This request is not authorized." } }, 403);
      }
      try {
        const body = await readJsonWithin(request, 8 * 1024);
        if (!body || typeof body !== "object" || (body as { shareDataConsent?: unknown }).shareDataConsent !== true) {
          return privateJson({ error: { code: "CONSENT_REQUIRED", message: "Confirm that this shop may share its account data with PayPal before continuing." } }, 422);
        }
        const parsed = startInput.safeParse(body);
        if (!parsed.success) return privateJson({ error: { code: "INVALID_INPUT", message: "The request is not valid." } }, 400);
        if (!input.platformConfigured) {
          return privateJson({ error: { code: "PROVIDER_STATUS_UNAVAILABLE", message: "PayPal seller connection is not configured yet." } }, 503);
        }
        const principal = await input.authenticateOwnerShop(request, parsed.data.shopId);
        const result = await input.service.start(principal, parsed.data);
        return privateJson(result, result.actionUrl ? 201 : 200);
      } catch (error) {
        return connectionErrorResponse(error);
      }
    },

    async status(request: Request) {
      try {
        const url = new URL(request.url);
        const shopId = shopIdInput.safeParse(queryValue(url, "shopId"));
        if (!shopId.success) return privateJson({ error: { code: "INVALID_INPUT", message: "The request is not valid." } }, 400);
        const principal = await input.authenticateOwnerShop(request, shopId.data);
        return privateJson({
          connection: await input.service.get(principal, shopId.data),
          configured: input.platformConfigured,
          webhookConfigured: input.webhookConfigured,
        });
      } catch (error) {
        return connectionErrorResponse(error);
      }
    },

    async refreshStatus(request: Request) {
      if (!originAllowed(request, input.appOrigin)) {
        return privateJson({ error: { code: "UNAUTHORIZED", message: "This request is not authorized." } }, 403);
      }
      try {
        const body = await readJsonWithin(request, 8 * 1024);
        const shopId = z.strictObject({ shopId: z.uuid() }).safeParse(body);
        if (!shopId.success) return privateJson({ error: { code: "INVALID_INPUT", message: "The request is not valid." } }, 400);
        const principal = await input.authenticateOwnerShop(request, shopId.data.shopId);
        return privateJson({
          connection: await input.service.refreshStatus(principal, shopId.data.shopId),
          configured: input.platformConfigured,
          webhookConfigured: input.webhookConfigured,
        });
      } catch (error) {
        return connectionErrorResponse(error);
      }
    },

    async callback(request: Request) {
      try {
        const url = new URL(request.url);
        const trackingId = queryValue(url, "merchantId");
        const sellerMerchantIdHint = queryValue(url, "merchantIdInPayPal");
        if (!trackingId || !sellerMerchantIdHint) return privateJson({ error: { code: "INVALID_CALLBACK", message: "The PayPal return could not be verified." } }, 400);
        const record = await input.repository.getByTrackingId(trackingId);
        if (!record) return privateJson({ error: { code: "INVALID_CALLBACK", message: "The PayPal return could not be verified." } }, 404);
        const principal = await input.authenticateOwnerShop(request, record.shopId);
        const connection = await input.service.complete(principal, { trackingId, sellerMerchantIdHint });
        const redirectUrl = new URL("/seller/paypal-connection", input.appOrigin);
        redirectUrl.searchParams.set("shopId", record.shopId);
        redirectUrl.searchParams.set("status", connection.status);
        return Response.redirect(redirectUrl, 303);
      } catch (error) {
        return connectionErrorResponse(error);
      }
    },

    async revocationWebhook(request: Request) {
      const body = await readBodyWithin(request, MAX_WEBHOOK_BYTES);
      if (body === undefined) return new Response(null, { status: 413 });
      try {
        const result = await input.service.handleRevocationWebhook({ headers: request.headers, rawBody: body.toString("utf8") });
        if (result.outcome === "unavailable") return new Response(null, { status: 503 });
        if (result.outcome === "invalid") return new Response(null, { status: 400 });
        return new Response(null, { status: 204 });
      } catch (error) {
        console.error("PayPal platform webhook processing failed", { error: error instanceof Error ? error.name : "unknown" });
        return new Response(null, { status: 503 });
      }
    },
  };
}
