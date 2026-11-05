import { defineConfig } from "drizzle-kit";

// Used only to generate migrations, which needs no database connection.
// Migrations are applied by `npm run db:migrate`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
});
