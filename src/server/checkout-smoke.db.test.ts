import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCheckoutSmoke, type PayPalView } from "../../scripts/checkout-smoke";
import { setupMigratedDatabase } from "../../test/database";
import { createFakePayPal } from "../../test/paypal-fake";
import { seedDemoData } from "./db/seed";
import { createMcpServer } from "./mcp/server";
import { createPayPalOrdersProvider } from "./paypal/orders";

const getDb = setupMigratedDatabase();
const MERCHANT_ID = "SEEDEDMERCHANT1";

let client: Client;
let paypal: ReturnType<typeof createFakePayPal>;
let lines: string[];
const log = (line: string) => lines.push(line);

const paypalHolds = (changes: Partial<PayPalView> = {}) => async () => ({
  status: "PAYER_ACTION_REQUIRED",
  merchantId: MERCHANT_ID,
  amount: "9.90",
  currency: "EUR",
  ...changes,
});

beforeEach(async () => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  lines = [];
  paypal = createFakePayPal();
  await seedDemoData(getDb(), {
    DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID: MERCHANT_ID,
  });
  const paypalOrdersFor = createPayPalOrdersProvider(
    {
      PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP: "test-client-id",
      PAYPAL_CLIENT_SECRET_DEMO_PHONE_WORKSHOP: "test-client-secret",
    },
    paypal.adapter,
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(getDb(), { paypalOrdersFor }).connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
});

describe("runCheckoutSmoke", () => {
  it("passes when the order, its retry and PayPal's copy all agree", async () => {
    const code = await runCheckoutSmoke(
      client,
      { expectedMerchantId: MERCHANT_ID, read: paypalHolds() },
      log,
    );

    expect(lines.filter((line) => line.startsWith("FAIL"))).toEqual([]);
    expect(lines.filter((line) => line.startsWith("PASS"))).toHaveLength(7);
    expect(code).toBe(0);
    expect(paypal.createRequests()).toHaveLength(1);
  });

  it.each([
    ["another recipient", { merchantId: "ATTACKERMERCHANT" }],
    ["another amount", { amount: "0.01" }],
    ["an order that is already approved", { status: "APPROVED" }],
  ])("fails when PayPal holds %s", async (_name, changes) => {
    const code = await runCheckoutSmoke(
      client,
      { expectedMerchantId: MERCHANT_ID, read: paypalHolds(changes) },
      log,
    );

    expect(code).toBe(1);
    expect(lines.filter((line) => line.startsWith("FAIL"))).toHaveLength(1);
  });

  it("does not pass without reading the recipient back from PayPal", async () => {
    const code = await runCheckoutSmoke(client, {}, log);

    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("BLOCKED  recipient not read back");
  });

  it("reports BLOCKED when no order could be created", async () => {
    await client.close();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(getDb(), {
      paypalOrdersFor: () => undefined,
    }).connect(serverSide);
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);

    const code = await runCheckoutSmoke(client, {}, log);

    expect(code).toBe(2);
    expect(lines).toEqual([
      "BLOCKED  create_checkout returned PAYMENT_NOT_CONFIGURED: no order to check",
    ]);
  });
});
