import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import type { SellerPayPalShopPrincipal, SellerShopPrincipal } from "../contracts/seller-identity";

export const MERCHANT_CONNECTION_STATES = [
  "not_connected",
  "pending",
  "ready",
  "revoked",
  "error",
] as const;
export type MerchantConnectionState = (typeof MERCHANT_CONNECTION_STATES)[number];

/** Owner session or a grant-scoped principal carrying persisted PayPal consent evidence. */
export type MerchantConnectionPrincipal = SellerShopPrincipal &
  Partial<Pick<SellerPayPalShopPrincipal, "shareDataConsent" | "shareDataConsentAt">>;
export type MerchantConnectionAction = "connect" | "read";

export type MerchantStatusEvidence = {
  merchantId: string;
  trackingId: string;
  paymentsReceivable: boolean;
  primaryEmailConfirmed: boolean;
  consentGranted: boolean;
  activeProducts: readonly string[];
  grantedScopes: readonly string[];
};

export type MerchantConnectionRecord = {
  shopId: string;
  consentedByOwnerId: string;
  shareDataConsentAt: Date;
  status: Exclude<MerchantConnectionState, "not_connected">;
  trackingId: string;
  requestKeyHash: string;
  referralUrl?: string;
  sellerMerchantId?: string;
  evidence?: MerchantStatusEvidence;
  errorCode?: "referral_rejected" | "provider_outcome_unknown" | "status_unavailable";
  lastWebhookEventId?: string;
  createdAt: Date;
  updatedAt: Date;
};

export interface MerchantConnectionRepository {
  // Must be a single atomic operation. It returns replay for the same shop/key, active for a
  // different request while an existing referral is pending/ready or has a recoverable status
  // error, and creates only after a definite referral rejection or revocation.
  reserveStart(input: {
    shopId: string;
    consentedByOwnerId: string;
    shareDataConsentAt: Date;
    requestKeyHash: string;
    trackingId: string;
    now: Date;
  }): Promise<{ kind: "created" | "replay" | "active" | "conflict"; record: MerchantConnectionRecord }>;
  getByShop(shopId: string): Promise<MerchantConnectionRecord | undefined>;
  getByTrackingId(trackingId: string): Promise<MerchantConnectionRecord | undefined>;
  saveReferral(input: { shopId: string; trackingId: string; referralUrl: string; now: Date }): Promise<MerchantConnectionRecord>;
  markStartFailure(input: {
    shopId: string;
    trackingId: string;
    status: "error" | "pending";
    errorCode: "referral_rejected" | "provider_outcome_unknown" | "status_unavailable";
    now: Date;
  }): Promise<void>;
  saveStatus(input: {
    shopId: string;
    trackingId: string;
    sellerMerchantId: string;
    status: "ready" | "pending";
    evidence: MerchantStatusEvidence;
    observedAt?: Date;
    now: Date;
  }): Promise<MerchantConnectionRecord>;
  markRevoked(input: {
    sellerMerchantId: string;
    eventId: string;
    now: Date;
  }): Promise<"revoked" | "duplicate" | "unmatched">;
}

export interface PartnerReferralsAdapter {
  createReferral(input: { trackingId: string; returnUrl: string }): Promise<{ referralUrl: string; actionUrl: string }>;
  refreshReferral(referralUrl: string): Promise<{ actionUrl: string }>;
  getMerchantStatus(sellerMerchantId: string): Promise<MerchantStatusEvidence>;
  verifyRevocationWebhook(input: { headers: Headers; rawBody: string }): Promise<
    | { eventId: string; eventType: "MERCHANT.PARTNER-CONSENT.REVOKED"; sellerMerchantId: string }
    | undefined
  >;
}

const startSchema = z.strictObject({
  shopId: z.uuid(),
  idempotencyKey: z.string().trim().min(16).max(128),
  shareDataConsent: z.literal(true).optional(),
});
const shopIdSchema = z.uuid();
const callbackSchema = z.strictObject({
  trackingId: z.string().regex(/^[A-Za-z0-9_-]{40,64}$/),
  sellerMerchantIdHint: z.string().regex(/^[A-Za-z0-9_-]{3,128}$/),
});
const webhookHeadersSchema = z.instanceof(Headers);

export class MerchantConnectionError extends Error {
  constructor(
    readonly code:
      | "UNAUTHORIZED"
      | "CONSENT_REQUIRED"
      | "CONNECTION_CONFLICT"
      | "CONNECTION_OUTCOME_UNKNOWN"
      | "INVALID_CALLBACK"
      | "PROVIDER_STATUS_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "MerchantConnectionError";
  }
}

