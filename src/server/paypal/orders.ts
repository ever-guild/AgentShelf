import "server-only";

import {
  CaptureStatus,
  CheckoutPaymentIntent,
  Client,
  Environment,
  OrderStatus,
  OrdersController,
  PaypalExperienceUserAction,
  type Order,
  type OrderRequest,
} from "@paypal/paypal-server-sdk";

import { minorToDecimal } from "../domain/money";
import {
  createCatalogRecord,
  readCatalogRecord,
  type CatalogRecord,
} from "./catalog";

// Everything the payment services need to know about PayPal. The environment is fixed to sandbox
// here, and no setting can change it.

// Applies to each request, including the token exchange. The SDK's own default is no limit.
const REQUEST_TIMEOUT_MS = 12_000;
const TOKEN_CLOCK_SKEW_SECONDS = 60;
const MAX_ITEM_NAME_LENGTH = 127;
const SANDBOX_CHECKOUT_ORIGIN = "https://www.sandbox.paypal.com";
const TOKEN_PATH = "/v1/oauth2/token";
const VERIFY_WEBHOOK_PATH = "/v1/notifications/verify-webhook-signature";
const TIMEOUT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT"]);
// The server-side credential resolver may select this only for a shop with a
// current, consented PayPal connection. Never accept it from a browser or MCP arg.
export const PLATFORM_PAYPAL_CREDENTIAL_REF = "PAYPAL_PLATFORM";
const PAYPAL_PARTNER_ATTRIBUTION_ID = "PAYPAL_PARTNER_ATTRIBUTION_ID";

export type WebhookSignature = {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
};

// What one seller's REST app can do. `webhookId` is the subscription registered on that app, and
// it is undefined until then.
export type PayPalSellerApi = Pick<
  OrdersController,
  "createOrder" | "getOrder" | "captureOrder"
> & {
  // The public half of this seller's app. The JS SDK needs it in the browser to approve an order
  // this app created. The secret never leaves this file.
  clientId: string;
  webhookId?: string;
  verifyWebhookSignature: (
    webhookId: string,
    signature: WebhookSignature,
    rawBody: string,
  ) => Promise<boolean>;
  createCatalogRecord: (
    record: CatalogRecord,
    requestId: string,
  ) => Promise<{ id?: string }>;
  readCatalogRecord: (id: string) => Promise<{ id?: string }>;
};

// Resolves a shop's server-owned credential reference. Direct seller refs retain their own REST
// apps; the reserved platform ref requires an already-verified seller ID from the persisted order.
export type PayPalPlatformWebhookVerifier = (
  webhookId: string,
  signature: WebhookSignature,
  rawBody: string,
) => Promise<boolean>;

export type PayPalProvider = ((
  credentialRef: string,
  payeeMerchantId?: string,
) => PayPalSellerApi | undefined) & {
  verifyPlatformWebhookSignature?: PayPalPlatformWebhookVerifier;
};

type SellerClient = { client: Client; orders: OrdersController };

function createSellerClient(
  oAuthClientId: string,
  oAuthClientSecret: string,
  testAdapter: unknown,
  partnerAttributionId?: string,
): SellerClient {
  const client = new Client({
    environment: Environment.Sandbox,
    clientCredentialsAuthCredentials: {
      oAuthClientId,
      oAuthClientSecret,
      oAuthClockSkew: TOKEN_CLOCK_SKEW_SECONDS,
    },
    httpClientOptions: {
      timeout: REQUEST_TIMEOUT_MS,
      // A retry belongs to the caller, who repeats the same idempotency key.
      retryConfig: {
        maxNumberOfRetries: 0,
        retryOnTimeout: false,
        maximumRetryWaitTime: 0,
      },
    },
    unstable_httpClientOptions: {
      maxRedirects: 0,
      ...(testAdapter ? { adapter: testAdapter } : {}),
    },
  });
  if (partnerAttributionId) {
    const getFactory = client.getRequestBuilderFactory.bind(client);
    client.getRequestBuilderFactory = () => {
      const factory = getFactory();
      return ((method, path) => {
        const builder = factory(method, path);
        const isPartnerApiPath = (value: string | undefined) =>
          Boolean(
            value &&
              (/(?:^|\/)v2\/checkout\/orders(?:\/|$)/.test(value) ||
                /(?:^|\/)v1\/catalogs\/products(?:\/|$)/.test(value)),
          );
        if (isPartnerApiPath(path)) {
          builder.header("PayPal-Partner-Attribution-Id", partnerAttributionId);
        }
        const appendTemplatePath = builder.appendTemplatePath.bind(builder);
        builder.appendTemplatePath = ((strings, ...values) => {
          appendTemplatePath(strings, ...values);
          if (isPartnerApiPath(strings.join(""))) {
            builder.header("PayPal-Partner-Attribution-Id", partnerAttributionId);
          }
        }) as typeof builder.appendTemplatePath;
        return builder;
      }) as ReturnType<typeof client.getRequestBuilderFactory>;
    };
  }
  return { client, orders: new OrdersController(client) };
}

