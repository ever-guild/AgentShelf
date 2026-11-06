import { prepareDatabase } from "../src/server/db/migrate";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  await prepareDatabase(connectionString);
  console.log("Migrations applied.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
