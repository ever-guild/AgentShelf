import path from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDb } from "./client";
import { seedDemoDataIfEmpty } from "./seed";

export async function runMigrations(connectionString: string): Promise<void> {
  const { db, close } = createDb(connectionString);
  try {
    await migrate(db, {
      migrationsFolder: path.join(process.cwd(), "drizzle"),
    });
  } finally {
    await close();
  }
}

// What the start command runs. A failed migration stops the start, so Render keeps serving the
// previous version. On Render an empty database then gets the demo data, because opening its shell
// takes the account owner, while anyone who can push to main can deploy. A failed seed is only
// logged: the service works without it, and the next start tries again. RENDER is set by Render.
export async function prepareDatabase(
  connectionString: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  await runMigrations(connectionString);
  if (env.RENDER !== "true") {
    return;
  }
  const { db, close } = createDb(connectionString);
  try {
    if (await seedDemoDataIfEmpty(db, env)) {
      console.log("Demo data seeded on an empty database.");
    }
  } catch (error) {
    console.error("Demo seed failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  } finally {
    await close();
  }
}
