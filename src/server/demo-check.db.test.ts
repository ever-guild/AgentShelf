import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDemoCheck } from "../../scripts/demo-check";
import { setupMigratedDatabase } from "../../test/database";
import { seedDemoData } from "./db/seed";
import { parseLocalDate } from "./domain/demo-calendar";
import { createMcpServer } from "./mcp/server";

const getDb = setupMigratedDatabase();

let client: Client;
let lines: string[];

beforeEach(async () => {
  lines = [];
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(getDb()).connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
});

describe("runDemoCheck", () => {
  it("passes on a clean seed, for two different dates", async () => {
    await seedDemoData(getDb(), {});
    // Dates ahead of the real clock, because a slot closer than an hour is never offered.
    for (const date of ["2027-06-04", "2027-06-05"]) {
      lines = [];
      const code = await runDemoCheck(client, parseLocalDate(date), (line) => lines.push(line));
      expect(lines.filter((line) => line.startsWith("FAIL"))).toEqual([]);
      expect(lines.filter((line) => line.startsWith("PASS"))).toHaveLength(6);
      expect(code).toBe(0);
    }
  });

  it("fails on an empty database", async () => {
    expect(await runDemoCheck(client, parseLocalDate("2027-06-04"), (line) => lines.push(line))).toBe(1);
    // Finding nothing in either shop cannot show one shop's goods leaking into the other.
    expect(lines.filter((line) => line.startsWith("FAIL"))).toHaveLength(5);
  });
});
