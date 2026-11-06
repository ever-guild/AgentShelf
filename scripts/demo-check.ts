// Checks the seeded demo through a running MCP endpoint, the way a buyer's assistant meets it: both
// shops can be searched, an accessory costs under EUR 15, and the repair has free time tomorrow
// before noon. Usage: npm run smoke:demo -- https://HOST/mcp [--date YYYY-MM-DD]
//
// --date is the demo's "today" in Riga, and defaults to today. It is read-only: nothing is held,
// ordered or paid. Run it for two different dates to see the slots follow the date.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  formatLocalDate,
  resolveDemoDate,
  tomorrowBeforeNoon,
} from "../src/server/domain/demo-calendar";
import {
  DEMO_CABLE_ID,
  DEMO_CANDLE_ID,
  DEMO_PRODUCT_ID,
  DEMO_SECOND_SHOP_ID,
  DEMO_SERVICE_ID,
  DEMO_SHOP_ID,
} from "../src/server/db/seed";

const ACCESSORY_LIMIT_MINOR = 1500;

type Found = { productId: string; shopId: string; priceMinor: number };
type Slot = { startsAt: string; technicianName: string };

// Returns 0 when every check passes and 1 when one fails.
export async function runDemoCheck(
  client: Pick<Client, "callTool">,
  today: ReturnType<typeof resolveDemoDate>,
  log: (line: string) => void = console.log,
): Promise<number> {
  let exitCode = 0;
  const check = (name: string, passed: boolean, detail = "") => {
    log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
    if (!passed) {
      exitCode = 1;
    }
  };

  const search = async (query: string, extra: Record<string, unknown> = {}) => {
    const result = await client.callTool({
      name: "search_products",
      arguments: { query, ...extra },
    });
    return (
      (result.structuredContent as { products?: Found[] } | undefined)?.products ?? []
    );
  };

  const repair = await search("iPhone 13 screen repair");
  check(
    "the phone workshop is searchable",
    repair.some((p) => p.productId === DEMO_SERVICE_ID && p.shopId === DEMO_SHOP_ID),
  );
  const candles = await search("soy candle");
  check(
    "the candle studio is searchable through the same connector",
    candles.some((p) => p.productId === DEMO_CANDLE_ID && p.shopId === DEMO_SECOND_SHOP_ID),
  );
  check(
    "a search for one shop's goods does not return the other's",
    !candles.some((p) => p.shopId === DEMO_SHOP_ID) &&
      !repair.some((p) => p.shopId === DEMO_SECOND_SHOP_ID),
  );

  const glass = await search("iPhone 13 screen protector", {
    maxPriceMinor: ACCESSORY_LIMIT_MINOR,
    kind: "product",
  });
  check(
    "a compatible protective glass costs under EUR 15",
    glass.some((p) => p.productId === DEMO_PRODUCT_ID && p.priceMinor < ACCESSORY_LIMIT_MINOR),
  );
  const cable = await search("USB-C Lightning cable", {
    maxPriceMinor: ACCESSORY_LIMIT_MINOR,
    kind: "product",
  });
  check(
    "a cable costs under EUR 15",
    cable.some((p) => p.productId === DEMO_CABLE_ID && p.priceMinor < ACCESSORY_LIMIT_MINOR),
  );

  const range = tomorrowBeforeNoon(today);
  const slotsResult = await client.callTool({
    name: "get_slots",
    arguments: {
      shopId: DEMO_SHOP_ID,
      serviceId: DEMO_SERVICE_ID,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    },
  });
  const slots =
    (slotsResult.structuredContent as { slots?: Slot[] } | undefined)?.slots ?? [];
  check(
    `the screen repair has free time before noon on the day after ${formatLocalDate(today)}`,
    slots.length > 0 &&
      slots.every((slot) => {
        const start = Date.parse(slot.startsAt);
        return start >= range.from.getTime() && start < range.to.getTime();
      }),
    `${slots.length} slot(s), first ${slots[0]?.startsAt ?? "none"}`,
  );
  return exitCode;
}

async function main() {
  const args = process.argv.slice(2);
  const dateAt = args.indexOf("--date");
  const dateArg = dateAt >= 0 ? args[dateAt + 1] : undefined;
  const url = new URL(args.find((arg) => arg.startsWith("http")) ?? "http://localhost:3000/mcp");
  const today = resolveDemoDate({ DEMO_DATE: dateArg });
  console.log(`Endpoint: ${url.href}, demo date ${formatLocalDate(today)}`);

  const client = new Client({ name: "agentshelf-demo-check", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  try {
    process.exitCode = await runDemoCheck(client, today);
  } finally {
    await client.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("FAIL ", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
