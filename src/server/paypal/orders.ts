import "server-only";

import {
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

// Everything the checkout service needs to know about PayPal Orders v2. The environment is
// fixed to sandbox here, and no setting can change it.

// Applies to each request, including the token exchange. The SDK's own default is no limit.
const REQUEST_TIMEOUT_MS = 12_000;
const TOKEN_CLOCK_SKEW_SECONDS = 60;
const MAX_ITEM_NAME_LENGTH = 127;
const SANDBOX_CHECKOUT_ORIGIN = "https://www.sandbox.paypal.com";
const TOKEN_PATH = "/v1/oauth2/token";
const TIMEOUT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT"]);

export type PayPalOrdersApi = Pick<OrdersController, "createOrder">;

// Resolves a shop's `paypal_credential_ref` to its seller's own REST app. This is the merchant
// model under test in docs/paypal-sandbox-proof.md, and the only code that depends on it.
export type PayPalOrdersProvider = (
  credentialRef: string,
) => PayPalOrdersApi | undefined;

function createOrdersController(
  oAuthClientId: string,
  oAuthClientSecret: string,
  testAdapter: unknown,
): OrdersController {
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
  return new OrdersController(client);
}

export function createPayPalOrdersProvider(
  env: Record<string, string | undefined> = process.env,
  testAdapter?: unknown,
): PayPalOrdersProvider {
  // One client per seller app, so its cached token is reused between orders.
  const controllers = new Map<string, OrdersController>();

  return (credentialRef) => {
    const clientId = env[`PAYPAL_CLIENT_ID_${credentialRef}`]?.trim();
    const clientSecret = env[`PAYPAL_CLIENT_SECRET_${credentialRef}`]?.trim();
    if (!clientId || !clientSecret) {
      return undefined;
    }

    return {
      createOrder: async (request, requestOptions) => {
        const controller =
          controllers.get(credentialRef) ??
          createOrdersController(clientId, clientSecret, testAdapter);
        controllers.set(credentialRef, controller);
        try {
          return await controller.createOrder(request, requestOptions);
        } catch (error) {
          // The SDK keeps a failed token exchange as a rejected promise and rethrows it on every
          // later call without sending a request, so one network failure would otherwise stop
          // this seller's payments until a restart. The next call starts with a new client.
          controllers.delete(credentialRef);
          throw error;
        }
      },
    };
  };
}

export const paypalOrdersFor = createPayPalOrdersProvider();

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
  origin: string,
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
          returnUrl: `${origin}/checkout/return`,
          cancelUrl: `${origin}/checkout/cancel`,
          userAction: PaypalExperienceUserAction.PayNow,
        },
      },
    },
  };
}

// Names the first way a PayPal response differs from the order that was requested.
export function findOrderMismatch(
  created: Order,
  expected: OrderSnapshot,
): string | undefined {
  const [unit, ...otherUnits] = created.purchaseUnits ?? [];
  if (!created.id) return "order id";
  if (created.intent !== CheckoutPaymentIntent.Capture) return "intent";
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

export type PayPalFailure = {
  // timeout, unavailable: the outcome is unknown, so only a retry with the same key is safe.
  // not_authorized: PayPal refused this seller's credentials or permissions.
  // rejected: PayPal refused this order, and repeating it cannot help.
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
