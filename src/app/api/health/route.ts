import { connection } from "next/server";

// Process liveness, used by the Render health check. It deliberately touches no dependency,
// so a database outage does not make Render treat a working process as failed. The commit is
// public anyway, and lets anyone compare the deployed version with `main`.
export async function GET() {
  await connection();
  return Response.json(
    { status: "ok", commit: process.env.RENDER_GIT_COMMIT ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
