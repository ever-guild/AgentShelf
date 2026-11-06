// The browser's part of buying one product, without React so it can be tested alone. It holds no
// money logic: the server fixes the order, and this only asks for it and hands it to PayPal.

// Sandbox only, and not a setting. PayPal's current JavaScript SDK v6.
const PAYPAL_SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";
const SDK_LOAD_TIMEOUT_MS = 15_000;

export type PayPalSession = {
  start(
    options: { presentationMode: "auto" },
    order: Promise<{ orderId: string }>,
  ): Promise<unknown>;
};

export type PayPalCallbacks = {
  onApprove(data: { orderId?: string }): unknown;
  onCancel(data: { orderId?: string }): unknown;
  onError(error: { code?: string; message?: string }): unknown;
};

type PayPalInstance = {
  findEligibleMethods(options: {
    currencyCode: string;
  }): Promise<{ isEligible(method: string): boolean }>;
  createPayPalOneTimePaymentSession(callbacks: PayPalCallbacks): PayPalSession;
};

export type PayPalNamespace = {
  createInstance(options: {
    clientId: string;
    components: string[];
    pageType: string;
  }): Promise<PayPalInstance>;
};

let loading: Promise<PayPalNamespace> | undefined;

export function loadPayPalSdk(): Promise<PayPalNamespace> {
  const present = (window as unknown as { paypal?: PayPalNamespace }).paypal;
  if (present?.createInstance) {
    return Promise.resolve(present);
  }
  loading ??= new Promise<PayPalNamespace>((resolve, reject) => {
    const fail = () => {
      loading = undefined;
      reject(new Error("The PayPal SDK did not load"));
    };
    const timer = window.setTimeout(fail, SDK_LOAD_TIMEOUT_MS);
    const script = document.createElement("script");
    script.src = PAYPAL_SDK_URL;
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timer);
      fail();
    };
    script.onload = () => {
      window.clearTimeout(timer);
      const loaded = (window as unknown as { paypal?: PayPalNamespace }).paypal;
      if (loaded?.createInstance) {
        resolve(loaded);
      } else {
        fail();
      }
    };
    document.head.append(script);
  });
  return loading;
}

// A session when PayPal says this buyer can pay this way, and undefined when it does not.
export async function preparePayPalSession(
  paypal: PayPalNamespace,
  clientId: string,
  currencyCode: string,
  callbacks: PayPalCallbacks,
): Promise<PayPalSession | undefined> {
  const instance = await paypal.createInstance({
    clientId,
    components: ["paypal-payments"],
    pageType: "product-details",
  });
  const methods = await instance.findEligibleMethods({ currencyCode });
  return methods.isEligible("paypal")
    ? instance.createPayPalOneTimePaymentSession(callbacks)
    : undefined;
}

export type StorefrontCheckout = {
  paypalOrderId: string;
  totalMinor: number;
  currency: string;
  approvalUrl: string;
  returnPath: string;
  cancelPath: string;
};

export class CheckoutFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CheckoutFailure";
  }
}

// Sends only the product and the key. There is no field here for a price, a total or a merchant,
// and the server refuses a request that has one.
export async function requestCheckout(
  slug: string,
  productId: string,
  idempotencyKey: string,
  send: typeof fetch = fetch,
): Promise<StorefrontCheckout> {
  let response: Response;
  try {
    response = await send(`/api/shops/${encodeURIComponent(slug)}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, idempotencyKey }),
    });
  } catch {
    throw new CheckoutFailure("NETWORK");
  }
  const answer = (await response.json().catch(() => null)) as
    | (StorefrontCheckout & { error?: { code?: string } })
    | null;
  if (!response.ok || !answer?.paypalOrderId) {
    throw new CheckoutFailure(answer?.error?.code ?? "UNKNOWN");
  }
  return answer;
}

export type BuyerNotice = {
  message: string;
  // The next attempt has to be a new order, because repeating this one cannot change the answer.
  newKey: boolean;
  // Nothing on this page can help, so the button goes away.
  final: boolean;
};

const NOTHING_CHARGED = "Nothing has been charged.";

export function noticeFor(code: string): BuyerNotice {
  switch (code) {
    case "PAYMENT_NOT_CONFIGURED":
      return {
        message: `This shop cannot take payments yet. ${NOTHING_CHARGED} Please try again later.`,
        newKey: false,
        final: true,
      };
    case "PRODUCT_NOT_FOUND":
    case "PRODUCT_UNAVAILABLE":
      return {
        message: `This product is no longer on sale. ${NOTHING_CHARGED} The shop page shows what is available now.`,
        newKey: false,
        final: true,
      };
    case "PAYMENT_DECLINED":
      return {
        message: `PayPal did not accept this order. ${NOTHING_CHARGED} You can try again.`,
        newKey: true,
        final: false,
      };
    case "CHECKOUT_NEEDS_REVIEW":
    case "IDEMPOTENCY_CONFLICT":
      return {
        message: `We could not start this payment. ${NOTHING_CHARGED} You can try again.`,
        newKey: true,
        final: false,
      };
    case "NETWORK":
      return {
        message: `We could not reach the shop. ${NOTHING_CHARGED} Check your connection and try again.`,
        newKey: false,
        final: false,
      };
    default:
      return {
        message: `PayPal could not start this payment just now. ${NOTHING_CHARGED} Please try again in a moment.`,
        newKey: false,
        final: false,
      };
  }
}
