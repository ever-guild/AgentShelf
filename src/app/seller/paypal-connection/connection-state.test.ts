import { describe, expect, it } from "vitest";

import {
  deriveConnectionControls,
  statusGuidance,
  statusLabel,
} from "./connection-state";

describe("PayPal connection UI state derivation", () => {
  const shopId = "c60f2df3-245c-4704-ac9f-7e793d826001";
  const sandboxActionUrl =
    "https://www.sandbox.paypal.com/merchantsignup/partner/onboardingentry?token=synthetic";

  it("shows the continuation link only while pending and hides the start form", () => {
    const controls = deriveConnectionControls({
      loading: false,
      shopId,
      shareDataConsent: false,
      actionUrl: sandboxActionUrl,
      connection: {
        configured: true,
        connection: {
          shopId,
          status: "pending",
          nextAction: "continue_paypal",
        },
      },
    });

    expect(controls.continueUrl).toBe(sandboxActionUrl);
    expect(controls.showConnectionForm).toBe(false);
    expect(controls.guidance).toContain("Finish the connection on PayPal.");
  });

  it("clears the continuation link and restores the start form when status becomes revoked, error, or not_connected", () => {
    for (const status of ["revoked", "error", "not_connected", "ready"] as const) {
      const controls = deriveConnectionControls({
        loading: false,
        shopId,
        shareDataConsent: true,
        actionUrl: sandboxActionUrl,
        connection: {
          configured: true,
          connection: { shopId, status },
        },
      });

      expect(controls.continueUrl).toBeNull();
      expect(controls.showConnectionForm).toBe(status !== "ready");
      expect(controls.canStart).toBe(status !== "ready");
    }
  });

  it("blocks starting a duplicate referral when nextAction is contact_support or retry_status", () => {
    const unknownOutcome = deriveConnectionControls({
      loading: false,
      shopId,
      shareDataConsent: true,
      actionUrl: sandboxActionUrl,
      connection: {
        configured: true,
        connection: {
          shopId,
          status: "pending",
          nextAction: "contact_support",
        },
      },
    });
    expect(unknownOutcome.continueUrl).toBeNull();
    expect(unknownOutcome.showConnectionForm).toBe(false);
    expect(unknownOutcome.canStart).toBe(false);
    expect(unknownOutcome.guidance).toContain("contact the platform administrator");

    const retryStatus = deriveConnectionControls({
      loading: false,
      shopId,
      shareDataConsent: true,
      actionUrl: null,
      connection: {
        configured: true,
        connection: {
          shopId,
          status: "error",
          nextAction: "retry_status",
        },
      },
    });
    expect(retryStatus.showConnectionForm).toBe(false);
    expect(retryStatus.canStart).toBe(false);
    expect(retryStatus.guidance).toContain("Refresh the status in a moment.");
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
