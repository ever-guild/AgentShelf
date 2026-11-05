import { afterEach, describe, expect, it, vi } from "vitest";

import {
  issueOrderStatusToken,
  verifyOrderStatusToken,
} from "./order-status-token";
import { sign } from "./signing";

const ORDER_A = "30000000-0000-4000-8000-00000000000a";
const ORDER_B = "30000000-0000-4000-8000-00000000000b";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("order status capability", () => {
  it("verifies for the order it was issued for", () => {
    expect(verifyOrderStatusToken(ORDER_A, issueOrderStatusToken(ORDER_A))).toBe(
      true,
    );
  });

  it("is stable, so an idempotent retry returns the same token", () => {
    expect(issueOrderStatusToken(ORDER_A)).toBe(issueOrderStatusToken(ORDER_A));
  });

  it("does not open another order", () => {
    expect(verifyOrderStatusToken(ORDER_B, issueOrderStatusToken(ORDER_A))).toBe(
      false,
    );
  });

  it("rejects guessed and altered tokens", () => {
    const token = issueOrderStatusToken(ORDER_A);
    const altered = `${token[0] === "A" ? "B" : "A"}${token.slice(1)}`;
    for (const guess of ["", "x", ORDER_A, altered, `${token}x`]) {
      expect(verifyOrderStatusToken(ORDER_A, guess)).toBe(false);
    }
  });

  it("rejects a signature made for another purpose", () => {
    expect(verifyOrderStatusToken(ORDER_A, sign("seller-session:v1", ORDER_A)))
      .toBe(false);
  });

  it("stops verifying when the secret changes", () => {
    const token = issueOrderStatusToken(ORDER_A);
    vi.stubEnv("APP_SIGNING_SECRET", "another-secret-that-is-long-enough-to-use");
    expect(verifyOrderStatusToken(ORDER_A, token)).toBe(false);
  });

  it.each([undefined, "too-short"])(
    "refuses to sign when the secret is %j",
    (secret) => {
      vi.stubEnv("APP_SIGNING_SECRET", secret as string);
      expect(() => issueOrderStatusToken(ORDER_A)).toThrow(
        expect.objectContaining({ code: "SERVER_MISCONFIGURED" }),
      );
    },
  );
});
