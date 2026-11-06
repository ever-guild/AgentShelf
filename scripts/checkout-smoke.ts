// Creates one real PayPal sandbox order through a running MCP endpoint, then checks the order the
// way a buyer's assistant would meet it. Usage: npm run smoke:checkout -- https://HOST/mcp
//
// Unlike smoke:mcp, this leaves an unpaid sandbox order behind. Nothing is charged: the order
// waits for a person to approve it in PayPal, and this script never asks for a capture.
//
// The recipient is read back from PayPal with the seller's own credentials from .env.local. Without
// them that check is BLOCKED rather than passed. The output holds a private approval link, so do
// not share it unredacted.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { DEMO_PRODUCT_ID } from "../src/server/db/seed";
import { createOrdersApi } from "./paypal-proof";

const SANDBOX_CHECKOUT_ORIGIN = "https://www.sandbox.paypal.com";
const SEEDED_TOTAL_MINOR = 990;
const SEEDED_TOTAL_DECIMAL = "9.90";
const AWAITING_BUYER = new Set(["CREATED", "PAYER_ACTION_REQUIRED"]);

export type PayPalView = {
  status?: string;
  merchantId?: string;
  amount?: string;
  currency?: string;
};

type Inspect = {
  expectedMerchantId?: string;
  read?: (paypalOrderId: string) => Promise<PayPalView>;
};

type CheckoutResult = {
  orderId: string;
  totalMinor: number;
  currency: string;
  approvalUrl: string;
  statusToken: string;
};

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { text?: string }[])[0]?.text ?? "";

// Returns 0 when every check passes, 1 on a failed check and 2 when one could not run.
export async function runCheckoutSmoke(
  client: Pick<Client, "callTool">,
  inspect: Inspect,
  log: (line: string) => void = console.log,
): Promise<number> {
  let exitCode = 0;
  const check = (name: string, passed: boolean) => {
    log(`${passed ? "PASS" : "FAIL"}  ${name}`);
    if (!passed) {
      exitCode = 1;
    }
  };

  const idempotencyKey = randomUUID();
  const items = [{ productId: DEMO_PRODUCT_ID, quantity: 1 }];
  const createCheckout = (args: Record<string, unknown>) =>
    client.callTool({ name: "create_checkout", arguments: args });

  const first = await createCheckout({ items, idempotencyKey });
  if (first.isError) {
    const { code } = JSON.parse(textOf(first)) as { code?: string };
    log(`BLOCKED  create_checkout returned ${code ?? "an error"}: no order to check`);
    return 2;
  }
  const order = first.structuredContent as CheckoutResult;

  const link = new URL(order.approvalUrl);
  const paypalOrderId = link.searchParams.get("token") ?? "";
  check(
    "create_checkout returns a PayPal sandbox approval link",
    link.origin === SANDBOX_CHECKOUT_ORIGIN && paypalOrderId !== "",
  );
  check(
    "the amount comes from the stored product",
    order.totalMinor === SEEDED_TOTAL_MINOR && order.currency === "EUR",
  );

  const repeat = await createCheckout({ items, idempotencyKey });
  check(
    "repeating the key returns the same local and PayPal order",
    JSON.stringify(repeat.structuredContent) === JSON.stringify(order),
  );

  const conflict = await createCheckout({
    items: [{ productId: DEMO_PRODUCT_ID, quantity: 2 }],
    idempotencyKey,
  });
  check(
    "the same key with a different cart is refused",
    conflict.isError === true && textOf(conflict).includes("IDEMPOTENCY_CONFLICT"),
  );

  if (inspect.read && inspect.expectedMerchantId) {
    const view = await inspect.read(paypalOrderId);
    check(
      "PayPal holds the order for the expected recipient",
      view.merchantId === inspect.expectedMerchantId,
    );
    check(
      "PayPal holds the stored amount",
      view.amount === SEEDED_TOTAL_DECIMAL && view.currency === "EUR",
    );
    check(
      "the order is waiting for the buyer, not paid",
      AWAITING_BUYER.has(view.status ?? ""),
    );
  } else {
    log("BLOCKED  recipient not read back: seller credentials are not set locally");
    exitCode = exitCode || 2;
  }

  log(`Approval link, private: ${order.approvalUrl}`);
  log("Open it signed in as the sandbox buyer and approve in PayPal.");
  return exitCode;
}

async function main(): Promise<void> {
  const env = process.env;
  const url = new URL(process.argv[2] ?? "http://localhost:3000/mcp");
  const clientId = env.PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET_DEMO_PHONE_WORKSHOP?.trim();
  console.log(`Endpoint: ${url.href}`);

  const client = new Client({ name: "agentshelf-checkout-smoke", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  try {
    process.exitCode = await runCheckoutSmoke(client, {
      expectedMerchantId: env.DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID?.trim(),
      read:
        clientId && clientSecret
          ? async (id) => {
              const orders = createOrdersApi(clientId, clientSecret);
              const { result } = await orders.getOrder({ id });
              const unit = result.purchaseUnits?.[0];
              return {
                status: result.status,
                merchantId: unit?.payee?.merchantId,
                amount: unit?.amount?.value,
                currency: unit?.amount?.currencyCode,
              };
            }
          : undefined,
    });
  } finally {
    await client.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    // A raw SDK error holds the request, including its authorization header.
    const code = (error as { statusCode?: number; code?: string }) ?? {};
    console.error(`FAIL  the check stopped: ${code.statusCode ?? code.code ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