function buildPayPalAuthAssertion(platformClientId: string, sellerMerchantId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
  return `${encode({ alg: "none" })}.${encode({ iss: platformClientId, payer_id: sellerMerchantId })}.`;
}

// The SDK has no webhook API, so this goes through its request builder, which brings the same
// token, timeout and transport as every other call.
async function verifySignature(
  client: Client,
  webhookId: string,
  signature: WebhookSignature,
  rawBody: string,
): Promise<boolean> {
  const request = client.getRequestBuilderFactory()("POST", VERIFY_WEBHOOK_PATH);
  request.header("Content-Type", "application/json");
  const fields = JSON.stringify({
    auth_algo: signature.authAlgo,
    cert_url: signature.certUrl,
    transmission_id: signature.transmissionId,
    transmission_sig: signature.transmissionSig,
    transmission_time: signature.transmissionTime,
    webhook_id: webhookId,
  });
  // PayPal signed the exact bytes it sent, and serializing them again can fail verification, so
  // the event is spliced in as received. The caller has already checked that it is valid JSON.
  request.text(`${fields.slice(0, -1)},"webhook_event":${rawBody}}`);
  request.authenticate([{ oauth2: true }]);
  const { result } = await request.callAsText();
  return asRecord(JSON.parse(result)).verification_status === "SUCCESS";
}

