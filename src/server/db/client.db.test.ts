import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTemporaryDatabase } from "../../../test/database";
import { createDb } from "./client";

describe("a database connection", () => {
  let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;

  beforeEach(async () => {
    temporary = await createTemporaryDatabase();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await temporary.drop();
  });

  it("survives the server ending an idle one, and works on a new one", async () => {
    const service = createDb(temporary.url);
    const other = createDb(temporary.url);
    try {
      const first = await service.db.execute(sql`SELECT pg_backend_pid() AS pid`);
      const pid = Number(first.rows[0].pid);

      await other.db.execute(sql`SELECT pg_terminate_backend(${pid})`);
      await vi.waitFor(() =>
        expect(console.error).toHaveBeenCalledWith("Database connection lost", {
          code: "57P01",
        }),
      );

      const second = await service.db.execute(sql`SELECT pg_backend_pid() AS pid`);
      expect(Number(second.rows[0].pid)).not.toBe(pid);
    } finally {
      await service.close();
      await other.close();
    }
  });
});
