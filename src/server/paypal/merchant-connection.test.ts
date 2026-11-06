import { describe, expect, it, vi } from "vitest";

import {
  createMerchantConnectionService,
  MerchantConnectionError,
  type MerchantConnectionRecord,
  type MerchantConnectionRepository,
  type MerchantStatusEvidence,
  PartnerReferralsRequestError,
} from "./merchant-connection";

const shopA = "5d1a0085-d25e-4d4d-872a-fb5ff80ad9a2";
const shopB = "e4ca75b9-079d-4a52-aadb-a88442d7dca9";
const trackingA = "a".repeat(43);
const sellerA = "sellerMerchantA123";
const principal = { actorId: "0a6513a0-60cb-43d0-9d72-c4b98d37a2c0", shopId: shopA };
const goodEvidence: MerchantStatusEvidence = {
  merchantId: sellerA,
  trackingId: trackingA,
  paymentsReceivable: true,
  primaryEmailConfirmed: true,
  consentGranted: true,
  activeProducts: ["EXPRESS_CHECKOUT"],
  grantedScopes: ["https://uri.paypal.com/services/payments/payment/authcapture"],
};

function createHarness(options: { authorized?: boolean; status?: MerchantStatusEvidence } = {}) {
  const rows = new Map<string, MerchantConnectionRecord>();
  const byTracking = new Map<string, string>();
  const repository: MerchantConnectionRepository = {
    async reserveStart(input) {
      const current = rows.get(input.shopId);
      if (current && current.requestKeyHash === input.requestKeyHash) return { kind: "replay", record: current };
      if (current && !["error", "revoked"].includes(current.status)) return { kind: "active", record: current };
      const record: MerchantConnectionRecord = {
        shopId: input.shopId,
        consentedByOwnerId: input.consentedByOwnerId,
        shareDataConsentAt: input.shareDataConsentAt,
        status: "pending",
        trackingId: input.trackingId,
        requestKeyHash: input.requestKeyHash,
        createdAt: input.now,
        updatedAt: input.now,
      };
      rows.set(input.shopId, record);
      byTracking.set(input.trackingId, input.shopId);
      return { kind: "created", record };
    },
    async getByShop(shopId) { return rows.get(shopId); },
    async getByTrackingId(trackingId) {
      const shopId = byTracking.get(trackingId);
      return shopId ? rows.get(shopId) : undefined;
    },
    async saveReferral(input) {
      const row = rows.get(input.shopId)!;
      const updated = { ...row, referralUrl: input.referralUrl, updatedAt: input.now };
      rows.set(input.shopId, updated);
      return updated;
    },
    async markStartFailure(input) {
      const row = rows.get(input.shopId)!;
      rows.set(input.shopId, { ...row, status: input.status, errorCode: input.errorCode, updatedAt: input.now });
    },
    async saveStatus(input) {
      const row = rows.get(input.shopId)!;
      if (row.status === "revoked") return row;
      const updated = {
        ...row,
        status: input.status,
        sellerMerchantId: input.sellerMerchantId,
        evidence: input.evidence,
        updatedAt: input.now,
      };
      rows.set(input.shopId, updated);
      return updated;
    },
    async markRevoked(input) {
      const row = [...rows.values()].find((record) => record.sellerMerchantId === input.sellerMerchantId);
      if (!row) return "unmatched";
      if (row.lastWebhookEventId === input.eventId) return "duplicate";
      rows.set(row.shopId, { ...row, status: "revoked", lastWebhookEventId: input.eventId, updatedAt: input.now });
      return "revoked";
    },
  };
  const paypal = {
    createReferral: vi.fn(async () => ({
      referralUrl: "https://api-m.sandbox.paypal.com/v2/customer/partner-referrals/ref-123",
      actionUrl: "https://www.sandbox.paypal.com/us/merchantsignup/partner/onboardingentry?token=hidden",
    })),
    refreshReferral: vi.fn(async () => ({
      actionUrl: "https://www.sandbox.paypal.com/us/merchantsignup/partner/onboardingentry?token=refreshed",
    })),
    getMerchantStatus: vi.fn(async () => options.status ?? goodEvidence),
    verifyRevocationWebhook: vi.fn(async ({ rawBody }: { rawBody: string }) => {
      if (rawBody !== "verified-event") return undefined;
      return { eventId: "event-1", eventType: "MERCHANT.PARTNER-CONSENT.REVOKED" as const, sellerMerchantId: sellerA };
    }),
  };
  let seq = 0;
  const service = createMerchantConnectionService({
    repository,
    paypal,
    authorizeShop: async (actor, shopId) => options.authorized !== false && actor.actorId === principal.actorId && actor.shopId === shopA && shopId === shopA,
    returnUrl: "https://agentshelf.example/seller/paypal/callback",
    now: () => new Date("2026-11-06T12:00:00Z"),
    createTrackingId: () => (++seq === 1 ? trackingA : "b".repeat(43)),
  });
  return { service, repository, paypal, rows, byTracking };
}

