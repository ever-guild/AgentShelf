import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { SandboxNotice } from "@/app/shops/sandbox-notice";
import { getDb } from "@/server/db";
import { minorToDecimal } from "@/server/domain/money";
import { ServiceError } from "@/server/errors";
import { getBuyerOrder, type BuyerOrder } from "@/server/services/storefront";

import { bookingCopy } from "./booking-copy";

// The URL holds the order's status capability, so it must not leak through a referrer or a search
// engine. This page only reads the stored state.
export const metadata: Metadata = {
  title: "Your order | AgentShelf",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const COPY: Record<
  BuyerOrder["paymentStatus"],
  { title: string; body: (amount: string, shop: string) => string }
> = {
  paid: {
    title: "Payment confirmed",
    body: (amount, shop) =>
      `PayPal has confirmed your payment of ${amount}, and ${shop} has your order. You can close this tab.`,
  },
  approved: {
    title: "Confirming your payment",
    body: () =>
      "You approved this payment in PayPal, and it is not confirmed yet. Do not pay again. Check again in a moment.",
  },
  pending: {
    title: "Not approved yet",
    body: () =>
      "PayPal does not show an approval for this order, and nothing has been charged. You can start again from the shop, or ask your assistant.",
  },
  cancelled: {
    title: "Checkout cancelled",
    body: () =>
      "Nothing has been charged. You can start again from the shop, or ask your assistant.",
  },
  failed: {
    title: "The payment did not go through",
    body: () =>
      "PayPal did not complete this payment, and nothing has been charged. You can start again from the shop, or ask your assistant.",
  },
  review_required: {
    title: "This order needs a check",
    body: (_amount, shop) =>
      `Something about this payment needs a person to look at it. Please do not pay for this order again until ${shop} has been in touch.`,
  },
};

const UNAVAILABLE = {
  title: "We cannot show this order",
  body: "This link does not open an order. Your assistant can check the order's status.",
};

const LINK_CLASS =
  "text-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function OrderResult({ searchParams }: { searchParams: SearchParams }) {
  // A hold's state depends on the clock, so this always renders at request time.
  await connection();
  const query = await searchParams;
  const orderId = first(query.order);
  const statusToken = first(query.status);

  let order: BuyerOrder;
  try {
    order = await getBuyerOrder(getDb(), { orderId, statusToken });
  } catch (error) {
    if (!(error instanceof ServiceError)) {
      throw error;
    }
    return (
      <>
        <h1 className="text-4xl font-semibold tracking-tight">{UNAVAILABLE.title}</h1>
        <p className="max-w-md text-lg text-zinc-600 dark:text-zinc-400">{UNAVAILABLE.body}</p>
      </>
    );
  }

  const amount = `${minorToDecimal(order.totalMinor, order.currency)} ${order.currency}`;
  const special =
    order.booking &&
    bookingCopy(
      order.booking,
      order.paymentStatus,
      amount,
      `${minorToDecimal(order.booking.remainingMinor, order.currency)} ${order.currency}`,
      order.shop.name,
    );
  const title = special?.title ?? COPY[order.paymentStatus].title;
  const body =
    special?.body ?? COPY[order.paymentStatus].body(amount, order.shop.name);
  // Goes through the return route on purpose, so this asks PayPal rather than rereading this page.
  // A plain anchor, because a prefetch must not start that.
  const checkAgain = `/checkout/return?${new URLSearchParams({
    order: orderId ?? "",
    status: statusToken ?? "",
  })}`;

  return (
    <>
      <h1 className="text-4xl font-semibold tracking-tight">{title}</h1>
      <p className="max-w-md text-lg text-zinc-600 dark:text-zinc-400">
        {body}
      </p>
      {order.lines.length > 0 ? (
        <ul className="text-zinc-600 dark:text-zinc-400">
          {order.lines.map((line) => (
            <li key={line.title} className="break-words">
              {line.quantity > 1 ? `${line.quantity} x ` : ""}
              {line.title}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
        {order.paymentStatus === "approved" ? (
          <a href={checkAgain} className={LINK_CLASS}>
            Check again
          </a>
        ) : null}
        <Link href={`/shops/${order.shop.slug}`} className={LINK_CLASS}>
          Back to {order.shop.name}
        </Link>
      </div>
    </>
  );
}

export default function CheckoutResultPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <>
      <SandboxNotice />
      <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <Suspense fallback={<p className="text-lg">Checking your order…</p>}>
          <OrderResult searchParams={searchParams} />
        </Suspense>
      </main>
    </>
  );
}
