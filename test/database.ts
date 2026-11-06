import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";

import { createDb, type Db } from "../src/server/db/client";
import { runMigrations } from "../src/server/db/migrate";

async function asAdmin(statement: string): Promise<void> {
  const client = new Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

// Each call creates its own uniquely named database on the TEST_DATABASE_URL server and never
// touches the database named in that URL. There is deliberately no in-memory fallback: these
// tests exist to exercise real Postgres constraints.
export async function createTemporaryDatabase(): Promise<{
  url: string;
  drop: () => Promise<void>;
}> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Point it at a Postgres server, or run `npm run test:unit` for the tests that need no database.",
    );
  }
  const name = `agentshelf_test_${randomBytes(6).toString("hex")}`;
  await asAdmin(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.href,
    drop: () => asAdmin(`DROP DATABASE ${name} WITH (FORCE)`),
  };
}

// A migrated database shared by one test file, emptied before each test.
export function setupMigratedDatabase(): () => Db {
  let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>> | undefined;
  let connection: ReturnType<typeof createDb> | undefined;

  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    await runMigrations(temporary.url);
    connection = createDb(temporary.url);
  });

  beforeEach(async () => {
    await connection?.db.execute(
      sql`TRUNCATE shops, products, technicians, technician_windows, orders, order_lines, bookings, webhook_receipts, import_jobs, import_sources, import_rows, product_search_terms, search_events, demand_insights, seller_ai_calls, inventory_reservation_lines, inventory_reservations, inventory_stock, inventory_adjustments, inventory_audit, paypal_merchant_connection_webhook_events, paypal_merchant_connections, seller_paypal_login_states, seller_owner_paypal_identities, seller_identity_attempt_windows, seller_identity_operations, seller_agent_grants, owner_sessions, shop_memberships, seller_owners`,
    );
  });

  afterAll(async () => {
    await connection?.close();
    await temporary?.drop();
  });

  return () => {
    if (!connection) {
      throw new Error("The test database is not ready");
    }
    return connection.db;
  };
}
