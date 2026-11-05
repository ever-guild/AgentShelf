import { sql } from "drizzle-orm";
import { connection } from "next/server";

import { getDb } from "@/server/db";

// Deployment readiness: the database is reachable and migrated. The reason for a failure goes
// to the server log only, so this public endpoint never reveals any configuration.
export async function GET() {
  await connection();
  const headers = { "Cache-Control": "no-store" };
  try {
    await getDb().execute(sql`SELECT 1 FROM shops LIMIT 1`);
    return Response.json({ status: "ready" }, { headers });
  } catch (error) {
    console.error("Readiness check failed", error);
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
}