export function createPayPalProvider(
  env: Record<string, string | undefined> = process.env,
  testAdapter?: unknown,
): PayPalProvider {
  // One client per seller app, so its cached token is reused between calls.
  const sellers = new Map<string, SellerClient>();
  const callWithClient = async <T>(
    credentialRef: string,
    partnerAttributionId: string | undefined,
    call: (orders: OrdersController, client: Client) => Promise<T>,
  ): Promise<T> => {
    const platform = credentialRef === PLATFORM_PAYPAL_CREDENTIAL_REF;
    const clientId = (platform ? env.PAYPAL_PLATFORM_CLIENT_ID : env[`PAYPAL_CLIENT_ID_${credentialRef}`])?.trim();
    const clientSecret = (platform ? env.PAYPAL_PLATFORM_CLIENT_SECRET : env[`PAYPAL_CLIENT_SECRET_${credentialRef}`])?.trim();
    if (!clientId || !clientSecret) {
      throw new Error("PayPal credentials are not configured");
    }
    const seller = sellers.get(credentialRef) ?? createSellerClient(clientId, clientSecret, testAdapter, partnerAttributionId);
    sellers.set(credentialRef, seller);
    try {
      return await call(seller.orders, seller.client);
    } catch (error) {
      // The SDK keeps a failed token exchange as a rejected promise and rethrows it on every
      // later call without sending a request, so one network failure would otherwise stop
      // this seller's payments until a restart. The next call starts with a new client.
      sellers.delete(credentialRef);
      throw error;
    }
  };

  const provider = (credentialRef: string, payeeMerchantId?: string): PayPalSellerApi | undefined => {
    if (credentialRef === PLATFORM_PAYPAL_CREDENTIAL_REF) {
      const clientId = env.PAYPAL_PLATFORM_CLIENT_ID?.trim();
      const clientSecret = env.PAYPAL_PLATFORM_CLIENT_SECRET?.trim();
      const attributionId = env[PAYPAL_PARTNER_ATTRIBUTION_ID]?.trim();
      if (
        !clientId || !clientSecret || !attributionId ||
        !payeeMerchantId || !/^[A-Za-z0-9_-]{3,128}$/.test(payeeMerchantId)
      ) {
        return undefined;
      }
      const assertion = buildPayPalAuthAssertion(clientId, payeeMerchantId);
      return {
        clientId,
        webhookId: env.PAYPAL_PLATFORM_WEBHOOK_ID?.trim() || undefined,
        createOrder: (request, options) => {
          const units = request.body.purchaseUnits;
          if (!units.length || units.some((unit) => unit.payee?.merchantId !== payeeMerchantId)) {
            return Promise.reject(new Error("The PayPal order payee does not match the connected seller"));
          }
          return callWithClient(PLATFORM_PAYPAL_CREDENTIAL_REF, attributionId, (orders) =>
            orders.createOrder(
              { ...request, paypalAuthAssertion: assertion, paypalPartnerAttributionId: attributionId },
              options,
            ),
          );
        },
        getOrder: (request, options) =>
          callWithClient(PLATFORM_PAYPAL_CREDENTIAL_REF, attributionId, (orders) =>
            orders.getOrder({ ...request, paypalAuthAssertion: assertion }, options),
          ),
        captureOrder: (request, options) =>
          callWithClient(PLATFORM_PAYPAL_CREDENTIAL_REF, attributionId, (orders) =>
            orders.captureOrder({ ...request, paypalAuthAssertion: assertion }, options),
          ),
        verifyWebhookSignature: (webhookId, signature, rawBody) =>
          callWithClient(PLATFORM_PAYPAL_CREDENTIAL_REF, attributionId, (_orders, client) =>
            verifySignature(client, webhookId, signature, rawBody),
          ),
        createCatalogRecord: (record, requestId) =>
          callWithClient(PLATFORM_PAYPAL_CREDENTIAL_REF, attributionId, (_orders, client) =>
            createCatalogRecord(client, record, requestId, assertion),
          ),
        readCatalogRecord: (id) =>
          callWithClient(PLATFORM_PAYPAL_CREDENTIAL_REF, attributionId, (_orders, client) =>
            readCatalogRecord(client, id, assertion),
          ),
      };
    }
    const clientId = env[`PAYPAL_CLIENT_ID_${credentialRef}`]?.trim();
    const clientSecret = env[`PAYPAL_CLIENT_SECRET_${credentialRef}`]?.trim();
    if (!clientId || !clientSecret) {
      return undefined;
    }

    return {
      clientId,
      webhookId: env[`PAYPAL_WEBHOOK_ID_${credentialRef}`]?.trim() || undefined,
      createOrder: (request, options) =>
        callWithClient(credentialRef, undefined, (orders) => orders.createOrder(request, options)),
      getOrder: (request, options) =>
        callWithClient(credentialRef, undefined, (orders) => orders.getOrder(request, options)),
      captureOrder: (request, options) =>
        callWithClient(credentialRef, undefined, (orders) => orders.captureOrder(request, options)),
      verifyWebhookSignature: (webhookId, signature, rawBody) =>
        callWithClient(credentialRef, undefined, (_orders, client) =>
          verifySignature(client, webhookId, signature, rawBody)),
      createCatalogRecord: (record, requestId) =>
        callWithClient(credentialRef, undefined, (_orders, client) => createCatalogRecord(client, record, requestId)),
      readCatalogRecord: (id) =>
        callWithClient(credentialRef, undefined, (_orders, client) => readCatalogRecord(client, id)),
    };
  };
  return Object.assign(provider, {
    verifyPlatformWebhookSignature: (
      webhookId: string,
      signature: WebhookSignature,
      rawBody: string,
    ) =>
      callWithClient(
        PLATFORM_PAYPAL_CREDENTIAL_REF,
        env[PAYPAL_PARTNER_ATTRIBUTION_ID]?.trim(),
        (_orders, client) => verifySignature(client, webhookId, signature, rawBody),
      ),
  });
}

export const paypalFor = createPayPalProvider();

export type OrderSnapshot = {
  id: string;
  currency: string;
  totalMinor: number;
  payeeMerchantId: string;
};

