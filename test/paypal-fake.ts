import { createHash, randomBytes } from "node:crypto";

// Stands in for PayPal's sandbox behind the SDK's transport adapter, so tests run the real SDK
// with no network. It copies documented behaviour: the idempotency of PayPal-Request-Id, one
// capture per order, a full order only when asked for, and a signature over the exact bytes of a
// webhook. Passing against it is not evidence that PayPal behaves the same way, which only a run
// against the real sandbox can show.

type Json = Record<string, unknown>;
type PurchaseUnit = Json & { reference_id?: string; custom_id?: string; amount?: Json };

type AdapterConfig = {
  method: string;
  url: string;
  headers: Record<string, unknown>;
  data?: string;
  timeout?: number;
  maxRedirects?: number;
};

type Respond = { type: "respond"; status: number; body: unknown };
type Change = { type: "change"; change: (order: Json) => Json | Promise<Json> };

type OrderStep =
  | Respond
  // The request either never arrives or arrives and its answer is lost.
  | { type: "timeout"; orderCreated: boolean }
  | Change;

type TokenStep = Respond | { type: "timeout" };
type ReadStep = Respond | Change | { type: "timeout" };
type VerifyStep = Respond | { type: "timeout" };
type CaptureStep =
  | Respond
  | { type: "timeout"; captured: boolean }
  | { type: "capture_status"; status: "PENDING" | "DECLINED" | "FAILED" };

const CREATE_PATH = "/v2/checkout/orders";
const TOKEN_PATH = "/v1/oauth2/token";
const VERIFY_PATH = "/v1/notifications/verify-webhook-signature";
const WEBHOOK_EVENT_MARKER = ',"webhook_event":';

function headerOf(config: AdapterConfig, name: string): string | undefined {
  const entry = Object.entries(config.headers).find(
    ([key]) => key.toLowerCase() === name,
  );
  return entry ? String(entry[1]) : undefined;
}

