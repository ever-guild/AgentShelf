// Holds one real slot through a running MCP endpoint and creates its PayPal sandbox deposit order,
// then checks the booking the way a buyer's assistant would meet it.
// Usage: npm run smoke:booking -- https://HOST/mcp [--wait]
//
// Nothing is charged: the order waits for a person to approve it in PayPal, and an unpaid hold runs
// out by itself. With --wait it waits up to ten minutes for that person, and passes only once the
// service reports the deposit as paid and the booking as confirmed. The output holds a private
// approval link, so do not share it unredacted.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { DEMO_SERVICE_ID, DEMO_SHOP_ID } from "../src/server/db/seed";

const SANDBOX_CHECKOUT_ORIGIN = "https://www.sandbox.paypal.com";
const SEEDED_DEPOSIT_MINOR = 2000;
const SEEDED_REMAINING_MINOR = 6000;
const DAY_MS = 24 * 60 * 60 * 1000;

type WaitForPayment = { attempts: number; sleep: () => Promise<void> };

type Slot = { slotId: string };
type Booked = {
  bookingId: string;
  orderId: string;
  expiresAt: string;
  approvalUrl: string;
  depositMinor: number;
  remainingMinor: number;
  statusToken: string;
};
type Status = {
  paymentStatus?: string;
  booking?: { bookingId?: string; status?: string; remainingMinor?: number } | null;
};

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { text?: string }[])[0]?.text ?? "";

// Returns 0 when every check passes, 1 on a failed check and 2 when one could not run.
export async function runBookingSmoke(
  client: Pick<Client, "callTool">,
  log: (line: string) => void = console.log,
  waitForPayment?: WaitForPayment,
): Promise<number> {
  let exitCode = 0;
  const check = (name: string, passed: boolean) => {
    log(`${passed ? "PASS" : "FAIL"}  ${name}`);
    if (!passed) {
      exitCode = 1;
    }
  };

  const listSlots = async (): Promise<Slot[]> => {
    const result = await client.callTool({
      name: "get_slots",
      arguments: {
        shopId: DEMO_SHOP_ID,
        serviceId: DEMO_SERVICE_ID,
        from: new Date(Date.now() + DAY_MS).toISOString(),
        to: new Date(Date.now() + 8 * DAY_MS).toISOString(),
      },
    });
    return (result.structuredContent as { slots?: Slot[] } | undefined)?.slots ?? [];
  };
  const bookSlot = (slotId: string, idempotencyKey: string) =>
    client.callTool({
      name: "book_slot",
      arguments: { slotId, serviceId: DEMO_SERVICE_ID, idempotencyKey },
    });

  const slots = await listSlots();
  if (slots.length < 2) {
    log("BLOCKED  get_slots offered no time: is the demo data seeded?");
    return 2;
  }
  check("get_slots offers free time for the seeded repair", true);
  const [slot, otherSlot] = slots;

  const idempotencyKey = randomUUID();
  const first = await bookSlot(slot.slotId, idempotencyKey);
  if (first.isError) {
    const { code } = JSON.parse(textOf(first)) as { code?: string };
    log(`BLOCKED  book_slot returned ${code ?? "an error"}: no booking to check`);
    return 2;
  }
  const booked = first.structuredContent as Booked;

  check(
    "book_slot returns a PayPal sandbox approval link",
    new URL(booked.approvalUrl).origin === SANDBOX_CHECKOUT_ORIGIN,
  );
  check(
    "the deposit and the remaining balance come from the stored service",
    booked.depositMinor === SEEDED_DEPOSIT_MINOR &&
      booked.remainingMinor === SEEDED_REMAINING_MINOR,
  );

  const repeat = await bookSlot(slot.slotId, idempotencyKey);
  check(
    "repeating the key returns the same booking and link",
    JSON.stringify(repeat.structuredContent) === JSON.stringify(booked),
  );

  const conflict = await bookSlot(otherSlot.slotId, idempotencyKey);
  check(
    "the same key for a different slot is refused",
    conflict.isError === true && textOf(conflict).includes("IDEMPOTENCY_CONFLICT"),
  );

  const rival = await bookSlot(slot.slotId, randomUUID());
  check(
    "another buyer cannot take the held slot",
    rival.isError === true && textOf(rival).includes("SLOT_UNAVAILABLE"),
  );

  const stillListed = (await listSlots()).some(({ slotId }) => slotId === slot.slotId);
  check("the held slot is no longer offered", !stillListed);

  const statusOf = async () => {
    const result = await client.callTool({
      name: "get_order_status",
      arguments: { orderId: booked.orderId, statusToken: booked.statusToken },
    });
    return (result.structuredContent ?? {}) as Status;
  };
  const before = await statusOf();
  check(
    "the booking is held and not paid before approval",
    before.paymentStatus === "pending" &&
      before.booking?.bookingId === booked.bookingId &&
      before.booking?.status === "held",
  );

  log(`Booking ${booked.bookingId}, order ${booked.orderId}, hold ends ${booked.expiresAt}`);
  log(`Approval link, private: ${booked.approvalUrl}`);
  log("Open it signed in as the sandbox buyer and approve in PayPal before the hold ends.");
  if (!waitForPayment) {
    return exitCode;
  }

  let status = before;
  for (
    let attempt = 0;
    attempt < waitForPayment.attempts &&
    (status.paymentStatus === "pending" || status.paymentStatus === "approved");
    attempt += 1
  ) {
    await waitForPayment.sleep();
    status = await statusOf();
  }
  check(
    `the deposit becomes paid (last status: ${status.paymentStatus})`,
    status.paymentStatus === "paid",
  );
  check(
    `the booking becomes confirmed (last status: ${status.booking?.status})`,
    status.booking?.status === "confirmed",
  );
  return exitCode;
}

async function main(): Promise<void> {
  const url = new URL(process.argv[2] ?? "http://localhost:3000/mcp");
  console.log(`Endpoint: ${url.href}`);

  const client = new Client({ name: "agentshelf-booking-smoke", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  try {
    process.exitCode = await runBookingSmoke(
      client,
      console.log,
      process.argv.includes("--wait")
        ? {
            attempts: 120,
            sleep: () => new Promise((done) => setTimeout(done, 5000)),
          }
        : undefined,
    );
  } finally {
    await client.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const code = (error as { code?: string }) ?? {};
    console.error(`FAIL  the check stopped: ${code.code ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
