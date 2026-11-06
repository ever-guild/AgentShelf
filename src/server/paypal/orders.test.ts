import { OrderStatus, type Order } from "@paypal/paypal-server-sdk";
import { describe, expect, it } from "vitest";

import { createFakePayPal } from "../../../test/paypal-fake";
import {
  buildOrderRequest,
  createPayPalOrdersProvider,
  describePayPalFailure,
  sandboxApprovalUrl,
} from "./orders";

const REQUEST_ID = "3f0c9c58-6f6d-4e2b-9a57-0f4f7f0f1a11";
const ENV = {
  PAYPAL_CLIENT_ID_SHOP_A: "client-id-a",
  PAYPAL_CLIENT_SECRET_SHOP_A: "client-secret-a",
};

const snapshot = {
  id: REQUEST_ID,
  currency: "EUR",
  totalMinor: 1250,
  payeeMerchantId: "MERCHANT1",
};
const lines = [{ title: "Cable", unitPriceMinor: 625, quantity: 2 }];
const orderCall = () => ({
  body: buildOrderRequest(snapshot, lines, "https://shop.example"),
  paypalRequestId: REQUEST_ID,
  prefer: "return=representation",
});

function ordersFor(paypal: ReturnType<typeof createFakePayPal>, env = ENV) {
  return createPayPalOrdersProvider(env, paypal.adapter)("SHOP_A");
}

describe("createPayPalOrdersProvider", () => {
  it("talks only to the sandbox, with a time limit and no redirects", async () => {
    const paypal = createFakePayPal();

    await ordersFor(paypal)?.createOrder(orderCall());

    expect(paypal.requests).toHaveLength(2);
    for (const request of paypal.requests) {
      expect(new URL(request.url).origin).toBe("https://api-m.sandbox.paypal.com");
      expect(request).toMatchObject({ timeout: 12_000, maxRedirects: 0 });
    }
  });

  it("offers nothing unless both credentials are set", () => {
    const paypal = createFakePayPal();
    const incomplete = [
      {},
      { PAYPAL_CLIENT_ID_SHOP_A: "client-id-a" },
      { PAYPAL_CLIENT_SECRET_SHOP_A: "client-secret-a" },
      { PAYPAL_CLIENT_ID_SHOP_A: " ", PAYPAL_CLIENT_SECRET_SHOP_A: " " },
    ];
    for (const env of incomplete) {
      expect(createPayPalOrdersProvider(env, paypal.adapter)("SHOP_A")).toBeUndefined();
    }
    expect(paypal.requests).toHaveLength(0);
  });

  it("keeps each seller's credentials to its own requests", async () => {
    const paypal = createFakePayPal();
    const provider = createPayPalOrdersProvider(
      {
        ...ENV,
        PAYPAL_CLIENT_ID_SHOP_B: "client-id-b",
        PAYPAL_CLIENT_SECRET_SHOP_B: "client-secret-b",
      },
      paypal.adapter,
    );

    await provider("SHOP_A")?.createOrder(orderCall());
    await provider("SHOP_B")?.createOrder({
      ...orderCall(),
      paypalRequestId: "7a1d2b90-3c4e-4f5a-8b6c-1d2e3f4a5b6c",
    });

    const basicAuthOf = (request: (typeof paypal.requests)[number]) =>
      JSON.stringify(request.headers) + JSON.stringify(request);
    const [tokenA, tokenB] = paypal.tokenRequests();
    expect(basicAuthOf(tokenA)).toContain(
      Buffer.from("client-id-a:client-secret-a").toString("base64"),
    );
    expect(basicAuthOf(tokenB)).toContain(
      Buffer.from("client-id-b:client-secret-b").toString("base64"),
    );
  });

  it("reuses the token between orders", async () => {
    const paypal = createFakePayPal();
    const provider = createPayPalOrdersProvider(ENV, paypal.adapter);

    await provider("SHOP_A")?.createOrder(orderCall());
    await provider("SHOP_A")?.createOrder({
      ...orderCall(),
      paypalRequestId: "7a1d2b90-3c4e-4f5a-8b6c-1d2e3f4a5b6c",
    });

    expect(paypal.tokenRequests()).toHaveLength(1);
    expect(paypal.createRequests()).toHaveLength(2);
  });

  it("does not repeat a failed order request by itself", async () => {
    const paypal = createFakePayPal();
    paypal.nextOrder({ type: "respond", status: 500, body: {} });

    await expect(ordersFor(paypal)?.createOrder(orderCall())).rejects.toMatchObject({
      statusCode: 500,
    });

    expect(paypal.createRequests()).toHaveLength(1);
  });

  it("gets a new token after a failed exchange instead of repeating the failure", async () => {
    const paypal = createFakePayPal();
    const provider = createPayPalOrdersProvider(ENV, paypal.adapter);
    paypal.nextToken({ type: "timeout" });

    await expect(provider("SHOP_A")?.createOrder(orderCall())).rejects.toMatchObject({
      code: "ECONNABORTED",
    });
    await expect(provider("SHOP_A")?.createOrder(orderCall())).resolves.toMatchObject({
      statusCode: 201,
    });

    expect(paypal.tokenRequests()).toHaveLength(2);
  });
});

describe("buildOrderRequest", () => {
  it("converts minor units to exact decimals", () => {
    const body = buildOrderRequest(
      { ...snapshot, totalMinor: 5 },
      [{ title: "Sticker", unitPriceMinor: 5, quantity: 1 }],
      "https://shop.example",
    );
    const [unit] = body.purchaseUnits;
    expect(unit.amount.value).toBe("0.05");
    expect(unit.items?.[0].unitAmount.value).toBe("0.05");
  });

  it("shortens an item name to PayPal's limit without splitting a character", () => {
    const body = buildOrderRequest(
      snapshot,
      [{ title: "📱".repeat(200), unitPriceMinor: 625, quantity: 2 }],
      "https://shop.example",
    );
    expect(body.purchaseUnits[0].items?.[0].name).toBe("📱".repeat(127));
  });
});

