import { describe, expect, it } from "vitest";

import { publicOrigin } from "./public-origin";

describe("publicOrigin", () => {
  it("uses the URL Render provides", () => {
    expect(
      publicOrigin({ RENDER_EXTERNAL_URL: "https://agentshelf.onrender.com" }),
    ).toBe("https://agentshelf.onrender.com");
  });

  it("prefers an explicit origin", () => {
    expect(
      publicOrigin({
        APP_ORIGIN: "http://localhost:3000",
        RENDER_EXTERNAL_URL: "https://agentshelf.onrender.com",
      }),
    ).toBe("http://localhost:3000");
  });

  it("drops any path, so callers can append their own", () => {
    expect(publicOrigin({ APP_ORIGIN: "https://example.com/some/path/" })).toBe(
      "https://example.com",
    );
  });

  it.each([{}, { APP_ORIGIN: "" }, { APP_ORIGIN: "not a url" }])(
    "refuses to guess from %j",
    (env) => {
      expect(() => publicOrigin(env)).toThrow(
        expect.objectContaining({ code: "SERVER_MISCONFIGURED" }),
      );
    },
  );
});
