import "server-only";

import type { Pool } from "pg";

import { getDb } from "../db";
import type { Db } from "../db/client";

/** Reuse the application Drizzle pool for inventory reads and transactions. */
export function inventoryPool(): Pool {
  return (getDb() as Db & { $client: Pool }).$client;
}
