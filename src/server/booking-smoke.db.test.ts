import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runBookingSmoke } from "../../scripts/booking-smoke";
import { setupMigratedDatabase } from "../../test/database";
import { createFakePayPal } from "../../test/paypal-fake";
import { orders } from "./db/schema";
import { seedDemoData } from "./db/seed";
import { createMcpServer } from "./mcp/server";
import { createPayPalProvider } from "./paypal/orders";
import {
  defaultReconcileDeps,
  reconcileOrder,
} from "./services/payment-reconciliation";

const getDb = setupMigratedDatabase();

let client: Client;
let paypal: ReturnType<typeof createFakePayPal>;
let paypalFor: ReturnType<typeof createPayPalProvider>;
let lines: string[];
const log = (line: string) => lines.push(line);

beforeEach(async () => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  lines = [];
  paypal = createFakePayPal();
  paypalFor = createPayPalProvider(
    {
      PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP: "test-client-id",
      PAYPAL_CLIENT_SECRET_DEMO_PHONE_WORKSHOP: "test-client-secret",
    },
    paypal.adapter,
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(getDb(), { paypalFor }).connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
});

const seed = () =>
  seedDemoData(getDb(), { DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID: "SEEDEDMERCHANT1" });

describe("runBookingSmoke", () => {
  it("passes when the hold, its retry and the rival all behave", async () => {
    await seed();

    const code = await runBookingSmoke(client, log);

    expect(lines.filter((line) => line.startsWith("FAIL"))).toEqual([]);
    expect(lines.filter((line) => line.startsWith("PASS"))).toHaveLength(8);
    expect(code).toBe(0);
    expect(paypal.createRequests()).toHaveLength(1);
    expect(paypal.captureRequests()).toHaveLength(0);
  });

  it("is blocked, not passed, for a shop with no merchant", async () => {
    await seedDemoData(getDb(), {});
    expect(await runBookingSmoke(client, log)).toBe(2);
    expect(lines.at(-1)).toContain("PAYMENT_NOT_CONFIGURED");
  });

  it("is blocked, not passed, with no demo data", async () => {
    expect(await runBookingSmoke(client, log)).toBe(2);
  });

  it("with --wait, passes only once the booking is confirmed", async () => {
    await seed();

    const code = await runBookingSmoke(client, log, {
      attempts: 3,
      sleep: async () => {
        const [order] = await getDb()
          .select()
          .from(orders)
          .where(eq(orders.paymentStatus, "pending"));
        if (order?.paypalOrderId) {
          paypal.approve(order.paypalOrderId);
          await reconcileOrder(getDb(), order.id, {
            ...defaultReconcileDeps,
            paypalFor,
          });
        }
      },
    });

    expect(lines.filter((line) => line.startsWith("FAIL"))).toEqual([]);
    expect(lines.filter((line) => line.startsWith("PASS"))).toHaveLength(10);
    expect(code).toBe(0);
  });

  it("with --wait, fails when nobody pays", async () => {
    await seed();
    const code = await runBookingSmoke(client, log, {
      attempts: 1,
      sleep: async () => {},
    });
    expect(code).toBe(1);
    expect(lines.filter((line) => line.startsWith("FAIL"))).toHaveLength(2);
  });
});
