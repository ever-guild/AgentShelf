import "server-only";

import type { Pool } from "pg";

import { getDb } from "../db";
import type { Db } from "../db/client";
import { PostgresAttemptLimiter, PostgresIdentityStore } from "./postgres-store";

type OwnerIdentityRuntime = {
  store: PostgresIdentityStore;
  limiter: PostgresAttemptLimiter;
};

const runtimeGlobal = globalThis as typeof globalThis & {
  agentshelfOwnerIdentityRuntime?: OwnerIdentityRuntime;
};

/** Reuse the application pool so identity shares its lifetime and bounded connections. */
export function ownerIdentityRuntime(): OwnerIdentityRuntime {
  if (runtimeGlobal.agentshelfOwnerIdentityRuntime) {
    return runtimeGlobal.agentshelfOwnerIdentityRuntime;
  }
  const secret = process.env.APP_SIGNING_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("APP_SIGNING_SECRET is not configured");
  }
  const db = getDb() as Db & { $client: Pool };
  const runtime = {
    store: new PostgresIdentityStore(db.$client),
    limiter: new PostgresAttemptLimiter(db.$client, secret),
  };
  runtimeGlobal.agentshelfOwnerIdentityRuntime = runtime;
  return runtime;
}