export type MerchantConnectionView = {
  shopId: string;
  status: MerchantConnectionState;
  nextAction?: "continue_paypal" | "retry_status" | "retry_connection" | "contact_support";
  paymentsReceivable?: boolean;
  primaryEmailConfirmed?: boolean;
  readyScopes?: readonly string[];
  updatedAt?: Date;
};

export type MerchantConnectionService = ReturnType<typeof createMerchantConnectionService>;

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function publicView(record: MerchantConnectionRecord | undefined, shopId: string): MerchantConnectionView {
  if (!record) return { shopId, status: "not_connected" };
  return {
    shopId: record.shopId,
    status: record.status,
    ...(record.status === "pending" && record.referralUrl ? { nextAction: "continue_paypal" as const } : {}),
    ...(record.status === "pending" && record.errorCode === "provider_outcome_unknown" ? { nextAction: "contact_support" as const } : {}),
    ...(record.status === "error" && record.errorCode === "status_unavailable" ? { nextAction: "retry_status" as const } : {}),
    ...(record.status === "error" && record.errorCode === "referral_rejected" ? { nextAction: "retry_connection" as const } : {}),
    ...(record.evidence ? {
      paymentsReceivable: record.evidence.paymentsReceivable,
      primaryEmailConfirmed: record.evidence.primaryEmailConfirmed,
      readyScopes: record.evidence.grantedScopes,
    } : {}),
    updatedAt: record.updatedAt,
  };
}

/**
 * Seller connection domain logic. The caller must pass the authenticated owner or an explicitly
 * authorized seller-agent principal. The injected policy is checked here on every shop operation.
 */
