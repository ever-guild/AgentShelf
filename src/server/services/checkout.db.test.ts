import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import {
  createProduct,
  createService,
  createShop,
} from "../../../test/fixtures";
import { createFakePayPal } from "../../../test/paypal-fake";
import { verifyOrderStatusToken } from "../auth/order-status-token";
import { orderLines, orders, products } from "../db/schema";
import { ServiceError, type ServiceErrorCode } from "../errors";
import { createPayPalProvider } from "../paypal/orders";
import { createCheckout, type CheckoutDeps } from "./checkout";

const getDb = setupMigratedDatabase();

const CLIENT_SECRET = "test-client-secret-value";
const MERCHANT_ID = "STOREDMERCHANT1";
const KEY = "3f0c9c58-6f6d-4e2b-9a57-0f4f7f0f1a11";
const OTHER_KEY = "7a1d2b90-3c4e-4f5a-8b6c-1d2e3f4a5b6c";

let paypal: ReturnType<typeof createFakePayPal>;
let deps: CheckoutDeps;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  paypal = createFakePayPal();
  deps = {
    paypalFor: createPayPalProvider(
      {
        PAYPAL_CLIENT_ID_TEST_SHOP: "test-client-id",
        PAYPAL_CLIENT_SECRET_TEST_SHOP: CLIENT_SECRET,
      },
      paypal.adapter,
    ),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function createSellableProduct(priceMinor = 990) {
  const shop = await createShop(getDb(), { paypalMerchantId: MERCHANT_ID });
  const product = await createProduct(getDb(), shop.id, { priceMinor });
  return { shop, product };
}

const cart = (productId: string, quantity = 1, idempotencyKey = KEY) => ({
  items: [{ productId, quantity }],
  idempotencyKey,
});

const onlyOrder = async () => {
  const rows = await getDb().select().from(orders);
  expect(rows).toHaveLength(1);
  return rows[0];
};

async function codeOf(attempt: Promise<unknown>): Promise<ServiceErrorCode> {
  const error = await attempt.then(
    () => {
      throw new Error("Expected the checkout to fail");
    },
    (rejection) => rejection,
  );
  if (!(error instanceof ServiceError)) {
    throw error;
  }
  return error.code;
}

describe("createCheckout", () => {
  it("stores a pending order from stored data and returns the approval link", async () => {
    const { shop, product } = await createSellableProduct(990);
    const cable = await createProduct(getDb(), shop.id, {
      title: "Cable",
      priceMinor: 450,
    });

    const result = await createCheckout(
      getDb(),
      {
        items: [
          { productId: product.id, quantity: 3 },
          { productId: cable.id, quantity: 1 },
        ],
        idempotencyKey: KEY,
      },
      deps,
    );

    const order = await onlyOrder();
    const [created] = paypal.createdOrders();
    expect(result).toEqual({
      orderId: order.id,
      totalMinor: 3420,
      currency: "EUR",
      approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${created.id}`,
      statusToken: expect.any(String),
    });
    expect(verifyOrderStatusToken(order.id, result.statusToken)).toBe(true);
    expect(order).toMatchObject({
      shopId: shop.id,
      kind: "purchase",
      paymentStatus: "pending",
      totalMinor: 3420,
      idempotencyKey: KEY,
      payeeMerchantId: MERCHANT_ID,
      paypalOrderId: created.id,
      paypalCaptureId: null,
      approvalUrl: result.approvalUrl,
    });

    const lines = await getDb()
      .select()
      .from(orderLines)
      .where(eq(orderLines.orderId, order.id));
    expect(lines).toHaveLength(2);
    expect(lines).toContainEqual(
      expect.objectContaining({
        productId: product.id,
        unitPriceMinor: 990,
        quantity: 3,
        lineTotalMinor: 2970,
      }),
    );
  });

  it("sends PayPal the stored amount and recipient and same-origin return pages", async () => {
    const { product } = await createSellableProduct(990);

    const { statusToken } = await createCheckout(getDb(), cart(product.id, 2), deps);

    const order = await onlyOrder();
    const capability = new URLSearchParams({ order: order.id, status: statusToken });
    const [request] = paypal.createRequests();
    expect(paypal.bodyOf(request)).toEqual({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: order.id,
          custom_id: order.id,
          amount: {
            currency_code: "EUR",
            value: "19.80",
            breakdown: { item_total: { currency_code: "EUR", value: "19.80" } },
          },
          payee: { merchant_id: MERCHANT_ID },
          items: [
            {
              name: "Test cable",
              unit_amount: { currency_code: "EUR", value: "9.90" },
              quantity: "2",
            },
          ],
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: `https://shop.example/checkout/return?${capability}`,
            cancel_url: `https://shop.example/checkout/cancel?${capability}`,
            user_action: "PAY_NOW",
          },
        },
      },
    });
    expect(paypal.requestIdOf(request)).toBe(order.id);
  });

  it("only ever creates the order: it requests no capture", async () => {
    const { product } = await createSellableProduct();

    await createCheckout(getDb(), cart(product.id), deps);

    expect(paypal.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/oauth2/token",
      "/v2/checkout/orders",
    ]);
    expect((await onlyOrder()).paymentStatus).toBe("pending");
  });

  it("returns nothing about the merchant or its credentials", async () => {
    const { product } = await createSellableProduct();

    const result = await createCheckout(getDb(), cart(product.id), deps);

    expect(JSON.stringify(result)).not.toMatch(
      new RegExp(`${MERCHANT_ID}|TEST_SHOP|${CLIENT_SECRET}|fake-access-token`),
    );
  });

  it("rejects a tampered total, recipient or price before reaching PayPal", async () => {
    const { product } = await createSellableProduct();
    const valid = cart(product.id);

    for (const tampered of [
      { ...valid, totalMinor: 1 },
      { ...valid, payeeMerchantId: "ATTACKER" },
      { ...valid, items: [{ productId: product.id, quantity: 1, priceMinor: 1 }] },
    ]) {
      expect(await codeOf(createCheckout(getDb(), tampered, deps))).toBe(
        "INVALID_INPUT",
      );
    }
    expect(paypal.requests).toHaveLength(0);
    expect(await getDb().select().from(orders)).toHaveLength(0);
  });

  it("refuses a cart that must not reach PayPal, and stores nothing", async () => {
    const { shop, product } = await createSellableProduct();
    const otherShop = await createShop(getDb());
    const foreign = await createProduct(getDb(), otherShop.id);
    const service = await createService(getDb(), shop.id);
    const unavailable = await createProduct(getDb(), shop.id, {
      availability: "unavailable",
    });
    const draft = await createProduct(getDb(), shop.id, { status: "draft" });
    const noMerchantShop = await createShop(getDb(), { paypalMerchantId: null });
    const noMerchant = await createProduct(getDb(), noMerchantShop.id);
    const noCredentialsShop = await createShop(getDb(), {
      paypalCredentialRef: "SHOP_WITHOUT_CREDENTIALS",
    });
    const noCredentials = await createProduct(getDb(), noCredentialsShop.id);

    const cases: [ServiceErrorCode, string[]][] = [
      ["MIXED_SHOPS", [product.id, foreign.id]],
      ["PRODUCT_REQUIRES_BOOKING", [service.id]],
      ["PRODUCT_UNAVAILABLE", [unavailable.id]],
      ["PRODUCT_NOT_FOUND", [draft.id]],
      ["PAYMENT_NOT_CONFIGURED", [noMerchant.id]],
      ["PAYMENT_NOT_CONFIGURED", [noCredentials.id]],
    ];
    for (const [code, productIds] of cases) {
      const items = productIds.map((productId) => ({ productId, quantity: 1 }));
      expect(
        await codeOf(createCheckout(getDb(), { items, idempotencyKey: KEY }, deps)),
      ).toBe(code);
    }
    expect(paypal.requests).toHaveLength(0);
    expect(await getDb().select().from(orders)).toHaveLength(0);
  });
});