describe("merchant connection service", () => {
  it("requires explicit PayPal data-sharing consent before creating a referral", async () => {
    const { service, paypal, repository } = createHarness();
    await expect(service.start(principal, { shopId: shopA, idempotencyKey: "client-request-key-0001" }))
      .rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    expect(paypal.createReferral).not.toHaveBeenCalled();
    expect(await repository.getByShop(shopA)).toBeUndefined();
  });

  it("requires an authorized shop principal before starting a referral", async () => {
    const { service, paypal } = createHarness({ authorized: false });
    await expect(service.start(principal, { shopId: shopA, idempotencyKey: "client-request-key-0001", shareDataConsent: true }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(paypal.createReferral).not.toHaveBeenCalled();
  });

  it("binds the generated tracking ID to the authorized shop and replays without another POST", async () => {
    const { service, paypal } = createHarness();
    const first = await service.start(principal, { shopId: shopA, idempotencyKey: "client-request-key-0001", shareDataConsent: true });
    expect(first.connection).toMatchObject({ shopId: shopA, status: "pending", nextAction: "continue_paypal" });
    expect(first.actionUrl).toContain("www.sandbox.paypal.com");
    expect(paypal.createReferral).toHaveBeenCalledTimes(1);
    const replay = await service.start(principal, { shopId: shopA, idempotencyKey: "client-request-key-0001", shareDataConsent: true });
    expect(replay.actionUrl).toContain("token=refreshed");
    expect(paypal.createReferral).toHaveBeenCalledTimes(1);
    expect(paypal.refreshReferral).toHaveBeenCalledTimes(1);
  });

  it("does not retry a Partner Referrals POST after an ambiguous outcome", async () => {
    const { service, paypal, repository } = createHarness();
    paypal.createReferral.mockRejectedValueOnce(new PartnerReferralsRequestError("unknown"));
    await expect(service.start(principal, { shopId: shopA, idempotencyKey: "client-request-key-0001", shareDataConsent: true }))
      .rejects.toMatchObject({ code: "CONNECTION_OUTCOME_UNKNOWN" });
    await expect(service.start(principal, { shopId: shopA, idempotencyKey: "client-request-key-0001", shareDataConsent: true }))
      .rejects.toMatchObject({ code: "CONNECTION_OUTCOME_UNKNOWN" });
    expect(paypal.createReferral).toHaveBeenCalledTimes(1);
    expect(await repository.getByShop(shopA)).toMatchObject({ status: "pending", errorCode: "provider_outcome_unknown" });
  });

  it("does not accept an unverified seller hint or allow another owner to complete this shop", async () => {
    const { service, paypal, repository } = createHarness();
    await service.start(principal, { shopId: shopA, idempotencyKey: "client-request-key-0001", shareDataConsent: true });
    const unowned = { actorId: "6af0c424-3c06-4fc6-9cce-7ea4e082c301", shopId: shopA };
    await expect(service.complete(unowned, { trackingId: trackingA, sellerMerchantIdHint: sellerA }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(paypal.getMerchantStatus).not.toHaveBeenCalled();

    await expect(service.complete(principal, { trackingId: trackingA, sellerMerchantIdHint: "otherSeller123" }))
      .rejects.toMatchObject({ code: "INVALID_CALLBACK" });
    expect(await repository.getByShop(shopA)).toMatchObject({ status: "pending" });
  });

  it("requires PayPal's verified tracking, merchant, consent, product, and scope evidence", async () => {
    const mismatched = { ...goodEvidence, trackingId: "wrong-tracking" };
    const h = createHarness({ status: mismatched });
    await h.service.start(principal, { shopId: shopA, idempotencyKey: "client-request-key-0001", shareDataConsent: true });
    await expect(h.service.complete(principal, { trackingId: trackingA, sellerMerchantIdHint: sellerA }))
      .rejects.toMatchObject({ code: "INVALID_CALLBACK" });
    const unmatched = await h.repository.getByShop(shopA);
    expect(unmatched?.status).toBe("pending");
    expect(unmatched?.sellerMerchantId).toBeUndefined();

    const pending = createHarness({ status: { ...goodEvidence, consentGranted: false } });
    await pending.service.start(principal, { shopId: shopA, idempotencyKey: "client-request-key-0001", shareDataConsent: true });
    await expect(pending.service.complete(principal, { trackingId: trackingA, sellerMerchantIdHint: sellerA }))
      .resolves.toMatchObject({ status: "pending", paymentsReceivable: true });

    const incompleteEvidence = [
      { ...goodEvidence, paymentsReceivable: false },
      { ...goodEvidence, primaryEmailConfirmed: false },
      { ...goodEvidence, activeProducts: [] },
      { ...goodEvidence, grantedScopes: [] },
    ];
    for (const status of incompleteEvidence) {
      const check = createHarness({ status });
      await check.service.start(principal, { shopId: shopA, idempotencyKey: "client-request-key-0001", shareDataConsent: true });
      await expect(check.service.complete(principal, { trackingId: trackingA, sellerMerchantIdHint: sellerA }))
        .resolves.toMatchObject({ status: "pending" });
    }
  });

  it("marks ready only after status evidence and revokes only from verifier-approved events", async () => {
    const { service, paypal, repository } = createHarness();
    await service.start(principal, { shopId: shopA, idempotencyKey: "client-request-key-0001", shareDataConsent: true });
    await expect(service.complete(principal, { trackingId: trackingA, sellerMerchantIdHint: sellerA }))
      .resolves.toMatchObject({ status: "ready" });
    expect(paypal.getMerchantStatus).toHaveBeenCalledWith(sellerA);
    await expect(service.complete(principal, { trackingId: trackingA, sellerMerchantIdHint: sellerA }))
      .resolves.toMatchObject({ status: "ready" });
    expect(paypal.getMerchantStatus).toHaveBeenCalledTimes(1);
    await expect(service.handleRevocationWebhook({ headers: new Headers(), rawBody: "bad" }))
      .resolves.toMatchObject({ applied: false, outcome: "invalid" });
    await expect(service.handleRevocationWebhook({ headers: new Headers(), rawBody: "verified-event" }))
      .resolves.toMatchObject({ applied: true, duplicate: false, outcome: "revoked" });
    await expect(service.handleRevocationWebhook({ headers: new Headers(), rawBody: "verified-event" }))
      .resolves.toMatchObject({ applied: false, duplicate: true, outcome: "duplicate" });
    await expect(service.get(principal, shopA)).resolves.toMatchObject({ status: "revoked" });
    await expect(service.get(principal, shopB)).rejects.toBeInstanceOf(MerchantConnectionError);
    expect(await repository.getByShop(shopA)).toMatchObject({ status: "revoked" });
  });
});
