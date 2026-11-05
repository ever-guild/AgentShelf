import { describe, expect, it, vi } from "vitest";

import {
  PAYPAL_SANDBOX_TOKEN_URL,
  runPreflight,
} from "../../scripts/paypal-preflight.mjs";

const configuration: Record<string, string> = {
  APP_ORIGIN: "https://agentshelf-e5bk.onrender.com",
  PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP: "phone-client-id",
  PAYPAL_CLIENT_SECRET_DEMO_PHONE_WORKSHOP: "phone-client-secret",
  DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID: "phone-merchant-id",
  PAYPAL_CLIENT_ID_DEMO_SECOND_SHOP: "second-client-id",
  PAYPAL_CLIENT_SECRET_DEMO_SECOND_SHOP: "second-client-secret",
  DEMO_SECOND_SHOP_PAYPAL_MERCHANT_ID: "second-merchant-id",
};

function tokenResponse(status = 200, body: unknown = { access_token: "test-token" }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("PayPal sandbox preflight", () => {
  it("blocks missing configuration before any network call and prints names only", async () => {
    const fetchImpl = vi.fn();
    const log = vi.fn();
    const env = { ...configuration, PAYPAL_CLIENT_SECRET_DEMO_SECOND_SHOP: "" };

    await expect(runPreflight({ env, online: true, fetchImpl, log })).resolves.toBe(2);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).toContain(
      "PAYPAL_CLIENT_SECRET_DEMO_SECOND_SHOP",
    );
    expect(log.mock.calls.flat().join(" ")).not.toContain("second-client-secret");
  });

  it("passes the full configuration offline without calling PayPal", async () => {
    const fetchImpl = vi.fn();
    const log = vi.fn();

    await expect(
      runPreflight({ env: configuration, fetchImpl, log }),
    ).resolves.toBe(0);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).toContain("OFFLINE configuration-only");
  });

  it("blocks duplicate Client IDs and merchant IDs before any network call", async () => {
    const cases = [
      {
        duplicate: {
          PAYPAL_CLIENT_ID_DEMO_SECOND_SHOP:
            configuration.PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP,
        },
        expectedNames: [
          "PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP",
          "PAYPAL_CLIENT_ID_DEMO_SECOND_SHOP",
        ],
      },
      {
        duplicate: {
          DEMO_SECOND_SHOP_PAYPAL_MERCHANT_ID:
            configuration.DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID,
        },
        expectedNames: [
          "DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID",
          "DEMO_SECOND_SHOP_PAYPAL_MERCHANT_ID",
        ],
      },
    ];

    for (const { duplicate, expectedNames } of cases) {
      const fetchImpl = vi.fn();
      const log = vi.fn();
      await expect(
        runPreflight({
          env: { ...configuration, ...duplicate },
          online: true,
          fetchImpl,
          log,
        }),
      ).resolves.toBe(2);

      expect(fetchImpl).not.toHaveBeenCalled();
      const output = log.mock.calls.flat().join(" ");
      for (const name of expectedNames) expect(output).toContain(name);
      expect(output).not.toContain("phone-client-id");
      expect(output).not.toContain("phone-merchant-id");
    }
  });

  it("checks each seller app only against the fixed sandbox OAuth URL", async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(
        tokenResponse(200, { access_token: "test-token", token_type: "Bearer" }),
      ),
    );
    const log = vi.fn();

    await expect(
      runPreflight({ env: configuration, online: true, fetchImpl, log }),
    ).resolves.toBe(0);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchImpl.mock.calls) {
      expect(url).toBe(PAYPAL_SANDBOX_TOKEN_URL);
      expect(new URL(url).origin).toBe("https://api-m.sandbox.paypal.com");
      expect(options).toMatchObject({
        method: "POST",
        redirect: "error",
        body: "grant_type=client_credentials",
      });
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    const authorizationHeaders = fetchImpl.mock.calls.map(
      ([, options]) => (options.headers as Record<string, string>).authorization,
    );
    expect(authorizationHeaders).toEqual([
      `Basic ${Buffer.from("phone-client-id:phone-client-secret").toString("base64")}`,
      `Basic ${Buffer.from("second-client-id:second-client-secret").toString("base64")}`,
    ]);
    expect(log.mock.calls.flat().join(" ")).not.toContain("test-token");
    expect(log.mock.calls.flat().join(" ")).not.toContain("phone-client-secret");
    expect(log.mock.calls.flat().join(" ")).not.toContain("second-client-secret");
  });

  it("rejects redirects without following them", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://api-m.paypal.com/v1/oauth2/token" },
      }),
    );
    const log = vi.fn();

    await expect(
      runPreflight({ env: configuration, online: true, fetchImpl, log }),
    ).resolves.toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(PAYPAL_SANDBOX_TOKEN_URL);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe("error");
  });

  it("sanitizes an OAuth authorization failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("body contains second-client-secret", { status: 401 }));
    const log = vi.fn();

    await expect(
      runPreflight({ env: configuration, online: true, fetchImpl, log }),
    ).resolves.toBe(1);

    const output = log.mock.calls.flat().join(" ");
    expect(output).toContain("HTTP 401");
    expect(output).not.toContain("second-client-secret");
    expect(output).not.toContain("body contains");
  });

  it("rejects malformed OAuth token responses without printing their body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      tokenResponse(200, {
        access_token: "  ",
        token_type: "Basic",
        diagnostic: "contains phone-client-secret",
      }),
    );
    const log = vi.fn();

    await expect(
      runPreflight({ env: configuration, online: true, fetchImpl, log }),
    ).resolves.toBe(1);

    const output = log.mock.calls.flat().join(" ");
    expect(output).toContain("token response invalid");
    expect(output).not.toContain("phone-client-secret");
    expect(output).not.toContain("diagnostic");
  });

  it("sanitizes network errors and uses a bounded timeout signal", async () => {
    const fetchImpl = vi.fn((_url: string, options: RequestInit) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return new Promise<Response>((_, reject) => {
        options.signal?.addEventListener("abort", () => {
          reject(new Error("network failed for second-client-secret"));
        });
      });
    });
    const log = vi.fn();

    await expect(
      runPreflight({
        env: configuration,
        online: true,
        fetchImpl,
        log,
        timeoutMs: 1,
      }),
    ).resolves.toBe(1);

    const output = log.mock.calls.flat().join(" ");
    expect(output).toContain("network error or timeout");
    expect(output).not.toContain("second-client-secret");
  });
});
