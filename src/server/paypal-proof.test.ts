import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CheckoutPaymentIntent,
  OrderStatus,
  OrdersController,
  type Order,
  type OrderRequest,
} from "@paypal/paypal-server-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOrdersApi,
  executeProofCommand,
} from "../../scripts/paypal-proof";

const CREATE_ID = "11111111-1111-4111-8111-111111111111";
const CAPTURE_ID = "22222222-2222-4222-8222-222222222222";
const REFERENCE = "proof-phone-001";
const ORDER_ID = "ORDER-7XZ5A7F314";
const PHONE_MERCHANT_ID = "2ABCDEFHJKLMN";
const SECOND_MERCHANT_ID = "3BCDEFGHJKLMN";

const phoneOnlyEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  APP_ORIGIN: "https://agentshelf-e5bk.onrender.com",
  PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP: "phone-client-id-test",
  PAYPAL_CLIENT_SECRET_DEMO_PHONE_WORKSHOP: "phone-client-secret-test",
  DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID: PHONE_MERCHANT_ID,
};

const bothShopsEnv: NodeJS.ProcessEnv = {
  ...phoneOnlyEnv,
  PAYPAL_CLIENT_ID_DEMO_SECOND_SHOP: "second-client-id-test",
  PAYPAL_CLIENT_SECRET_DEMO_SECOND_SHOP: "second-client-secret-test",
  DEMO_SECOND_SHOP_PAYPAL_MERCHANT_ID: SECOND_MERCHANT_ID,
};

const stateDirs: string[] = [];

async function makeStateDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentshelf-paypal-proof-"));
  stateDirs.push(directory);
  return directory;
}