export type OrderLineSnapshot = {
  title: string;
  unitPriceMinor: number;
  quantity: number;
};

// Built only from the stored order, so a retry repeats exactly what was first requested.
export function buildOrderRequest(
  order: OrderSnapshot,
  lines: readonly OrderLineSnapshot[],
  buyerPages: { returnUrl: string; cancelUrl: string },
): OrderRequest {
  const money = (minor: number) => ({
    currencyCode: order.currency,
    value: minorToDecimal(minor, order.currency),
  });

  return {
    intent: CheckoutPaymentIntent.Capture,
    purchaseUnits: [
      {
        referenceId: order.id,
        // Carried on the capture and its webhooks, for reconciliation.
        customId: order.id,
        amount: {
          ...money(order.totalMinor),
          breakdown: { itemTotal: money(order.totalMinor) },
        },
        payee: { merchantId: order.payeeMerchantId },
        items: lines.map((line) => ({
          name: Array.from(line.title).slice(0, MAX_ITEM_NAME_LENGTH).join(""),
          unitAmount: money(line.unitPriceMinor),
          quantity: String(line.quantity),
        })),
      },
    ],
    paymentSource: {
      paypal: {
        experienceContext: {
          ...buyerPages,
          userAction: PaypalExperienceUserAction.PayNow,
        },
      },
    },
  };
}

// Names the first way a PayPal response differs from the order that was requested.
export function findOrderMismatch(
  seen: Order,
  expected: OrderSnapshot,
): string | undefined {
  const [unit, ...otherUnits] = seen.purchaseUnits ?? [];
  if (!seen.id) return "order id";
  if (seen.intent !== CheckoutPaymentIntent.Capture) return "intent";
  if (!unit || otherUnits.length > 0) return "purchase units";
  if (unit.referenceId !== expected.id) return "reference";
  if (unit.payee?.merchantId !== expected.payeeMerchantId) return "recipient";
  if (unit.amount?.currencyCode !== expected.currency) return "currency";
  if (
    unit.amount?.value !== minorToDecimal(expected.totalMinor, expected.currency)
  ) {
    return "amount";
  }
  return undefined;
}

// The buyer's link, only if the order is waiting for them and the link is PayPal's own sandbox
// checkout for this very order.
export function sandboxApprovalUrl(created: Order): string | undefined {
  if (
    created.status !== OrderStatus.Created &&
    created.status !== OrderStatus.PayerActionRequired
  ) {
    return undefined;
  }
  const href = created.links?.find(
    (link) => link.rel === "payer-action" || link.rel === "approve",
  )?.href;
  if (!href || !URL.canParse(href)) {
    return undefined;
  }
  const url = new URL(href);
  return url.origin === SANDBOX_CHECKOUT_ORIGIN &&
    !url.username &&
    !url.password &&
    url.searchParams.get("token") === created.id
    ? url.href
    : undefined;
}

export type PayPalOrderReading =
  | { outcome: "awaiting_buyer" }
  | { outcome: "ready_to_capture" }
  | { outcome: "capture_pending"; captureId: string }
  | { outcome: "paid"; captureId: string; capturedAt: Date }
  | { outcome: "capture_refused"; captureId?: string }
  | { outcome: "voided" }
  | { outcome: "needs_review"; reason: string; captureId?: string };

