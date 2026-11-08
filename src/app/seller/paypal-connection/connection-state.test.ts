import { describe, expect, it } from "vitest";

import {
  createShopRequestGuard,
  deriveConnectionControls,
  shouldKeepActionUrl,
  statusGuidance,
  statusLabel,
} from "./connection-state";

describe("PayPal connection UI state derivation", () => {
  const shopA = "c60f2df3-245c-4704-ac9f-7e793d826001";
  const shopB = "e89336e2-81e7-456d-9a40-d081216292d1";
  const sandboxActionUrl =
    "https://www.sandbox.paypal.com/merchantsignup/partner/onboardingentry?token=synthetic";

  it("shows the continuation link only when status is pending and nextAction is continue_paypal", () => {
    const validContinue = deriveConnectionControls({
      loading: false,
      shopId: shopA,
      shareDataConsent: false,
      actionUrl: sandboxActionUrl,
      connection: {
        configured: true,
        connection: {
          shopId: shopA,
          status: "pending",
          nextAction: "continue_paypal",
        },
      },
    });
    expect(shouldKeepActionUrl(validContinue && {
      shopId: shopA,
      status: "pending",
      nextAction: "continue_paypal",
    })).toBe(true);
    expect(validContinue.continueUrl).toBe(sandboxActionUrl);
    expect(validContinue.showConnectionForm).toBe(false);
    expect(validContinue.guidance).toContain("Finish the connection on PayPal.");

    const pendingWithoutNextAction = deriveConnectionControls({
      loading: false,
      shopId: shopA,
      shareDataConsent: true,
      actionUrl: sandboxActionUrl,
      connection: {
        configured: true,
        connection: {
          shopId: shopA,
          status: "pending",
        },
      },
    });
    expect(shouldKeepActionUrl({ shopId: shopA, status: "pending" })).toBe(false);
    expect(pendingWithoutNextAction.continueUrl).toBeNull();
    expect(pendingWithoutNextAction.showConnectionForm).toBe(false);
    expect(pendingWithoutNextAction.canStart).toBe(false);
    expect(pendingWithoutNextAction.guidance).toContain(
      "A connection request is in progress.",
    );
  });

  it("clears the continuation link and restores the start form when status becomes revoked, error, or not_connected", () => {
    for (const status of ["revoked", "error", "not_connected", "ready"] as const) {
      expect(shouldKeepActionUrl({ shopId: shopA, status })).toBe(false);
      const controls = deriveConnectionControls({
        loading: false,
        shopId: shopA,
        shareDataConsent: true,
        actionUrl: sandboxActionUrl,
        connection: {
          configured: true,
          connection: { shopId: shopA, status },
        },
      });

      expect(controls.continueUrl).toBeNull();
      expect(controls.showConnectionForm).toBe(status !== "ready");
      expect(controls.canStart).toBe(status !== "ready");
    }
  });

  it("blocks starting a duplicate referral when nextAction is contact_support or retry_status", () => {
    expect(
      shouldKeepActionUrl({
        shopId: shopA,
        status: "pending",
        nextAction: "contact_support",
      }),
    ).toBe(false);
    const unknownOutcome = deriveConnectionControls({
      loading: false,
      shopId: shopA,
      shareDataConsent: true,
      actionUrl: sandboxActionUrl,
      connection: {
        configured: true,
        connection: {
          shopId: shopA,
          status: "pending",
          nextAction: "contact_support",
        },
      },
    });
    expect(unknownOutcome.continueUrl).toBeNull();
    expect(unknownOutcome.showConnectionForm).toBe(false);
    expect(unknownOutcome.canStart).toBe(false);
    expect(unknownOutcome.guidance).toContain("contact the platform administrator");

    expect(
      shouldKeepActionUrl({
        shopId: shopA,
        status: "error",
        nextAction: "retry_status",
      }),
    ).toBe(false);
    const retryStatus = deriveConnectionControls({
      loading: false,
      shopId: shopA,
      shareDataConsent: true,
      actionUrl: sandboxActionUrl,
      connection: {
        configured: true,
        connection: {
          shopId: shopA,
          status: "error",
          nextAction: "retry_status",
        },
      },
    });
    expect(retryStatus.continueUrl).toBeNull();
    expect(retryStatus.showConnectionForm).toBe(false);
    expect(retryStatus.canStart).toBe(false);
    expect(retryStatus.guidance).toContain("Refresh the status in a moment.");
  });

  it("rejects delayed refresh and start responses from a previously selected shop", async () => {
    const guard = createShopRequestGuard(shopA);
    const oldRefresh = guard.beginRefresh(shopA);
    const oldStart = guard.beginStart(shopA);

    // Starting invalidates an earlier in-flight refresh for the same shop
    expect(guard.isCurrentRefresh(oldRefresh, shopA)).toBe(false);
    expect(guard.isCurrentStart(oldStart, shopA)).toBe(true);

    // Switching to shopB invalidates both in-flight refresh and start from shopA
    guard.switchShop(shopB);
    const newRefresh = guard.beginRefresh(shopB);

    const appliedStates: string[] = [];
    await Promise.all([
      Promise.resolve().then(() => {
        if (guard.isCurrentStart(oldStart, shopA)) {
          appliedStates.push(`start:${shopA}`);
        }
      }),
      Promise.resolve().then(() => {
        if (guard.isCurrentRefresh(newRefresh, shopB)) {
          appliedStates.push(`refresh:${shopB}`);
        }
      }),
    ]);

    expect(guard.isCurrentStart(oldStart, shopA)).toBe(false);
    expect(guard.isCurrentRefresh(newRefresh, shopA)).toBe(false);
    expect(guard.isCurrentRefresh(newRefresh, shopB)).toBe(true);
    expect(appliedStates).toEqual([`refresh:${shopB}`]);
  });

  it("maps status labels and guidance without leaking provider identifiers", () => {
    expect(statusLabel("not_connected")).toBe("Not connected");
    expect(statusLabel("pending")).toBe("Waiting for PayPal approval");
    expect(statusLabel("ready")).toBe("Connected");
    expect(statusLabel("revoked")).toBe("Connection revoked");
    expect(statusLabel("error")).toBe("Connection needs attention");

    expect(
      statusGuidance({ status: "revoked", hasActionUrl: false }),
    ).toContain("PayPal Sandbox access was revoked");
    expect(
      statusGuidance({
        status: "error",
        nextAction: "retry_connection",
        hasActionUrl: false,
      }),
    ).toContain("start a new connection");
  });
});
