import { publicOrigin } from "../public-origin";

// The MCP specification requires rejecting a request whose Origin header is present and
// invalid, which stops a web page from reaching the server through a visitor's browser.
// Claude and ChatGPT call from their own servers, and such requests usually send no Origin.
// MCP_ALLOWED_ORIGINS adds origins without a code change, which matters once the repository
// is frozen after the submission deadline.
const CLIENT_ORIGINS = ["https://claude.ai", "https://chatgpt.com"];

export function isAllowedMcpOrigin(
  origin: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const configured = (env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (CLIENT_ORIGINS.includes(origin) || configured.includes(origin)) {
    return true;
  }
  try {
    return origin === publicOrigin(env);
  } catch {
    return false;
  }
}
