import { createDb } from "../src/server/db/client";
import { seedDemoData } from "../src/server/db/seed";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const { db, close } = createDb(connectionString);
  try {
    await seedDemoData(db);
    console.log("Demo data seeded.");
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
