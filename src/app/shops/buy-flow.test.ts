import { describe, expect, it, vi } from "vitest";

import {
  CheckoutFailure,
  noticeFor,
  preparePayPalSession,
  requestCheckout,
  type PayPalNamespace,
} from "./buy-flow";

const callbacks = { onApprove: vi.fn(), onCancel: vi.fn(), onError: vi.fn() };

function fakePayPal(eligible: boolean) {
  const session = { start: vi.fn() };
  const createPayPalOneTimePaymentSession = vi.fn(() => session);
  const findEligibleMethods = vi.fn(async () => ({ isEligible: () => eligible }));
  const createInstance = vi.fn(async () => ({
    findEligibleMethods,
    createPayPalOneTimePaymentSession,
  }));
  return {
    paypal: { createInstance } as unknown as PayPalNamespace,
    createInstance,
    findEligibleMethods,
    createPayPalOneTimePaymentSession,
    session,
  };
}

describe("preparePayPalSession", () => {
  it("starts the SDK with the shop's client ID, as documented for v6, and no merchant or amount", async () => {
    const fake = fakePayPal(true);
    const session = await preparePayPalSession(fake.paypal, "client-1", "EUR", callbacks);

    expect(session).toBe(fake.session);
    expect(fake.createInstance).toHaveBeenCalledWith({
      clientId: "client-1",
      components: ["paypal-payments"],
      pageType: "product-details",
    });
    expect(fake.findEligibleMethods).toHaveBeenCalledWith({ currencyCode: "EUR" });
    expect(fake.createPayPalOneTimePaymentSession).toHaveBeenCalledWith(callbacks);
  });

  it("offers no session when PayPal says the buyer cannot pay this way", async () => {
    const fake = fakePayPal(false);
    await expect(
      preparePayPalSession(fake.paypal, "client-1", "EUR", callbacks),
    ).resolves.toBeUndefined();
    expect(fake.createPayPalOneTimePaymentSession).not.toHaveBeenCalled();
  });
});

describe("requestCheckout", () => {
  const answer = {
    paypalOrderId: "PP1",
    totalMinor: 990,
    currency: "EUR",
    approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=PP1",
    returnPath: "/checkout/return?order=a&status=b",
    cancelPath: "/checkout/cancel?order=a&status=b",
  };

  it("sends only the product and the key", async () => {
    const send = vi.fn(async () => Response.json(answer));
    await expect(requestCheckout("my-shop", "product-1", "key-1", send)).resolves.toEqual(answer);

    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/shops/my-shop/checkout");
    expect(JSON.parse(String(init.body))).toEqual({
      productId: "product-1",
      idempotencyKey: "key-1",
    });
  });

  it("reports the server's code, not its text", async () => {
    const send = vi.fn(async () =>
      Response.json(
        { error: { code: "PAYMENT_DECLINED", message: "Repeating this idempotencyKey" } },
        { status: 422 },
      ),
    );
    const failure = await requestCheckout("s", "p", "k", send).catch((error) => error);
    expect(failure).toBeInstanceOf(CheckoutFailure);
    expect(failure.code).toBe("PAYMENT_DECLINED");
  });

  it("treats a lost connection and an unreadable answer as failures", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(requestCheckout("s", "p", "k", offline)).rejects.toMatchObject({
      code: "NETWORK",
    });
    const garbage = vi.fn(async () => new Response("<html>", { status: 200 }));
    await expect(requestCheckout("s", "p", "k", garbage)).rejects.toMatchObject({
      code: "UNKNOWN",
    });
  });
});

describe("noticeFor", () => {
  it("keeps the key when the outcome is unknown, so a retry continues the same order", () => {
    for (const code of ["PAYMENT_TIMEOUT", "PAYMENT_UNAVAILABLE", "NETWORK", "INTERNAL_ERROR"]) {
      expect(noticeFor(code)).toMatchObject({ newKey: false, final: false });
    }
  });

  it("asks for a new key when repeating this one cannot change the answer", () => {
    for (const code of ["PAYMENT_DECLINED", "CHECKOUT_NEEDS_REVIEW", "IDEMPOTENCY_CONFLICT"]) {
      expect(noticeFor(code)).toMatchObject({ newKey: true, final: false });
    }
  });

  it("removes the button when nothing on the page can help", () => {
    for (const code of ["PAYMENT_NOT_CONFIGURED", "PRODUCT_NOT_FOUND", "PRODUCT_UNAVAILABLE"]) {
      expect(noticeFor(code).final).toBe(true);
    }
  });

  it("never shows agent wording to a buyer, and always says nothing was charged", () => {
    for (const code of ["PAYMENT_DECLINED", "PAYMENT_TIMEOUT", "NETWORK", "ANYTHING"]) {
      expect(noticeFor(code).message).not.toMatch(/idempotency/i);
      expect(noticeFor(code).message).toContain("Nothing has been charged.");
    }
  });
});
