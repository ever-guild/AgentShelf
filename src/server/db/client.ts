import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(connectionString: string): {
  db: Db;
  close: () => Promise<void>;
} {
  // Without a timeout, a request waits indefinitely when the database cannot be reached.
  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5000,
  });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}
