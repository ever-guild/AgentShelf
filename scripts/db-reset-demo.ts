import { createDb } from "../src/server/db/client";
import { DemoResetRefused, resetDemoData } from "../src/server/db/demo-reset";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const { db, close } = createDb(connectionString);
  try {
    const summary = await resetDemoData(db);
    console.log(
      `Demo data reset. Removed ${summary.removedProducts} extra product(s) and rewrote the demand fixtures.`,
    );
  } finally {
    await close();
  }
}

main().catch((error) => {
  if (error instanceof DemoResetRefused) {
    console.error(error.message);
  } else {
    console.error("Demo reset failed:", error instanceof Error ? error.name : "unknown");
  }
  process.exitCode = 1;
});
