import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import {
  inspectPlatformConfiguration,
  parseCliArgs,
  runPlatformPreflight,
  SANDBOX_ORIGIN,
  TOKEN_URL,
} from "../../scripts/paypal-platform-preflight.mjs";

const env = {
  NODE_ENV: "test" as const,
  PAYPAL_PLATFORM_CLIENT_ID: "platform-client-id",
  PAYPAL_PLATFORM_CLIENT_SECRET: "platform-client-secret",
  PAYPAL_PLATFORM_MERCHANT_ID: "platform-merchant-id",
  PAYPAL_PARTNER_ATTRIBUTION_ID: "platform-bn-code",
};
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

async function withLocalHttpServer(
  handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void,
  run: (origin: string, server: Server) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  try {
    await run(`http://127.0.0.1:${address.port}`, server);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

describe("PayPal platform preflight", () => {
  it("parses the documented online seller arguments without treating the ID as an option", () => {
    expect(parseCliArgs(["--online", "--seller-id", "sandbox-seller-123"])).toEqual({
      online: true,
      sellerId: "sandbox-seller-123",
    });
  });

  it("rejects duplicate, missing, and unknown CLI arguments", () => {
    expect(parseCliArgs(["--online", "--online"])).toBeUndefined();
    expect(parseCliArgs(["--online", "--seller-id"])).toBeUndefined();
    expect(parseCliArgs(["--online", "--seller-id", "--unknown"])).toBeUndefined();
    expect(parseCliArgs(["--mystery"])).toBeUndefined();
  });

  it("accepts the seller CLI form and blocks on missing configuration before any online request", () => {
    const result = spawnSync(process.execPath, [
      resolve(process.cwd(), "scripts/paypal-platform-preflight.mjs"),
      "--online", "--seller-id", "sandbox-seller-123",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PAYPAL_PLATFORM_CLIENT_ID: "",
        PAYPAL_PLATFORM_CLIENT_SECRET: "",
        PAYPAL_PLATFORM_MERCHANT_ID: "",
        PAYPAL_PARTNER_ATTRIBUTION_ID: "",
      },
      timeout: 5_000,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("BLOCKED missing platform configuration");
    expect(result.stdout).not.toContain("Usage:");
    expect(result.stderr).not.toContain("Usage:");
  });

  it("checks names only and makes no network request offline", async () => {
    expect(inspectPlatformConfiguration({ ...env, PAYPAL_PLATFORM_CLIENT_SECRET: " " })).toContain("PAYPAL_PLATFORM_CLIENT_SECRET");
    const fetchImpl = vi.fn();
    const log = vi.fn();
    await expect(runPlatformPreflight({ env: { ...env }, fetchImpl, log })).resolves.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).not.toContain(env.PAYPAL_PLATFORM_CLIENT_SECRET);
  });

  it("performs only sandbox OAuth when explicitly online without seller status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ access_token: "hidden-token", token_type: "Bearer" }));
    const log = vi.fn();
    await expect(runPlatformPreflight({ env, online: true, fetchImpl, log })).resolves.toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(TOKEN_URL);
    expect(new URL(TOKEN_URL).origin).toBe(SANDBOX_ORIGIN);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error", body: "grant_type=client_credentials" });
    expect(log.mock.calls.flat().join(" ")).not.toContain("hidden-token");
    expect(log.mock.calls.flat().join(" ")).not.toContain(env.PAYPAL_PLATFORM_CLIENT_SECRET);
  });

  it("uses only the documented fixed sandbox status GET with platform attribution", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok({ access_token: "hidden-token", token_type: "Bearer" }))
      .mockResolvedValueOnce(ok({
        merchant_id: "seller-id-123",
        payments_receivable: true,
        primary_email_confirmed: true,
        products: [{ name: "EXPRESS_CHECKOUT", status: "ACTIVE" }],
        oauth_integrations: [{
          integration_type: "OAUTH_THIRD_PARTY",
          integration_method: "PAYPAL",
          oauth_third_party: [{ scopes: ["https://uri.paypal.com/services/payments/payment/authcapture"] }],
        }],
      }));
    const log = vi.fn();
    await expect(runPlatformPreflight({ env, online: true, sellerId: "seller-id-123", fetchImpl, log })).resolves.toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, request] = fetchImpl.mock.calls[1];
    expect(url).toBe(`${SANDBOX_ORIGIN}/v1/customer/partners/platform-merchant-id/merchant-integrations/seller-id-123`);
    expect(request).toMatchObject({ method: "GET", redirect: "error" });
    const headers = request.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer hidden-token");
    expect(headers["PayPal-Partner-Attribution-Id"]).toBe(env.PAYPAL_PARTNER_ATTRIBUTION_ID);
    expect(headers["PayPal-Auth-Assertion"]).toBeUndefined();
    expect(log.mock.calls.flat().join(" ")).not.toContain("hidden-token");
  });

  it("blocks an incomplete seller even when the status API returns HTTP 200", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok({ access_token: "hidden-token", token_type: "Bearer" }))
      .mockResolvedValueOnce(ok({ payments_receivable: false, primary_email_confirmed: false }));
    const log = vi.fn();
    await expect(runPlatformPreflight({ env, online: true, sellerId: "seller-id-123", fetchImpl, log })).resolves.toBe(1);
    expect(log.mock.calls.flat().join(" ")).toContain("BLOCKED seller integration status");
  });

  it("blocks a mismatched merchant and never logs a large response body", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok({ access_token: "hidden-token", token_type: "Bearer" }))
      .mockResolvedValueOnce(ok({
        merchant_id: "another-seller-id",
        payments_receivable: true,
        primary_email_confirmed: true,
        products: [{ name: "EXPRESS_CHECKOUT", status: "ACTIVE" }],
        oauth_integrations: [{ oauth_third_party: [{ scopes: ["https://uri.paypal.com/services/payments/payment/authcapture"] }] }],
        private_note: "should not be output",
      }));
    const log = vi.fn();
    await expect(runPlatformPreflight({ env, online: true, sellerId: "seller-id-123", fetchImpl, log })).resolves.toBe(1);
    const output = log.mock.calls.flat().join(" ");
    expect(output).toContain("merchant matches false");
    expect(output).not.toContain("another-seller-id");
    expect(output).not.toContain("should not be output");

    const oversized = vi.fn().mockResolvedValueOnce(ok({ access_token: "hidden-token", token_type: "Bearer" })).mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "hidden-token", token_type: "Bearer" }) + " ".repeat(129 * 1024), { status: 200 }),
    );
    await expect(runPlatformPreflight({ env, online: true, sellerId: "seller-id-123", fetchImpl: oversized, log })).resolves.toBe(1);
    expect(log.mock.calls.flat().join(" ")).not.toContain("hidden-token");
  });

  it("rejects malformed seller IDs before requests and sanitizes failures", async () => {
    const fetchImpl = vi.fn();
    const log = vi.fn();
    await expect(runPlatformPreflight({ env, online: true, sellerId: "https://evil.example", fetchImpl, log })).resolves.toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();

    fetchImpl.mockResolvedValueOnce(new Response("contains platform-client-secret", { status: 401 }));
    await expect(runPlatformPreflight({ env, online: true, fetchImpl, log })).resolves.toBe(1);
    const output = log.mock.calls.flat().join(" ");
    expect(output).toContain("OAuth HTTP 401");
    expect(output).not.toContain("contains platform-client-secret");
    expect(output).not.toContain(env.PAYPAL_PLATFORM_CLIENT_SECRET);
  });

  it("uses native fetch redirect rejection for sandbox OAuth and does not follow the redirect", async () => {
    const paths: string[] = [];
    await withLocalHttpServer((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(302, { location: "/redirect-target" }).end("redirect body hidden-token");
    }, async (localOrigin) => {
      const log = vi.fn();
      const fetchImpl = (url: string, init: RequestInit) => {
        expect(url).toBe(TOKEN_URL);
        return fetch(`${localOrigin}/oauth`, init);
      };

      await expect(runPlatformPreflight({ env, online: true, fetchImpl, log, timeoutMs: 1_000 })).resolves.toBe(1);
      expect(paths).toEqual(["/oauth"]);
      const output = log.mock.calls.flat().join(" ");
      expect(output).toContain("network error, timeout, redirect, or invalid response");
      expect(output).not.toContain("redirect body");
      expect(output).not.toContain("hidden-token");
      expect(output).not.toContain(env.PAYPAL_PLATFORM_CLIENT_SECRET);
    });
  });

  it("uses native fetch redirect rejection for seller status and does not follow the redirect", async () => {
    const paths: string[] = [];
    await withLocalHttpServer((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(302, { location: "/credential-target" }).end("redirect body hidden-token");
    }, async (localOrigin) => {
      const log = vi.fn();
      const fetchImpl = (url: string, init: RequestInit) => {
        if (url === TOKEN_URL) return Promise.resolve(ok({ access_token: "hidden-token", token_type: "Bearer" }));
        expect(url).toBe(`${SANDBOX_ORIGIN}/v1/customer/partners/platform-merchant-id/merchant-integrations/seller-id-123`);
        return fetch(`${localOrigin}/status`, init);
      };

      await expect(runPlatformPreflight({ env, online: true, sellerId: "seller-id-123", fetchImpl, log, timeoutMs: 1_000 })).resolves.toBe(1);
      expect(paths).toEqual(["/status"]);
      const output = log.mock.calls.flat().join(" ");
      expect(output).toContain("network error, timeout, redirect, or invalid response");
      expect(output).not.toContain("redirect body");
      expect(output).not.toContain("hidden-token");
      expect(output).not.toContain(env.PAYPAL_PLATFORM_CLIENT_SECRET);
    });
  });

  it.each(["sandbox OAuth", "seller status"] as const)("aborts a stalled native fetch during %s and redacts the failure", async (phase) => {
    let requestCount = 0;
    const signals: AbortSignal[] = [];
    await withLocalHttpServer(() => {
      requestCount += 1;
    }, async (localOrigin) => {
      const log = vi.fn();
      const fetchImpl = (url: string, init: RequestInit) => {
        if (init.signal) signals.push(init.signal as AbortSignal);
        if (phase === "seller status" && url === TOKEN_URL) {
          return Promise.resolve(ok({ access_token: "timeout-hidden-token", token_type: "Bearer" }));
        }
        return fetch(`${localOrigin}/${phase === "sandbox OAuth" ? "oauth" : "status"}`, init);
      };

      await expect(runPlatformPreflight({
        env,
        online: true,
        ...(phase === "seller status" ? { sellerId: "seller-id-123" } : {}),
        fetchImpl,
        log,
        timeoutMs: 20,
      })).resolves.toBe(1);
      expect(requestCount).toBe(1);
      expect(signals).toHaveLength(phase === "sandbox OAuth" ? 1 : 2);
      expect(signals.at(-1)?.aborted).toBe(true);
      const output = log.mock.calls.flat().join(" ");
      expect(output).toContain("network error, timeout, redirect, or invalid response");
      expect(output).not.toContain("timeout-hidden-token");
      expect(output).not.toContain(env.PAYPAL_PLATFORM_CLIENT_SECRET);
    });
  });
});
