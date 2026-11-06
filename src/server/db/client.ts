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
  // The server can end an idle connection at any time, as a restart does. The pool drops it and
  // connects again on the next query, and without a listener this event is an uncaught exception.
  pool.on("error", (error: Error & { code?: string }) => {
    console.error("Database connection lost", { code: error.code ?? error.name });
  });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}
