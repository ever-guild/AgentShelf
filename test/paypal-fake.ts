import { randomBytes } from "node:crypto";

// Stands in for PayPal's sandbox behind the SDK's transport adapter, so tests run the real SDK
// with no network. It copies the documented idempotency of PayPal-Request-Id and the difference
// between minimal and full responses. Passing against it is not evidence that PayPal behaves the
// same way, which only a run against the real sandbox can show.

type Json = Record<string, unknown>;

type AdapterConfig = {
  method: string;
  url: string;
  headers: Record<string, unknown>;
  data?: string;
  timeout?: number;
  maxRedirects?: number;
};

type OrderStep =
  | { type: "respond"; status: number; body: unknown }
  // The request either never arrives or arrives and its answer is lost.
  | { type: "timeout"; orderCreated: boolean }
  | { type: "change"; change: (order: Json) => Json | Promise<Json> };

type TokenStep =
  | { type: "respond"; status: number; body: unknown }
  | { type: "timeout" };

function headerOf(config: AdapterConfig, name: string): string | undefined {
  const entry = Object.entries(config.headers).find(
    ([key]) => key.toLowerCase() === name,
  );
  return entry ? String(entry[1]) : undefined;
}

function buildOrder(body: Json): Json {
  const id = `FAKE${randomBytes(6).toString("hex").toUpperCase()}`;
  return {
    id,
    intent: body.intent,
    status: "PAYER_ACTION_REQUIRED",
    payment_source: { paypal: {} },
    purchase_units: (body.purchase_units as Json[]).map((unit) => ({
      reference_id: unit.reference_id,
      custom_id: unit.custom_id,
      amount: unit.amount,
      payee: unit.payee,
      items: unit.items,
    })),
    links: [
      {
        href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${id}`,
        rel: "self",
        method: "GET",
      },
      {
        href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
        rel: "payer-action",
        method: "GET",
      },
    ],
  };
}

export function createFakePayPal() {
  const ordersByRequestId = new Map<string, Json>();
  const requests: AdapterConfig[] = [];
  const orderSteps: OrderStep[] = [];
  const tokenSteps: TokenStep[] = [];

  const reply = (config: AdapterConfig, status: number, body: unknown) => ({
    data: JSON.stringify(body),
    status,
    statusText: "",
    headers: { "content-type": "application/json" },
    config,
  });

  const timedOut = (config: AdapterConfig) =>
    Object.assign(new Error("timeout of 12000ms exceeded"), {
      code: "ECONNABORTED",
      config,
    });

  const answerToken = (config: AdapterConfig) => {
    const step = tokenSteps.shift();
    if (step?.type === "timeout") {
      throw timedOut(config);
    }
    if (step) {
      return reply(config, step.status, step.body);
    }
    return reply(config, 200, {
      access_token: "fake-access-token",
      token_type: "Bearer",
      expires_in: 32400,
    });
  };

  const answerCreate = async (config: AdapterConfig) => {
    const step = orderSteps.shift();
    if (step?.type === "respond") {
      return reply(config, step.status, step.body);
    }
    if (step?.type === "timeout" && !step.orderCreated) {
      throw timedOut(config);
    }

    const requestId = headerOf(config, "paypal-request-id");
    if (!requestId) {
      return reply(config, 400, { name: "PAYPAL_REQUEST_ID_REQUIRED" });
    }
    const existing = ordersByRequestId.get(requestId);
    const order = existing ?? buildOrder(JSON.parse(config.data ?? "{}"));
    ordersByRequestId.set(requestId, order);
    if (step?.type === "timeout") {
      throw timedOut(config);
    }

    const answer =
      step?.type === "change" ? await step.change(structuredClone(order)) : order;
    const representation = headerOf(config, "prefer") === "return=representation";
    return reply(
      config,
      existing ? 200 : 201,
      representation
        ? answer
        : { id: answer.id, status: answer.status, links: answer.links },
    );
  };

  return {
    adapter: async (request: unknown) => {
      const config = request as AdapterConfig;
      requests.push(config);
      const { pathname } = new URL(config.url);
      if (pathname === "/v1/oauth2/token") {
        return answerToken(config);
      }
      if (config.method.toLowerCase() === "post" && pathname === "/v2/checkout/orders") {
        return answerCreate(config);
      }
      throw new Error(`Unexpected PayPal request: ${config.method} ${pathname}`);
    },
    requests,
    tokenRequests: () =>
      requests.filter((request) => request.url.endsWith("/v1/oauth2/token")),
    createRequests: () =>
      requests.filter((request) => request.url.endsWith("/v2/checkout/orders")),
    bodyOf: (request: AdapterConfig) => JSON.parse(request.data ?? "{}"),
    requestIdOf: (request: AdapterConfig) => headerOf(request, "paypal-request-id"),
    createdOrders: () => [...ordersByRequestId.values()],
    nextOrder: (step: OrderStep) => orderSteps.push(step),
    nextToken: (step: TokenStep) => tokenSteps.push(step),
  };
}