function order(
  status: OrderStatus,
  changes: Partial<Order> = {},
): Order {
  return {
    id: ORDER_ID,
    intent: CheckoutPaymentIntent.Capture,
    status,
    purchaseUnits: [
      {
        referenceId: REFERENCE,
        customId: REFERENCE,
        payee: { merchantId: PHONE_MERCHANT_ID },
        amount: { currencyCode: "EUR", value: "1.00" },
        ...(status === OrderStatus.Completed
          ? {
              payments: {
                captures: [
                  {
                    id: "CAPTURE-7XZ5A7F314",
                    status: "COMPLETED",
                    amount: { currencyCode: "EUR", value: "1.00" },
                  },
                ],
              },
            }
          : {}),
      },
    ],
    links: [
      {
        rel: "approve",
        href: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`,
        method: "GET",
      },
    ],
    ...changes,
  } as Order;
}

function response<T>(result: T, statusCode = 200) {
  return { result, statusCode };
}

function factory(api: object) {
  return () => api as unknown as OrdersController;
}

const createArgs = (reference = REFERENCE, requestId = CREATE_ID) => [
  "create",
  "--shop",
  "DEMO_PHONE_WORKSHOP",
  "--amount",
  "1.00",
  "--currency",
  "EUR",
  "--reference",
  reference,
  "--request-id",
  requestId,
];

afterEach(async () => {
  await Promise.all(stateDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PayPal sandbox proof CLI", () => {
  it("persists exact create request before POST and safely reuses state on a later command", async () => {
    const stateDir = await makeStateDir();
    const capturedRequests: unknown[] = [];
    const api = {
      createOrder: vi.fn(async (request: unknown) => {
        const journal = JSON.parse(await readFile(join(stateDir, "proof-state.json"), "utf8"));
        expect(journal.records[0].createRequestId).toBe(CREATE_ID);
        expect(journal.records[0].createPayload.purchaseUnits[0].payee.merchantId).toBe(PHONE_MERCHANT_ID);
        expect((await stat(join(stateDir, "proof-state.json"))).mode & 0o777).toBe(0o600);
        capturedRequests.push(request);
        return response(order(OrderStatus.PayerActionRequired), 201);
      }),
      getOrder: vi.fn(async () => response(order(OrderStatus.PayerActionRequired))),
      captureOrder: vi.fn(),
    };
    const logs: string[] = [];

    await expect(
      executeProofCommand(createArgs(), {
        env: phoneOnlyEnv,
        stateDir,
        apiFactory: factory(api),
        log: (line) => logs.push(line),
      }),
    ).resolves.toBe(0);
    await expect(
      executeProofCommand(createArgs(), {
        env: phoneOnlyEnv,
        stateDir,
        apiFactory: factory(api),
        log: (line) => logs.push(line),
      }),
    ).resolves.toBe(0);

    expect(api.createOrder).toHaveBeenCalledTimes(1);
    expect(api.getOrder).toHaveBeenCalledTimes(1);
    expect(capturedRequests[0]).toMatchObject({
      body: {
        intent: "CAPTURE",
        purchaseUnits: [
          {
            amount: { currencyCode: "EUR", value: "1.00" },
            payee: { merchantId: PHONE_MERCHANT_ID },
            referenceId: REFERENCE,
            customId: REFERENCE,
          },
        ],
      },
      paypalRequestId: CREATE_ID,
      prefer: "return=representation",
    });
    expect(logs.some((line) => line.includes("PAYER_ACTION_REQUIRED"))).toBe(true);
    expect(logs.join("\n")).toContain("https://www.sandbox.paypal.com/checkoutnow?token=");
    expect(logs.join("\n")).not.toContain("phone-client-secret-test");
  });

  it("retries an ambiguous create only with the saved exact payload and UUID", async () => {
    const stateDir = await makeStateDir();
    const requests: unknown[] = [];
    const api = {
      createOrder: vi
        .fn()
        .mockImplementationOnce(async (request: unknown) => {
          requests.push(request);
          throw Object.assign(new Error("do not expose this bearer secret"), { statusCode: 503 });
        })
        .mockImplementationOnce(async (request: unknown) => {
          requests.push(request);
          return response(order(OrderStatus.Created), 201);
        }),
      getOrder: vi.fn(),
      captureOrder: vi.fn(),
    };

    await expect(
      executeProofCommand(createArgs(), {
        env: phoneOnlyEnv,
        stateDir,
        apiFactory: factory(api),
        log: () => {},
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("HTTP 503") });
    await expect(
      executeProofCommand(createArgs(), {
        env: phoneOnlyEnv,
        stateDir,
        apiFactory: factory(api),
        log: () => {},
      }),
    ).resolves.toBe(0);

    expect(requests[0]).toEqual(requests[1]);
    expect(api.createOrder).toHaveBeenCalledTimes(2);
    const journal = JSON.parse(await readFile(join(stateDir, "proof-state.json"), "utf8"));
    expect(journal.records[0].createRequestId).toBe(CREATE_ID);
    expect(JSON.stringify(journal)).not.toContain("client-secret");
    expect(JSON.stringify(journal)).not.toContain("checkoutnow");
  });

  it("blocks expired ambiguous creates, conflicting payloads, and corrupt journal data before network", async () => {
    const stateDir = await makeStateDir();
    const api = {
      createOrder: vi.fn().mockRejectedValue(new Error("timeout")),
      getOrder: vi.fn(),
      captureOrder: vi.fn(),
    };
    const start = Date.now();
    await expect(
      executeProofCommand(createArgs(), {
        env: phoneOnlyEnv,
        stateDir,
        now: () => start,
        apiFactory: factory(api),
        log: () => {},
      }),
    ).rejects.toThrow("Create result is unresolved");
    await expect(
      executeProofCommand(createArgs(), {
        env: phoneOnlyEnv,
        stateDir,
        now: () => start + 6 * 60 * 60 * 1000,
        apiFactory: factory(api),
        log: () => {},
      }),
    ).rejects.toThrow("safe retry window");
    await expect(
      executeProofCommand([...createArgs(), "--unused", "x"], {
        env: phoneOnlyEnv,
        stateDir,
        apiFactory: factory(api),
        log: () => {},
      }),
    ).rejects.toThrow("Unknown command option");
    expect(api.createOrder).toHaveBeenCalledTimes(1);

    await writeFile(join(stateDir, "proof-state.json"), JSON.stringify({ version: 1, records: [{ createCreatedAt: null }] }), { mode: 0o600 });
    await expect(
      executeProofCommand(["inspect", "--reference", REFERENCE], {
        env: phoneOnlyEnv,
        stateDir,
        apiFactory: factory(api),
        log: () => {},
      }),
    ).rejects.toThrow("invalid or duplicate records");
    expect(api.getOrder).not.toHaveBeenCalled();
  });

  it("captures only an APPROVED matching order and reconciles a timeout by GET", async () => {
    const stateDir = await makeStateDir();
    let status = OrderStatus.Created;
    const api = {
      createOrder: vi.fn(async () => response(order(OrderStatus.Created), 201)),
      getOrder: vi.fn(async () => response(order(status))),
      captureOrder: vi.fn(async (request: unknown) => {
        expect(request).toMatchObject({ id: ORDER_ID, paypalRequestId: CAPTURE_ID });
        const journal = JSON.parse(await readFile(join(stateDir, "proof-state.json"), "utf8"));
        expect(journal.records[0].captureRequestId).toBe(CAPTURE_ID);
        expect(journal.records[0].captureState).toBe("pending");
        status = OrderStatus.Completed;
        throw new Error("network timeout after capture may have completed");
      }),
    };
    await executeProofCommand(createArgs(), {
      env: phoneOnlyEnv,
      stateDir,
      apiFactory: factory(api),
      log: () => {},
    });
    status = OrderStatus.Approved;

    const captureArgs = [
      "capture", "--reference", REFERENCE, "--request-id", CAPTURE_ID,
      "--confirm-human-approved",
    ];
    await expect(
      executeProofCommand(captureArgs, {
        env: phoneOnlyEnv,
        stateDir,
        apiFactory: factory(api),
        log: () => {},
      }),
    ).resolves.toBe(0);
    expect(api.captureOrder).toHaveBeenCalledTimes(1);
    expect(api.captureOrder.mock.calls[0][0]).toMatchObject({
      id: ORDER_ID,
      paypalRequestId: CAPTURE_ID,
    });

    await expect(
      executeProofCommand(["inspect", "--reference", REFERENCE], {
        env: phoneOnlyEnv,
        stateDir,
        apiFactory: factory(api),
        log: () => {},
      }),
    ).resolves.toBe(0);
    const journal = JSON.parse(await readFile(join(stateDir, "proof-state.json"), "utf8"));
    expect(journal.records[0].captureState).toBe("completed");
    expect(journal.records[0].captureHttpStatus).toBeUndefined();
    expect(journal.records[0].lastGetHttpStatus).toBe(200);
  });

  it.each([
    ["merchant", { payee: { merchantId: SECOND_MERCHANT_ID } }],
    ["amount", { amount: { currencyCode: "EUR", value: "0.99" } }],
    ["currency", { amount: { currencyCode: "USD", value: "1.00" } }],
    ["purchase-unit reference", { referenceId: "wrong-reference" }],
    ["custom reference", { customId: "wrong-custom-reference" }],
  ])("does not capture an APPROVED order with a mismatched %s", async (_label, unitChanges) => {
    const stateDir = await makeStateDir();
    const approved = order(OrderStatus.Approved);
    const expectedUnit = approved.purchaseUnits![0];
    const mismatch = {
      ...approved,
      purchaseUnits: [{ ...expectedUnit, ...unitChanges }],
    } as Order;
    const api = {
      createOrder: vi.fn(async () => response(order(OrderStatus.Created), 201)),
      getOrder: vi.fn(async () => response(mismatch)),
      captureOrder: vi.fn(),
    };
    await executeProofCommand(createArgs(), {
      env: phoneOnlyEnv,
      stateDir,
      apiFactory: factory(api),
      log: () => {},
    });
    await expect(
      executeProofCommand([
        "capture", "--reference", REFERENCE, "--request-id", CAPTURE_ID,
        "--confirm-human-approved",
      ], {
        env: phoneOnlyEnv,
        stateDir,
        apiFactory: factory(api),
        log: () => {},
      }),
    ).rejects.toThrow("did not match the saved amount, seller, and reference");
    expect(api.captureOrder).not.toHaveBeenCalled();
  });

  it.each([
    ["amount", { currencyCode: "EUR", value: "0.99" }, "COMPLETED"],
    ["capture status", { currencyCode: "EUR", value: "1.00" }, "PENDING"],
  ])("does not report a completed order as PASS with a mismatched %s", async (_label, amount, status) => {
    const stateDir = await makeStateDir();
    const completed = order(OrderStatus.Completed);
    const expectedUnit = completed.purchaseUnits![0];
    const invalid = {
      ...completed,
      purchaseUnits: [
        {
          ...expectedUnit,
          payments: {
            captures: [{ id: "CAPTURE-7XZ5A7F314", amount, status }],
          },
        },
      ],
    } as Order;
    const api = {
      createOrder: vi.fn(async () => response(order(OrderStatus.Created), 201)),
      getOrder: vi.fn(async () => response(invalid)),
      captureOrder: vi.fn(),
    };
    const logs: string[] = [];
    await executeProofCommand(createArgs(), {
      env: phoneOnlyEnv,
      stateDir,
      apiFactory: factory(api),
      log: () => {},
    });
    await expect(
      executeProofCommand(["inspect", "--reference", REFERENCE], {
        env: phoneOnlyEnv,
        stateDir,
        apiFactory: factory(api),
        log: (line) => logs.push(line),
      }),
    ).rejects.toThrow("PayPal capture did not match the saved amount and currency");
    expect(logs.join("\n")).not.toContain("PASS");
  });

  it("refuses capture before PayPal reports APPROVED and enforces the manual-confirmation gate", async () => {
    const stateDir = await makeStateDir();
    const api = {
      createOrder: vi.fn(async () => response(order(OrderStatus.Created), 201)),
      getOrder: vi.fn(async () => response(order(OrderStatus.PayerActionRequired))),
      captureOrder: vi.fn(),
    };
    await executeProofCommand(createArgs(), {
      env: phoneOnlyEnv,
      stateDir,
      apiFactory: factory(api),
      log: () => {},
    });
    const captureArgs = ["capture", "--reference", REFERENCE, "--request-id", CAPTURE_ID];
    await expect(
      executeProofCommand(captureArgs, {
        env: phoneOnlyEnv,
        stateDir,
        apiFactory: factory(api),
        log: () => {},
      }),
    ).rejects.toThrow("manual buyer approval");
    await expect(
      executeProofCommand([...captureArgs, "--confirm-human-approved"], {
        env: phoneOnlyEnv,
        stateDir,
        apiFactory: factory(api),
        log: () => {},
      }),
    ).rejects.toThrow("not APPROVED");
    expect(api.captureOrder).not.toHaveBeenCalled();
  });

  it("requires unique IDs per POST, distinct seller mappings, and only the selected shop config", async () => {
    const stateDir = await makeStateDir();
    const api = {
      createOrder: vi.fn(async () => response(order(OrderStatus.Created), 201)),
      getOrder: vi.fn(async () => response(order(OrderStatus.Approved))),
      captureOrder: vi.fn(),
    };
    await expect(
      executeProofCommand(createArgs(), {
        env: phoneOnlyEnv,
        stateDir,
        apiFactory: factory(api),
        log: () => {},
      }),
    ).resolves.toBe(0);

    await expect(
      executeProofCommand([
        "capture", "--reference", REFERENCE, "--request-id", CREATE_ID,
        "--confirm-human-approved",
      ], {
        env: phoneOnlyEnv,
        stateDir,
        apiFactory: factory(api),
        log: () => {},
      }),
    ).rejects.toThrow("already assigned");

    const duplicateEnv = {
      ...bothShopsEnv,
      PAYPAL_CLIENT_ID_DEMO_SECOND_SHOP: phoneOnlyEnv.PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP,
    };
    await expect(
      executeProofCommand(createArgs("proof-phone-002", "33333333-3333-4333-8333-333333333333"), {
        env: duplicateEnv,
        stateDir,
        apiFactory: factory(api),
        log: () => {},
      }),
    ).rejects.toThrow("Duplicate seller mapping");
    expect(api.createOrder).toHaveBeenCalledTimes(1);

    await expect(
      executeProofCommand(createArgs("proof-phone-003", "55555555-5555-4555-8555-555555555555"), {
        env: {
          ...bothShopsEnv,
          DEMO_SECOND_SHOP_PAYPAL_MERCHANT_ID: PHONE_MERCHANT_ID,
        },
        stateDir,
        apiFactory: factory(api),
        log: () => {},
      }),
    ).rejects.toThrow("Duplicate seller mapping");
    expect(api.createOrder).toHaveBeenCalledTimes(1);

    const secondShopArgs = [
      "create", "--shop", "DEMO_SECOND_SHOP", "--amount", "1.00", "--currency", "EUR",
      "--reference", "proof-second-001", "--request-id", "44444444-4444-4444-8444-444444444444",
    ];
    await expect(
      executeProofCommand(secondShopArgs, {
        env: phoneOnlyEnv,
        stateDir,
        apiFactory: factory(api),
        log: () => {},
      }),
    ).rejects.toThrow("Missing sandbox configuration for DEMO_SECOND_SHOP");
    expect(api.createOrder).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-sandbox or mismatched HATEOAS approval URL without printing it", async () => {
    const stateDir = await makeStateDir();
    const evil = "https://attacker.example/checkoutnow?token=secret-token";
    const api = {
      createOrder: vi.fn(async () =>
        response(order(OrderStatus.Created, {
          links: [{ rel: "approve", href: evil }],
        }), 201),
      ),
      getOrder: vi.fn(async () => response(order(OrderStatus.Created))),
      captureOrder: vi.fn(),
    };
    const logs: string[] = [];
    await expect(
      executeProofCommand(createArgs(), {
        env: phoneOnlyEnv,
        stateDir,
        apiFactory: factory(api),
        log: (line) => logs.push(line),
      }),
    ).rejects.toThrow("non-sandbox or invalid approval link");
    expect(logs.join("\n")).not.toContain("attacker.example");
    expect(logs.join("\n")).not.toContain("secret-token");
  });

  it("uses the pinned APIMatic SDK in Sandbox with idempotency, finite timeout, and redirects disabled", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const adapter = async (request: unknown) => {
      const config = request as Record<string, unknown>;
      requests.push(config);
      const url = String(config.url);
      const method = String(config.method).toUpperCase();
      const data = url.endsWith("/v1/oauth2/token")
        ? { access_token: "fictional-test-token", token_type: "Bearer", expires_in: 3600 }
        : {
            id: ORDER_ID,
            status: "PAYER_ACTION_REQUIRED",
            intent: "CAPTURE",
            purchase_units: [
              {
                reference_id: REFERENCE,
                custom_id: REFERENCE,
                amount: { currency_code: "EUR", value: "1.00" },
                payee: { merchant_id: PHONE_MERCHANT_ID },
              },
            ],
            links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}` }],
          };
      return {
        data: JSON.stringify(data),
        status: method === "POST" && url.endsWith("/v2/checkout/orders") ? 201 : 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        config: request,
      };
    };
    const api = createOrdersApi("fictional-client", "fictional-secret", adapter);
    const createBody: OrderRequest = {
      intent: CheckoutPaymentIntent.Capture,
      purchaseUnits: [
        {
          referenceId: REFERENCE,
          customId: REFERENCE,
          amount: { currencyCode: "EUR", value: "1.00" },
          payee: { merchantId: PHONE_MERCHANT_ID },
        },
      ],
      paymentSource: {
        paypal: {
          experienceContext: {
            returnUrl: "https://agentshelf-e5bk.onrender.com/?paypal-proof=return",
            cancelUrl: "https://agentshelf-e5bk.onrender.com/?paypal-proof=cancel",
          },
        },
      },
    };
    const result = await api.createOrder(
      { body: createBody, paypalRequestId: CREATE_ID, prefer: "return=representation" },
    );

    expect(result.statusCode).toBe(201);
    expect(result.result.status).toBe(OrderStatus.PayerActionRequired);
    expect(requests).toHaveLength(2);
    const tokenRequest = requests.find((request) => String(request.url).endsWith("/v1/oauth2/token"));
    const orderRequest = requests.find((request) => String(request.url).endsWith("/v2/checkout/orders"));
    expect(tokenRequest).toBeDefined();
    expect(tokenRequest).toMatchObject({ maxRedirects: 0, timeout: 12000 });
    expect(orderRequest).toMatchObject({ method: "post", maxRedirects: 0, timeout: 12000 });
    expect(requests.every((request) => new URL(String(request.url)).origin === "https://api-m.sandbox.paypal.com")).toBe(true);
    const headers = orderRequest?.headers as Record<string, string>;
    expect(Object.entries(headers).some(([key, value]) => key.toLowerCase() === "paypal-request-id" && value === CREATE_ID)).toBe(true);
    const body = JSON.parse(String(orderRequest?.data));
    expect(body.purchase_units[0].payee.merchant_id).toBe(PHONE_MERCHANT_ID);
    expect(body.payment_source.paypal.experience_context.return_url).toBeDefined();
    expect(body.application_context).toBeUndefined();
    expect(JSON.stringify(requests)).not.toContain("fictional-secret");
  });
});