describe("repeated requests", () => {
  it("return the same local and PayPal order", async () => {
    const { product } = await createSellableProduct();

    const first = await createCheckout(getDb(), cart(product.id), deps);
    const second = await createCheckout(getDb(), cart(product.id), deps);

    expect(second).toEqual(first);
    await onlyOrder();
    expect(paypal.createRequests()).toHaveLength(1);
  });

  it("keep the stored terms after the price changes or the product is withdrawn", async () => {
    const { product } = await createSellableProduct(990);
    const first = await createCheckout(getDb(), cart(product.id), deps);

    await getDb()
      .update(products)
      .set({ priceMinor: 1, status: "unpublished" })
      .where(eq(products.id, product.id));

    expect(await createCheckout(getDb(), cart(product.id), deps)).toEqual(first);
    expect(first.totalMinor).toBe(990);
  });

  it("are refused when the same key names a different cart", async () => {
    const { product } = await createSellableProduct();
    await createCheckout(getDb(), cart(product.id, 1), deps);

    expect(await codeOf(createCheckout(getDb(), cart(product.id, 2), deps))).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
    expect(paypal.createRequests()).toHaveLength(1);
  });

  it("converge on one order when they race", async () => {
    const { product } = await createSellableProduct();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createCheckout(getDb(), cart(product.id), deps),
      ),
    );

    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    await onlyOrder();
    expect(paypal.createdOrders()).toHaveLength(1);
  });
});