function signatureOf(webhookId: string, rawEvent: string): string {
  return createHash("sha256").update(`${webhookId}|${rawEvent}`).digest("hex");
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

const unitOf = (order: Json) => (order.purchase_units as PurchaseUnit[])[0];
const capturesOf = (order: Json) =>
  ((unitOf(order).payments as { captures?: Json[] } | undefined)?.captures ?? []);

export function createFakePayPal() {
  const ordersByRequestId = new Map<string, Json>();
  const captureAnswers = new Map<string, Json>();
  const requests: AdapterConfig[] = [];
  const orderSteps: OrderStep[] = [];
  const tokenSteps: TokenStep[] = [];
  const readSteps: ReadStep[] = [];
  const captureSteps: CaptureStep[] = [];
  const verifySteps: VerifyStep[] = [];
  let charges = 0;

  const findOrder = (id: string) =>
    [...ordersByRequestId.values()].find((order) => order.id === id);

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

  const notFound = (config: AdapterConfig) =>
    reply(config, 404, {
      name: "RESOURCE_NOT_FOUND",
      details: [{ issue: "INVALID_RESOURCE_ID" }],
    });

  const refused = (config: AdapterConfig, issue: string) =>
    reply(config, 422, {
      name: "UNPROCESSABLE_ENTITY",
      debug_id: "fake-debug-id",
      details: [{ issue }],
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

  const answerRead = async (config: AdapterConfig, id: string) => {
    const step = readSteps.shift();
    if (step?.type === "respond") {
      return reply(config, step.status, step.body);
    }
    if (step?.type === "timeout") {
      throw timedOut(config);
    }
    const order = findOrder(id);
    if (!order) {
      return notFound(config);
    }
    return reply(
      config,
      200,
      step?.type === "change" ? await step.change(structuredClone(order)) : order,
    );
  };

  const answerCapture = (config: AdapterConfig, id: string) => {
    const step = captureSteps.shift();
    if (step?.type === "respond") {
      return reply(config, step.status, step.body);
    }
    if (step?.type === "timeout" && !step.captured) {
      throw timedOut(config);
    }

    const order = findOrder(id);
    if (!order) {
      return notFound(config);
    }
    const requestId = headerOf(config, "paypal-request-id") ?? "";
    const earlier = captureAnswers.get(requestId);
    if (earlier) {
      if (step?.type === "timeout") {
        throw timedOut(config);
      }
      return reply(config, 200, earlier);
    }
    if (order.status === "COMPLETED") {
      return refused(config, "ORDER_ALREADY_CAPTURED");
    }
    if (order.status !== "APPROVED") {
      return refused(config, "ORDER_NOT_APPROVED");
    }

    const unit = unitOf(order);
    const status = step?.type === "capture_status" ? step.status : "COMPLETED";
    const amount = unit.amount as { currency_code: string; value: string };
    unit.payments = {
      captures: [
        {
          id: `CAP${randomBytes(6).toString("hex").toUpperCase()}`,
          status,
          amount: { currency_code: amount.currency_code, value: amount.value },
          custom_id: unit.custom_id,
          final_capture: true,
        },
      ],
    };
    order.status = "COMPLETED";
    if (status === "COMPLETED" || status === "PENDING") {
      charges += 1;
    }

    // As in PayPal's own sample, a capture answer names no recipient or order total. Only reading
    // the order shows those.
    const answer = {
      id,
      status: "COMPLETED",
      purchase_units: [{ reference_id: unit.reference_id, payments: unit.payments }],
    };
    captureAnswers.set(requestId, answer);
    if (step?.type === "timeout") {
      throw timedOut(config);
    }
    return reply(config, 201, answer);
  };

  const answerVerify = (config: AdapterConfig) => {
    const step = verifySteps.shift();
    if (step?.type === "timeout") {
      throw timedOut(config);
    }
    if (step) {
      return reply(config, step.status, step.body);
    }
    if (headerOf(config, "content-type") !== "application/json") {
      return reply(config, 415, { name: "UNSUPPORTED_MEDIA_TYPE" });
    }
    const raw = config.data ?? "";
    const at = raw.indexOf(WEBHOOK_EVENT_MARKER);
    const fields = JSON.parse(`${raw.slice(0, at)}}`) as {
      webhook_id: string;
      transmission_sig: string;
    };
    const rawEvent = raw.slice(at + WEBHOOK_EVENT_MARKER.length, -1);
    return reply(config, 200, {
      verification_status:
        fields.transmission_sig === signatureOf(fields.webhook_id, rawEvent)
          ? "SUCCESS"
          : "FAILURE",
    });
  };

  const requestsTo = (matches: (config: AdapterConfig, path: string) => boolean) => () =>
    requests.filter((config) => matches(config, new URL(config.url).pathname));

  return {
    adapter: async (request: unknown) => {
      const config = request as AdapterConfig;
      requests.push(config);
      const { pathname } = new URL(config.url);
      const method = config.method.toLowerCase();
      if (pathname === TOKEN_PATH) {
        return answerToken(config);
      }
      if (method === "post" && pathname === CREATE_PATH) {
        return answerCreate(config);
      }
      if (method === "post" && pathname === VERIFY_PATH) {
        return answerVerify(config);
      }
      const capture = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(pathname);
      if (method === "post" && capture) {
        return answerCapture(config, capture[1]);
      }
      const read = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(pathname);
      if (method === "get" && read) {
        return answerRead(config, read[1]);
      }
      throw new Error(`Unexpected PayPal request: ${config.method} ${pathname}`);
    },

    requests,
    tokenRequests: requestsTo((_config, path) => path === TOKEN_PATH),
    createRequests: requestsTo((_config, path) => path === CREATE_PATH),
    verifyRequests: requestsTo((_config, path) => path === VERIFY_PATH),
    captureRequests: requestsTo((_config, path) => path.endsWith("/capture")),
    readRequests: requestsTo(
      (config, path) =>
        config.method.toLowerCase() === "get" && path.startsWith(`${CREATE_PATH}/`),
    ),
    bodyOf: (request: AdapterConfig) => JSON.parse(request.data ?? "{}"),
    requestIdOf: (request: AdapterConfig) => headerOf(request, "paypal-request-id"),
    createdOrders: () => [...ordersByRequestId.values()],
    // How much money has really moved, however many requests were made.
    charges: () => charges,
    captureIdOf: (id: string) => {
      const order = findOrder(id);
      return order ? (capturesOf(order)[0]?.id as string | undefined) : undefined;
    },

    nextOrder: (step: OrderStep) => orderSteps.push(step),
    nextToken: (step: TokenStep) => tokenSteps.push(step),
    nextRead: (step: ReadStep) => readSteps.push(step),
    nextCapture: (step: CaptureStep) => captureSteps.push(step),
    nextVerify: (step: VerifyStep) => verifySteps.push(step),

    // What a person does on PayPal's page.
    approve: (id: string) => {
      const order = findOrder(id);
      if (!order) {
        throw new Error(`No fake order ${id}`);
      }
      order.status = "APPROVED";
    },
    // What PayPal does later, on its own.
    setCaptureStatus: (id: string, status: string) => {
      const order = findOrder(id);
      const capture = order && capturesOf(order)[0];
      if (!capture) {
        throw new Error(`No capture on fake order ${id}`);
      }
      capture.status = status;
    },
    void: (id: string) => {
      const order = findOrder(id);
      if (order) {
        order.status = "VOIDED";
      }
    },

    // The headers of a genuine delivery of exactly these bytes to this subscription.
    signDelivery: (webhookId: string, rawBody: string) =>
      new Headers({
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
        "paypal-transmission-id": "fake-transmission-id",
        "paypal-transmission-sig": signatureOf(webhookId, rawBody),
        "paypal-transmission-time": "2026-11-06T10:00:00Z",
      }),
  };
}

export type FakePayPal = ReturnType<typeof createFakePayPal>;
