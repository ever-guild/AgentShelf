import { describe, expect, it } from "vitest";

import { paypalLoginErrorMessage } from "./messages";

describe("PayPal login messages", () => {
  it("maps only known callback errors to safe interface copy", () => {
    expect(paypalLoginErrorMessage("paypal_not_configured")).toContain("not available right now");
    expect(paypalLoginErrorMessage("paypal_login_denied")).toContain("was canceled");
    expect(paypalLoginErrorMessage("paypal_login_failed")).toContain("could not complete");
    expect(paypalLoginErrorMessage("paypal_login_state_invalid")).toContain("could not be verified");
    expect(paypalLoginErrorMessage("paypal_login_rate_limited")).toContain("too many PayPal sign-in attempts");
    expect(paypalLoginErrorMessage("paypal_login_already_signed_in")).toContain("already signed in");
  });

  it("does not reflect unknown or repeated query values", () => {
    expect(paypalLoginErrorMessage("provider-secret-value")).toBeNull();
    expect(paypalLoginErrorMessage(["paypal_login_failed", "other"])).toBeNull();
    expect(paypalLoginErrorMessage(undefined)).toBeNull();
  });
});