describe("recovering from an unknown outcome", () => {
  it("finds the original PayPal order after its response was lost", async () => {
    const { product } = await createSellableProduct();
    paypal.nextOrder({ type: "timeout", orderCreated: true });

    expect(await codeOf(createCheckout(getDb(), cart(product.id), deps))).toBe(
      "PAYMENT_TIMEOUT",
    );
    expect(await onlyOrder()).toMatchObject({
      paymentStatus: "pending",
      paypalOrderId: null,
      approvalUrl: null,
    });

    const result = await createCheckout(getDb(), cart(product.id), deps);

    expect(paypal.createdOrders()).toHaveLength(1);
    const [first, second] = paypal.createRequests();
    expect(paypal.requestIdOf(second)).toBe(paypal.requestIdOf(first));
    expect(paypal.bodyOf(second)).toEqual(paypal.bodyOf(first));
    expect(result.approvalUrl).toContain(String(paypal.createdOrders()[0].id));
    expect((await onlyOrder()).paypalOrderId).toBe(paypal.createdOrders()[0].id);
  });

  it("sends the first terms again even if the product changed in between", async () => {
    const { product } = await createSellableProduct(990);
    paypal.nextOrder({ type: "timeout", orderCreated: false });
    await codeOf(createCheckout(getDb(), cart(product.id), deps));

    await getDb()
      .update(products)
      .set({ priceMinor: 1, status: "unpublished" })
      .where(eq(products.id, product.id));
    const result = await createCheckout(getDb(), cart(product.id), deps);

    expect(result.totalMinor).toBe(990);
    expect(paypal.bodyOf(paypal.createRequests()[1]).purchase_units[0].amount.value).toBe(
      "9.90",
    );
  });

  it.each([
    ["a server error", 500, { name: "INTERNAL_SERVER_ERROR" }],
    [
      "a request still in progress",
      409,
      {
        name: "RESOURCE_CONFLICT",
        details: [{ issue: "PREVIOUS_REQUEST_IN_PROGRESS" }],
      },
    ],
    ["rate limiting", 429, { name: "RATE_LIMIT_REACHED" }],
  ])("leaves %s open to a retry with the same key", async (_name, status, body) => {
    const { product } = await createSellableProduct();
    paypal.nextOrder({ type: "respond", status, body });

    expect(await codeOf(createCheckout(getDb(), cart(product.id), deps))).toBe(
      "PAYMENT_UNAVAILABLE",
    );
    expect((await onlyOrder()).paymentStatus).toBe("pending");

    await expect(
      createCheckout(getDb(), cart(product.id), deps),
    ).resolves.toMatchObject({ orderId: (await onlyOrder()).id });
  });

  it("recovers from a failed token exchange without a restart", async () => {
    const { product } = await createSellableProduct();
    paypal.nextToken({ type: "timeout" });

    expect(await codeOf(createCheckout(getDb(), cart(product.id), deps))).toBe(
      "PAYMENT_TIMEOUT",
    );
    expect(paypal.createRequests()).toHaveLength(0);

    await expect(
      createCheckout(getDb(), cart(product.id), deps),
    ).resolves.toMatchObject({ currency: "EUR" });
    expect(paypal.tokenRequests()).toHaveLength(2);
    expect(paypal.createRequests()).toHaveLength(1);
  });

  it("stops repeating the request once PayPal may have forgotten it", async () => {
    const { product } = await createSellableProduct();
    paypal.nextOrder({ type: "timeout", orderCreated: true });
    await codeOf(createCheckout(getDb(), cart(product.id), deps));
    await getDb()
      .update(orders)
      .set({ createdAt: sql`now() - interval '6 hours 1 minute'` });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await codeOf(createCheckout(getDb(), cart(product.id), deps))).toBe(
        "CHECKOUT_NEEDS_REVIEW",
      );
    }
    expect(paypal.createRequests()).toHaveLength(1);
    expect((await onlyOrder()).paymentStatus).toBe("review_required");

    await expect(
      createCheckout(getDb(), cart(product.id, 1, OTHER_KEY), deps),
    ).resolves.toMatchObject({ totalMinor: 990 });
  });
});

