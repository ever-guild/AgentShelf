import type { Metadata } from "next";
import { Suspense } from "react";

import { getDb } from "@/server/db";
import { minorToDecimal } from "@/server/domain/money";
import { ServiceError } from "@/server/errors";
import { getOrderStatus } from "@/server/services/order-status";

// The URL holds the order's status capability, so it must not leak through a referrer or a search
// engine. This page only reads the stored state.
export const metadata: Metadata = {
  title: "Your order | AgentShelf",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const COPY = {
  paid: {
    title: "Payment confirmed",
    body: (amount: string) =>
      `PayPal has confirmed your payment of ${amount}, and the shop has your order. You can close this tab.`,
  },
  approved: {
    title: "Confirming your payment",
    body: () =>
      "You approved this payment in PayPal, and it is not confirmed yet. Reload this page in a moment.",
  },
  pending: {
    title: "Not approved yet",
    body: () =>
      "PayPal does not show an approval for this order, and nothing has been charged.",
  },
  cancelled: {
    title: "Checkout cancelled",
    body: () =>
      "Nothing has been charged. You can close this tab, or ask your assistant to start again.",
  },
  failed: {
    title: "The payment did not go through",
    body: () =>
      "PayPal did not complete this payment, and nothing has been charged. You can ask your assistant to start again.",
  },
  review_required: {
    title: "This order needs a check",
    body: () =>
      "Something about this payment needs a person to look at it. Please do not pay for this order again until the shop has been in touch.",
  },
};

const UNAVAILABLE = {
  title: "We cannot show this order",
  body: "This link does not open an order. Your assistant can check the order's status.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function OrderResult({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  let content = UNAVAILABLE;
  try {
    const order = await getOrderStatus(getDb(), {
      orderId: first(query.order),
      statusToken: first(query.status),
    });
    const copy = COPY[order.paymentStatus];
    content = {
      title: copy.title,
      body: copy.body(
        `${minorToDecimal(order.totalMinor, order.currency)} ${order.currency}`,
      ),
    };
  } catch (error) {
    if (!(error instanceof ServiceError)) {
      throw error;
    }
  }

  return (
    <>
      <h1 className="text-4xl font-semibold tracking-tight">{content.title}</h1>
      <p className="max-w-md text-lg text-zinc-600 dark:text-zinc-400">
        {content.body}
      </p>
    </>
  );
}

export default function CheckoutResultPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <Suspense fallback={<p className="text-lg">Checking your order…</p>}>
        <OrderResult searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
