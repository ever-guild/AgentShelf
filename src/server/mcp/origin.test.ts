import { describe, expect, it } from "vitest";

import { isAllowedMcpOrigin } from "./origin";

describe("isAllowedMcpOrigin", () => {
  it.each(["https://claude.ai", "https://chatgpt.com"])(
    "allows the client origin %s",
    (origin) => {
      expect(isAllowedMcpOrigin(origin, {})).toBe(true);
    },
  );

  it("allows this deployment's own origin", () => {
    const env = { RENDER_EXTERNAL_URL: "https://agentshelf.onrender.com" };
    expect(isAllowedMcpOrigin("https://agentshelf.onrender.com", env)).toBe(true);
  });

  it("allows origins configured without a code change", () => {
    const env = {
      MCP_ALLOWED_ORIGINS: "http://localhost:6274, https://example.test",
    };
    expect(isAllowedMcpOrigin("http://localhost:6274", env)).toBe(true);
    expect(isAllowedMcpOrigin("https://example.test", env)).toBe(true);
  });

  it.each([
    "https://evil.example",
    "https://claude.ai.evil.example",
    "http://claude.ai",
    "null",
    "",
  ])("rejects %j", (origin) => {
    expect(
      isAllowedMcpOrigin(origin, {
        RENDER_EXTERNAL_URL: "https://agentshelf.onrender.com",
      }),
    ).toBe(false);
  });

  it("does not fail when no public origin is configured", () => {
    expect(isAllowedMcpOrigin("https://evil.example", {})).toBe(false);
  });
});