describe("when PayPal refuses", () => {
  const refusal = {
    name: "UNPROCESSABLE_ENTITY",
    debug_id: "debug-id-123",
    message: "The requested action could not be performed.",
    details: [
      {
        issue: "PAYEE_ACCOUNT_RESTRICTED",
        description: `Payee ${MERCHANT_ID} is restricted`,
      },
    ],
  };

  it("fails the order for good, while a new key can try again", async () => {
    const { product } = await createSellableProduct();
    paypal.nextOrder({ type: "respond", status: 422, body: refusal });

    expect(await codeOf(createCheckout(getDb(), cart(product.id), deps))).toBe(
      "PAYMENT_DECLINED",
    );
    expect(await onlyOrder()).toMatchObject({
      paymentStatus: "failed",
      paypalOrderId: null,
      approvalUrl: null,
    });

    expect(await codeOf(createCheckout(getDb(), cart(product.id), deps))).toBe(
      "PAYMENT_DECLINED",
    );
    expect(paypal.createRequests()).toHaveLength(1);

    await expect(
      createCheckout(getDb(), cart(product.id, 1, OTHER_KEY), deps),
    ).resolves.toMatchObject({ totalMinor: 990 });
  });

  it.each([
    ["the seller's credentials", "token", 401, { error: "invalid_client" }],
    [
      "permission for this recipient",
      "order",
      403,
      {
        name: "NOT_AUTHORIZED",
        details: [{ issue: "PERMISSION_DENIED" }],
      },
    ],
    [
      "consent from this recipient",
      "order",
      422,
      { name: "NOT_AUTHORIZED", details: [{ issue: "PAYEE_NOT_CONSENTED" }] },
    ],
  ] as const)(
    "reports %s as configuration, leaving the order retryable",
    async (_name, where, status, body) => {
      const { product } = await createSellableProduct();
      const step = { type: "respond", status, body } as const;
      if (where === "token") {
        paypal.nextToken(step);
      } else {
        paypal.nextOrder(step);
      }

      expect(await codeOf(createCheckout(getDb(), cart(product.id), deps))).toBe(
        "PAYMENT_NOT_CONFIGURED",
      );
      expect((await onlyOrder()).paymentStatus).toBe("pending");

      await expect(
        createCheckout(getDb(), cart(product.id), deps),
      ).resolves.toMatchObject({ totalMinor: 990 });
    },
  );

  it("logs PayPal's diagnostics, and no credentials or merchant identifiers", async () => {
    const { product } = await createSellableProduct();
    paypal.nextOrder({ type: "respond", status: 422, body: refusal });

    const error = await createCheckout(getDb(), cart(product.id), deps).catch(
      (rejection) => rejection,
    );

    const order = await onlyOrder();
    expect(consoleError).toHaveBeenCalledWith("PayPal order creation failed", {
      orderId: order.id,
      kind: "rejected",
      status: 422,
      name: "UNPROCESSABLE_ENTITY",
      debugId: "debug-id-123",
      issues: ["PAYEE_ACCOUNT_RESTRICTED"],
    });
    const visible = JSON.stringify([consoleError.mock.calls, error, error.message]);
    for (const secret of [MERCHANT_ID, CLIENT_SECRET, "fake-access-token", "Bearer"]) {
      expect(visible).not.toContain(secret);
    }
  });
});

