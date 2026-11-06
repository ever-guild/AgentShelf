"use client";

import { useEffect, useRef, useState } from "react";

import {
  CheckoutFailure,
  loadPayPalSdk,
  noticeFor,
  preparePayPalSession,
  requestCheckout,
  type PayPalSession,
  type StorefrontCheckout,
} from "../../../buy-flow";

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "paypal-button": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { type?: string },
        HTMLElement
      >;
    }
  }
}

type Mode =
  // Waiting for PayPal's SDK.
  | "preparing"
  // PayPal's own button, which opens PayPal over this page.
  | "button"
  // The SDK is not usable here, so the buyer goes to PayPal's own page for the same order.
  | "link"
  // Nothing on this page can help.
  | "closed";

const LINK_REASON =
  "PayPal's button is not available here, so this continues on PayPal's own page. You still approve the payment there.";

export function BuyPanel({
  slug,
  productId,
  currency,
  clientId,
}: {
  slug: string;
  productId: string;
  currency: string;
  clientId: string;
}) {
  const [mode, setMode] = useState<Mode>("preparing");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const session = useRef<PayPalSession | null>(null);
  const checkout = useRef<StorefrontCheckout | null>(null);
  // One key per attempt, so that a repeated click continues the same order instead of making a
  // second one.
  const idempotencyKey = useRef<string | null>(null);

  useEffect(() => {
    let current = true;
    const leaveFor = (path?: string) => {
      if (path) {
        window.location.assign(path);
      }
    };
    loadPayPalSdk()
      .then((paypal) =>
        preparePayPalSession(paypal, clientId, currency, {
          // The return route asks PayPal, captures if it should, and only then shows a result.
          onApprove: () => {
            setBusy(true);
            leaveFor(checkout.current?.returnPath);
          },
          onCancel: () => {
            setBusy(false);
            leaveFor(checkout.current?.cancelPath);
          },
          onError: () => {
            setBusy(false);
            setNotice(
              "PayPal could not finish this payment, and nothing has been charged. You can try again on PayPal's own page.",
            );
            setMode("link");
          },
        }),
      )
      .then((prepared) => {
        if (!current) {
          return;
        }
        session.current = prepared ?? null;
        setMode(prepared ? "button" : "link");
      })
      .catch(() => {
        if (current) {
          setMode("link");
        }
      });
    return () => {
      current = false;
    };
  }, [clientId, currency]);

  function askForCheckout(): Promise<StorefrontCheckout> {
    idempotencyKey.current ??= crypto.randomUUID();
    return requestCheckout(slug, productId, idempotencyKey.current).then((answer) => {
      checkout.current = answer;
      return answer;
    });
  }

  function showFailure(failure: unknown) {
    setBusy(false);
    const known = noticeFor(failure instanceof CheckoutFailure ? failure.code : "UNKNOWN");
    if (known.newKey) {
      idempotencyKey.current = null;
    }
    setNotice(known.message);
    if (known.final) {
      setMode("closed");
    }
  }

  async function payWithButton() {
    const started = session.current;
    if (!started || busy) {
      return;
    }
    setBusy(true);
    setNotice(null);
    // Not awaited: PayPal opens its window from this click, and waiting first would get it blocked.
    const order = askForCheckout();
    try {
      await started.start(
        { presentationMode: "auto" },
        order.then((answer) => ({ orderId: answer.paypalOrderId })),
      );
    } catch (failure) {
      if (failure instanceof CheckoutFailure) {
        showFailure(failure);
      } else {
        setBusy(false);
        setNotice(LINK_REASON);
        setMode("link");
      }
    }
  }

  async function payOnPayPalPage() {
    if (busy) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const answer = await askForCheckout();
      window.location.assign(answer.approvalUrl);
    } catch (failure) {
      showFailure(failure);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {mode === "preparing" ? (
        <p className="text-zinc-600 dark:text-zinc-400">Getting PayPal ready</p>
      ) : null}

      {mode === "button" ? (
        <div className="rounded-lg focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink">
          <paypal-button
            type="buynow"
            className="paypal-gold block w-full max-w-sm"
            onClick={payWithButton}
          />
        </div>
      ) : null}

      {mode === "link" ? (
        <button
          type="button"
          disabled={busy}
          onClick={payOnPayPalPage}
          className="w-full max-w-sm rounded-lg bg-ink px-4 py-3 font-medium text-background hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-60"
        >
          {busy ? "Opening PayPal" : "Continue to PayPal"}
        </button>
      ) : null}

      {busy && mode === "button" ? (
        <p className="text-zinc-600 dark:text-zinc-400">Waiting for PayPal</p>
      ) : null}

      <div aria-live="polite">
        {notice ? (
          <p className={mode === "closed" ? "text-blocked" : "text-doubt"}>{notice}</p>
        ) : null}
      </div>

      <noscript>
        <p className="text-blocked">
          Paying needs JavaScript. Turn it on and reload this page. Nothing has been charged.
        </p>
      </noscript>
    </div>
  );
}