export function createMerchantConnectionService(input: {
  repository: MerchantConnectionRepository;
  paypal: PartnerReferralsAdapter;
  authorizeShop: (principal: MerchantConnectionPrincipal, shopId: string, action: MerchantConnectionAction) => Promise<boolean>;
  returnUrl: string;
  now?: () => Date;
  createTrackingId?: () => string;
}) {
  const now = input.now ?? (() => new Date());
  const createTrackingId = input.createTrackingId ?? (() => randomBytes(32).toString("base64url"));
  const requiredProducts = ["EXPRESS_CHECKOUT"];
  const requiredScopes = ["https://uri.paypal.com/services/payments/payment/authcapture"];
  const returnUrl = new URL(input.returnUrl);
  if (returnUrl.protocol !== "https:" || returnUrl.username || returnUrl.password || returnUrl.search || returnUrl.hash) {
    throw new Error("PayPal onboarding return URL must be an HTTPS URL without credentials, query, or fragment");
  }

  async function authorize(principal: MerchantConnectionPrincipal, shopId: string, action: MerchantConnectionAction) {
    if (!shopIdSchema.safeParse(shopId).success || !principal?.actorId || principal.shopId !== shopId || !(await input.authorizeShop(principal, shopId, action))) {
      throw new MerchantConnectionError("UNAUTHORIZED", "You are not authorized to manage PayPal for this shop.");
    }
  }

  return {
    async start(principal: MerchantConnectionPrincipal, rawInput: unknown) {
      const parsed = startSchema.safeParse(rawInput);
      if (!parsed.success) {
        if (!rawInput || typeof rawInput !== "object" || (rawInput as { shareDataConsent?: unknown }).shareDataConsent !== true) {
          throw new MerchantConnectionError("CONSENT_REQUIRED", "Confirm that this shop may share its account data with PayPal before continuing.");
        }
        throw new MerchantConnectionError("CONNECTION_CONFLICT", "The PayPal connection request is invalid.");
      }
      const { shopId, idempotencyKey } = parsed.data;
      await authorize(principal, shopId, "connect");
      if (!z.uuid().safeParse(principal.actorId).success) throw new MerchantConnectionError("UNAUTHORIZED", "You are not authorized to manage PayPal for this shop.");
      if (
        principal.shareDataConsentAt !== undefined &&
        (principal.shareDataConsent !== true ||
          !(principal.shareDataConsentAt instanceof Date) ||
          Number.isNaN(principal.shareDataConsentAt.getTime()))
      ) {
        throw new MerchantConnectionError("UNAUTHORIZED", "The seller-agent consent evidence is invalid.");
      }
      const delegatedConsentAt = principal.shareDataConsent === true
        ? principal.shareDataConsentAt
        : undefined;
      if (!delegatedConsentAt && parsed.data.shareDataConsent !== true) {
        throw new MerchantConnectionError("CONSENT_REQUIRED", "Confirm that this shop may share its account data with PayPal before continuing.");
      }
      const actionAt = now();
      const consentAt = delegatedConsentAt ?? actionAt;
      const trackingId = createTrackingId();
      if (!/^[A-Za-z0-9_-]{40,64}$/.test(trackingId)) throw new Error("Tracking ID generator returned an invalid value");
      const requestKeyHash = hash(idempotencyKey);
      const reservation = await input.repository.reserveStart({
        shopId,
        consentedByOwnerId: principal.actorId,
        shareDataConsentAt: consentAt,
        requestKeyHash,
        trackingId,
        now: actionAt,
      });
      if (reservation.kind === "conflict") {
        throw new MerchantConnectionError("CONNECTION_CONFLICT", "A PayPal connection flow is already active for this shop.");
      }
      const record = reservation.record;
      if (
        record.shopId !== shopId ||
        (reservation.kind !== "active" && (record.requestKeyHash !== requestKeyHash || record.consentedByOwnerId !== principal.actorId)) ||
        (reservation.kind === "created" && (record.trackingId !== trackingId || record.status !== "pending"))
      ) {
        throw new MerchantConnectionError("CONNECTION_CONFLICT", "The PayPal connection reservation could not be matched to this shop.");
      }
      if (reservation.kind !== "created") {
        if (record.consentedByOwnerId !== principal.actorId) {
          return { connection: publicView(record, shopId) };
        }
        if (record.status === "ready" || record.status === "revoked" || record.status === "error") {
          return { connection: publicView(record, shopId) };
        }
        if (!record.referralUrl) {
          throw new MerchantConnectionError("CONNECTION_OUTCOME_UNKNOWN", "PayPal may have received the request; automatic retry is disabled until it is reconciled.");
        }
        try {
          const refreshed = await input.paypal.refreshReferral(record.referralUrl);
          return { connection: publicView(record, shopId), actionUrl: refreshed.actionUrl };
        } catch {
          throw new MerchantConnectionError("PROVIDER_STATUS_UNAVAILABLE", "The PayPal signup link could not be refreshed. Try again later.");
        }
      }

      let referral: { referralUrl: string; actionUrl: string };
      try {
        referral = await input.paypal.createReferral({ trackingId, returnUrl: returnUrl.toString() });
      } catch (error) {
        const outcomeUnknown = error instanceof PartnerReferralsRequestError && error.outcome === "unknown";
        const status = outcomeUnknown ? "pending" : "error";
        const errorCode = outcomeUnknown ? "provider_outcome_unknown" : "referral_rejected";
        await input.repository.markStartFailure({ shopId, trackingId, status, errorCode, now: now() });
        if (outcomeUnknown) {
          throw new MerchantConnectionError("CONNECTION_OUTCOME_UNKNOWN", "PayPal may have received the request; automatic retry is disabled until it is reconciled.");
        }
        throw new MerchantConnectionError("PROVIDER_STATUS_UNAVAILABLE", "PayPal could not start seller onboarding.");
      }
      try {
        const saved = await input.repository.saveReferral({ shopId, trackingId, referralUrl: referral.referralUrl, now: now() });
        if (
          saved.shopId !== shopId ||
          saved.trackingId !== trackingId ||
          saved.requestKeyHash !== requestKeyHash ||
          saved.referralUrl !== referral.referralUrl
        ) {
          throw new Error("Referral persistence binding mismatch");
        }
        return {
          connection: publicView(saved, shopId),
          ...(saved.status === "pending" ? { actionUrl: referral.actionUrl } : {}),
        };
      } catch {
        await input.repository.markStartFailure({
          shopId,
          trackingId,
          status: "pending",
          errorCode: "provider_outcome_unknown",
          now: now(),
        });
        throw new MerchantConnectionError("CONNECTION_OUTCOME_UNKNOWN", "PayPal created the referral but it could not be saved; automatic retry is disabled.");
      }
    },

    async complete(principal: MerchantConnectionPrincipal, rawInput: unknown) {
      const parsed = callbackSchema.safeParse(rawInput);
      if (!parsed.success) throw new MerchantConnectionError("INVALID_CALLBACK", "The PayPal return could not be matched to an active shop connection.");
      const { trackingId, sellerMerchantIdHint } = parsed.data;
      const record = await input.repository.getByTrackingId(trackingId);
      if (!record || record.trackingId !== trackingId) throw new MerchantConnectionError("INVALID_CALLBACK", "The PayPal return could not be matched to an active shop connection.");
      await authorize(principal, record.shopId, "connect");
      if (record.status === "revoked") return publicView(record, record.shopId);
      if (record.sellerMerchantId && record.sellerMerchantId !== sellerMerchantIdHint) {
        throw new MerchantConnectionError("INVALID_CALLBACK", "The PayPal merchant does not match this shop connection.");
      }
      if (record.status === "ready" && record.sellerMerchantId === sellerMerchantIdHint) {
        return publicView(record, record.shopId);
      }
      let evidence: MerchantStatusEvidence;
      const observedAt = now();
      try {
        evidence = await input.paypal.getMerchantStatus(sellerMerchantIdHint);
      } catch {
        await input.repository.markStartFailure({
          shopId: record.shopId,
          trackingId,
          status: "error",
          errorCode: "status_unavailable",
          now: now(),
        });
        throw new MerchantConnectionError("PROVIDER_STATUS_UNAVAILABLE", "PayPal seller status could not be verified. Retry the status check later.");
      }
      if (evidence.merchantId !== sellerMerchantIdHint || evidence.trackingId !== trackingId) {
        throw new MerchantConnectionError("INVALID_CALLBACK", "PayPal's verified merchant status does not match this shop connection.");
      }
      const ready = evidence.consentGranted && evidence.paymentsReceivable && evidence.primaryEmailConfirmed &&
        requiredProducts.every((product) => evidence.activeProducts.includes(product)) &&
        requiredScopes.every((scope) => evidence.grantedScopes.includes(scope));
      const saved = await input.repository.saveStatus({
        shopId: record.shopId,
        trackingId,
        sellerMerchantId: evidence.merchantId,
        status: ready ? "ready" : "pending",
        evidence,
        observedAt,
        now: now(),
      });
      if (
        saved.shopId !== record.shopId ||
        saved.trackingId !== trackingId ||
        saved.sellerMerchantId !== evidence.merchantId ||
        saved.status === "ready" && !ready
      ) {
        throw new MerchantConnectionError("CONNECTION_CONFLICT", "The verified PayPal status could not be bound to this shop.");
      }
      return publicView(saved, record.shopId);
    },

    async get(principal: MerchantConnectionPrincipal, shopId: string) {
      await authorize(principal, shopId, "read");
      const record = await input.repository.getByShop(shopId);
      if (record && record.shopId !== shopId) throw new MerchantConnectionError("CONNECTION_CONFLICT", "The stored PayPal connection does not match this shop.");
      return publicView(record, shopId);
    },

    async refreshStatus(principal: MerchantConnectionPrincipal, shopId: string) {
      await authorize(principal, shopId, "connect");
      const record = await input.repository.getByShop(shopId);
      if (!record || !record.sellerMerchantId || record.status === "revoked") {
        return publicView(record, shopId);
      }
      return this.complete(principal, {
        trackingId: record.trackingId,
        sellerMerchantIdHint: record.sellerMerchantId,
      });
    },

    async handleRevocationWebhook(rawInput: { headers: Headers; rawBody: string }) {
      const headerResult = webhookHeadersSchema.safeParse(rawInput?.headers);
      if (!headerResult.success || typeof rawInput?.rawBody !== "string" || Buffer.byteLength(rawInput.rawBody, "utf8") > 256 * 1024) {
        return { applied: false as const, outcome: "invalid" as const };
      }
      let verified: Awaited<ReturnType<PartnerReferralsAdapter["verifyRevocationWebhook"]>>;
      try {
        verified = await input.paypal.verifyRevocationWebhook(rawInput);
      } catch {
        return { applied: false as const, outcome: "unavailable" as const };
      }
      if (!verified || verified.eventType !== "MERCHANT.PARTNER-CONSENT.REVOKED" || !verified.eventId || !verified.sellerMerchantId) {
        return { applied: false as const, outcome: "invalid" as const };
      }
      const result = await input.repository.markRevoked({
        sellerMerchantId: verified.sellerMerchantId,
        eventId: verified.eventId,
        now: now(),
      });
      return { applied: result === "revoked", duplicate: result === "duplicate", outcome: result };
    },
  };
}

export class PartnerReferralsRequestError extends Error {
  constructor(readonly outcome: "rejected" | "unknown") {
    super("Partner Referrals request failed");
    this.name = "PartnerReferralsRequestError";
  }
}