describe("sandboxApprovalUrl", () => {
  const ID = "5O190127TN364715T";
  const order = (href: string, changes: Partial<Order> = {}): Order => ({
    id: ID,
    status: OrderStatus.PayerActionRequired,
    links: [{ href, rel: "payer-action" }],
    ...changes,
  });
  const good = `https://www.sandbox.paypal.com/checkoutnow?token=${ID}`;

  it("accepts PayPal's own sandbox checkout for this order", () => {
    expect(sandboxApprovalUrl(order(good))).toBe(good);
    expect(
      sandboxApprovalUrl({
        id: ID,
        status: OrderStatus.Created,
        links: [
          { href: "https://api-m.sandbox.paypal.com/v2/x", rel: "self" },
          { href: good, rel: "approve" },
        ],
      }),
    ).toBe(good);
  });

  it.each([
    ["live PayPal", `https://www.paypal.com/checkoutnow?token=${ID}`],
    ["plain HTTP", `http://www.sandbox.paypal.com/checkoutnow?token=${ID}`],
    ["a lookalike host", `https://www.sandbox.paypal.com.example/checkoutnow?token=${ID}`],
    ["embedded credentials", `https://a:b@www.sandbox.paypal.com/checkoutnow?token=${ID}`],
    ["another port", `https://www.sandbox.paypal.com:8443/checkoutnow?token=${ID}`],
    ["another order", "https://www.sandbox.paypal.com/checkoutnow?token=OTHER"],
    ["no token", "https://www.sandbox.paypal.com/checkoutnow"],
    ["no URL at all", "not a url"],
  ])("refuses %s", (_name, href) => {
    expect(sandboxApprovalUrl(order(href))).toBeUndefined();
  });

  it("refuses a link on an order that is not waiting for the buyer", () => {
    expect(
      sandboxApprovalUrl(order(good, { status: OrderStatus.Completed })),
    ).toBeUndefined();
    expect(sandboxApprovalUrl(order(good, { status: undefined }))).toBeUndefined();
  });
});

describe("describePayPalFailure", () => {
  const apiError = (statusCode: number, result: unknown, url = "/v2/checkout/orders") => ({
    statusCode,
    result,
    request: { url: `https://api-m.sandbox.paypal.com${url}` },
  });

  it.each([
    ["an axios timeout", { code: "ECONNABORTED" }, "timeout"],
    ["a socket timeout", { code: "ETIMEDOUT" }, "timeout"],
    ["a connection failure", { code: "ECONNRESET" }, "unavailable"],
    ["an unknown throw", new Error("boom"), "unavailable"],
    ["a server error", apiError(500, {}), "unavailable"],
    ["a request in progress", apiError(409, {}), "unavailable"],
    ["rate limiting", apiError(429, {}), "unavailable"],
    ["a successful status with a bad body", apiError(201, {}), "unavailable"],
    ["refused credentials", apiError(401, {}), "not_authorized"],
    ["refused permission", apiError(403, {}), "not_authorized"],
    [
      "missing payee consent",
      apiError(422, { details: [{ issue: "PAYEE_NOT_CONSENTED" }] }),
      "not_authorized",
    ],
    ["a refused token request", apiError(400, {}, "/v1/oauth2/token"), "not_authorized"],
    ["an invalid request", apiError(400, {}), "rejected"],
    ["a business refusal", apiError(422, {}), "rejected"],
  ])("treats %s as %s", (_name, thrown, kind) => {
    expect(describePayPalFailure(thrown).kind).toBe(kind);
  });

  it("reads a raw body when the SDK did not parse one", () => {
    expect(
      describePayPalFailure({
        statusCode: 500,
        body: JSON.stringify({ name: "INTERNAL_SERVER_ERROR", debug_id: "abc123" }),
      }),
    ).toEqual({
      kind: "unavailable",
      status: 500,
      name: "INTERNAL_SERVER_ERROR",
      debugId: "abc123",
    });
    expect(describePayPalFailure({ statusCode: 502, body: "<html>" })).toEqual({
      kind: "unavailable",
      status: 502,
    });
  });

  it("falls back to the debug ID header, for errors from the token endpoint", () => {
    expect(
      describePayPalFailure({
        statusCode: 401,
        result: { error: "invalid_client", error_description: "Client id is wrong" },
        headers: { "paypal-debug-id": "header-debug-id" },
      }),
    ).toEqual({
      kind: "not_authorized",
      status: 401,
      name: "invalid_client",
      debugId: "header-debug-id",
    });
  });

  it("keeps only short codes, never free text or request data", () => {
    const failure = describePayPalFailure({
      statusCode: 422,
      code: "contains spaces and a secret",
      request: { headers: { authorization: "Bearer real-token" } },
      result: {
        name: "UNPROCESSABLE_ENTITY",
        message: "Payee MERCHANT1 is restricted",
        debug_id: "line\nbreak",
        details: [
          { issue: "AMOUNT_MISMATCH", description: "Payee MERCHANT1 ..." },
          { issue: "has spaces" },
        ],
      },
    });

    expect(failure).toEqual({
      kind: "rejected",
      status: 422,
      name: "UNPROCESSABLE_ENTITY",
      issues: ["AMOUNT_MISMATCH"],
    });
  });
});
