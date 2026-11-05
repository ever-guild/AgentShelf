import { connection } from "next/server";

// Process liveness, used by the Render health check. It deliberately touches no dependency,
// so a database outage does not make Render treat a working process as failed.
export async function GET() {
  await connection();
  return Response.json(
    { status: "ok" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
