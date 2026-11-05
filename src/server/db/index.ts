import "server-only";

import { createDb, type Db } from "./client";

// Kept on globalThis so hot reload in development does not open a new pool per edit.
const store = globalThis as typeof globalThis & { agentshelfDb?: Db };

export function getDb(): Db {
  if (!store.agentshelfDb) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    store.agentshelfDb = createDb(connectionString).db;
  }
  return store.agentshelfDb;
}
