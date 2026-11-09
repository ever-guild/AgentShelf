import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Lets `npm test` pick up TEST_DATABASE_URL from .env.local, as `next dev` does for the app.
if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Next.js handles this guard in its builds. Outside them it has nothing to guard against.
      "server-only": fileURLToPath(
        new URL("./test/server-only-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "scripts/*.test.mjs"],
    env: { APP_SIGNING_SECRET: randomBytes(32).toString("hex") },
  },
});
