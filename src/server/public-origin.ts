import { ServiceError } from "./errors";

// The public origin of this deployment, for PayPal return URLs and the MCP endpoint. Render
// sets RENDER_EXTERNAL_URL itself. APP_ORIGIN wins, for local use or a custom domain.
export function publicOrigin(
  env: Record<string, string | undefined> = process.env,
): string {
  try {
    return new URL(env.APP_ORIGIN || env.RENDER_EXTERNAL_URL || "").origin;
  } catch {
    throw new ServiceError(
      "SERVER_MISCONFIGURED",
      "The server is not configured correctly.",
    );
  }
}