// What a full order from PayPal means for the stored one. An approved order is not a paid one,
// and neither is a completed order: only a completed capture of the stored amount is.
export function readPayPalOrder(
  seen: Order,
  expected: OrderSnapshot,
): PayPalOrderReading {
  const mismatch = findOrderMismatch(seen, expected);
  if (mismatch) {
    return { outcome: "needs_review", reason: mismatch };
  }

  switch (seen.status) {
    case OrderStatus.Created:
    case OrderStatus.Saved:
    case OrderStatus.PayerActionRequired:
      return { outcome: "awaiting_buyer" };
    case OrderStatus.Approved:
      return { outcome: "ready_to_capture" };
    case OrderStatus.Voided:
      return { outcome: "voided" };
    case OrderStatus.Completed:
      break;
    default:
      return { outcome: "needs_review", reason: "order status" };
  }

  const [capture, ...otherCaptures] =
    seen.purchaseUnits?.[0]?.payments?.captures ?? [];
  if (!capture?.id || otherCaptures.length > 0) {
    return { outcome: "needs_review", reason: "captures" };
  }
  const captureId = capture.id;
  if (
    capture.amount?.currencyCode !== expected.currency ||
    capture.amount?.value !== minorToDecimal(expected.totalMinor, expected.currency)
  ) {
    return { outcome: "needs_review", reason: "capture amount", captureId };
  }

  switch (capture.status) {
    case CaptureStatus.Completed: {
      const capturedAt = parseCaptureTime(capture.createTime);
      if (!capturedAt) {
        return { outcome: "needs_review", reason: "capture time", captureId };
      }
      return { outcome: "paid", captureId, capturedAt };
    }
    case CaptureStatus.Pending:
      return { outcome: "capture_pending", captureId };
    case CaptureStatus.Declined:
    case CaptureStatus.Failed:
      return { outcome: "capture_refused", captureId };
    default:
      // Refunded in full or in part. The money has moved again, so a person should look.
      return { outcome: "needs_review", reason: "capture status", captureId };
  }
}

export type PayPalFailure = {
  // timeout, unavailable: the outcome is unknown, so only a retry with the same key is safe.
  // not_authorized: PayPal refused this seller's credentials or permissions.
  // rejected: PayPal refused this request, and repeating it cannot help.
  kind: "timeout" | "unavailable" | "not_authorized" | "rejected";
  status?: number;
  code?: string;
  name?: string;
  debugId?: string;
  issues?: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.-]{1,100}$/.test(value)
    ? value
    : undefined;
}

// PayPal's captured-payment create_time is RFC 3339. Date.parse alone accepts some
// impossible calendar dates by normalizing them, so check the written fields first.
function parseCaptureTime(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const min = Number(minute);
  const sec = Number(second);
  const leapYear = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    y < 1 ||
    m < 1 || m > 12 ||
    d < 1 || d > (daysInMonth[m - 1] ?? 0) ||
    h > 23 || min > 59 || sec > 59
  ) return undefined;
  if (zone.toUpperCase() !== "Z") {
    const offset = /[+-](\d{2}):(\d{2})$/.exec(zone);
    if (!offset || Number(offset[1]) > 23 || Number(offset[2]) > 59) return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

function errorPayload(error: Record<string, unknown>): Record<string, unknown> {
  if (error.result) {
    return asRecord(error.result);
  }
  if (typeof error.body === "string") {
    try {
      return asRecord(JSON.parse(error.body));
    } catch {
      return {};
    }
  }
  return {};
}

// Reads an error thrown by the SDK. The result holds short provider codes only and is safe to
// log, unlike the error itself, whose request carries the seller's authorization header.
export function describePayPalFailure(thrown: unknown): PayPalFailure {
  const error = asRecord(thrown);
  const payload = errorPayload(error);
  const status =
    typeof error.statusCode === "number" ? error.statusCode : undefined;
  const code = safeToken(error.code);
  const details = Array.isArray(payload.details) ? payload.details : [];
  const issues = details.flatMap((detail) => {
    const issue = safeToken(asRecord(detail).issue);
    return issue ? [issue] : [];
  });
  const debugId =
    safeToken(payload.debug_id) ??
    safeToken(asRecord(error.headers)["paypal-debug-id"]);
  const name = safeToken(payload.name) ?? safeToken(payload.error);
  const isTokenRequest = String(asRecord(error.request).url ?? "").includes(
    TOKEN_PATH,
  );

  let kind: PayPalFailure["kind"] = "unavailable";
  if (status === undefined) {
    kind = code && TIMEOUT_CODES.has(code) ? "timeout" : "unavailable";
  } else if (
    status === 401 ||
    status === 403 ||
    issues.includes("PAYEE_NOT_CONSENTED") ||
    (isTokenRequest && status === 400)
  ) {
    kind = "not_authorized";
  } else if (status === 400 || status === 422) {
    kind = "rejected";
  }

  return {
    kind,
    ...(status === undefined ? {} : { status }),
    ...(code ? { code } : {}),
    ...(name ? { name } : {}),
    ...(debugId ? { debugId } : {}),
    ...(issues.length > 0 ? { issues } : {}),
  };
}