describe("when PayPal's answer is not the order that was requested", () => {
  type Json = Record<string, unknown>;
  type Change = (order: Json) => Json;
  const unit = (order: Json) => (order.purchase_units as Json[])[0];
  const withUnit = (change: (u: Json) => void): Change => (order) => {
    change(unit(order));
    return order;
  };
  const withLink = (href: string): Change => (order) => ({
    ...order,
    links: [{ href, rel: "payer-action", method: "GET" }],
  });

  const cases: [string, Change][] = [
    [
      "another recipient",
      withUnit((u) => {
        u.payee = { merchant_id: "ATTACKERMERCHANT" };
      }),
    ],
    [
      "no recipient",
      withUnit((u) => {
        delete u.payee;
      }),
    ],
    [
      "another amount",
      withUnit((u) => {
        u.amount = { currency_code: "EUR", value: "0.01" };
      }),
    ],
    [
      "another currency",
      withUnit((u) => {
        u.amount = { currency_code: "USD", value: "9.90" };
      }),
    ],
    [
      "another reference",
      withUnit((u) => {
        u.reference_id = "someone-elses-order";
      }),
    ],
    ["another intent", (order) => ({ ...order, intent: "AUTHORIZE" })],
    [
      "a second purchase unit",
      (order) => ({
        ...order,
        purchase_units: [unit(order), unit(order)],
      }),
    ],
    ["a live PayPal link", withLink("https://www.paypal.com/checkoutnow?token=X")],
    ["a foreign link", withLink("https://paypal.example/checkoutnow?token=X")],
    ["no approval link", (order) => ({ ...order, links: [] })],
    ["a closed order", (order) => ({ ...order, status: "VOIDED" })],
  ];

  it.each(cases)("%s yields no link and sends the order to review", async (_name, change) => {
    const { product } = await createSellableProduct();
    paypal.nextOrder({ type: "change", change });

    expect(await codeOf(createCheckout(getDb(), cart(product.id), deps))).toBe(
      "CHECKOUT_NEEDS_REVIEW",
    );
    expect(await onlyOrder()).toMatchObject({
      paymentStatus: "review_required",
      approvalUrl: null,
    });

    expect(await codeOf(createCheckout(getDb(), cart(product.id), deps))).toBe(
      "CHECKOUT_NEEDS_REVIEW",
    );
    expect(paypal.createRequests()).toHaveLength(1);
  });

  it("a link for a different PayPal order is refused", async () => {
    const { product } = await createSellableProduct();
    paypal.nextOrder({
      type: "change",
      change: (order) => ({
        ...order,
        links: [
          {
            href: "https://www.sandbox.paypal.com/checkoutnow?token=OTHERORDER",
            rel: "payer-action",
            method: "GET",
          },
        ],
      }),
    });

    expect(await codeOf(createCheckout(getDb(), cart(product.id), deps))).toBe(
      "CHECKOUT_NEEDS_REVIEW",
    );
  });

  it("a minimal response is not trusted, because it names no recipient", async () => {
    const { product } = await createSellableProduct();
    paypal.nextOrder({
      type: "change",
      change: ({ id, status, links }) => ({ id, status, links }),
    });

    expect(await codeOf(createCheckout(getDb(), cart(product.id), deps))).toBe(
      "CHECKOUT_NEEDS_REVIEW",
    );
  });

  it("a retry that lost a race returns the stored link, whatever PayPal reports by then", async () => {
    const { product } = await createSellableProduct();
    const storedLink = (id: unknown) =>
      `https://www.sandbox.paypal.com/checkoutnow?token=${id}`;
    paypal.nextOrder({
      type: "change",
      change: async (order) => {
        // The other request finishes while this one waits, and the buyer approves.
        await getDb()
          .update(orders)
          .set({ paypalOrderId: String(order.id), approvalUrl: storedLink(order.id) });
        return { ...order, status: "APPROVED", links: [] };
      },
    });

    const result = await createCheckout(getDb(), cart(product.id), deps);

    expect(result.approvalUrl).toBe(storedLink(paypal.createdOrders()[0].id));
    expect((await onlyOrder()).paymentStatus).toBe("pending");
  });

  it("a retry that got a different PayPal order sends the stored one to review", async () => {
    const { product } = await createSellableProduct();
    paypal.nextOrder({
      type: "change",
      change: async (order) => {
        await getDb().update(orders).set({
          paypalOrderId: "STOREDPAYPALORDER",
          approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=STOREDPAYPALORDER",
        });
        return order;
      },
    });

    expect(await codeOf(createCheckout(getDb(), cart(product.id), deps))).toBe(
      "CHECKOUT_NEEDS_REVIEW",
    );
    expect(await onlyOrder()).toMatchObject({
      paymentStatus: "review_required",
      paypalOrderId: "STOREDPAYPALORDER",
    });

    // The stored link is no longer offered, even though it is still on the row.
    expect(await codeOf(createCheckout(getDb(), cart(product.id), deps))).toBe(
      "CHECKOUT_NEEDS_REVIEW",
    );
  });
});
