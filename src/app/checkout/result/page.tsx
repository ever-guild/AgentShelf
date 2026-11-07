import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { SandboxNotice } from "@/app/shops/sandbox-notice";
import { PAGE_COLUMN, QUIET_LINK, SECONDARY_TEXT } from "@/app/shops/shop-parts";
import { getDb } from "@/server/db";
import { minorToDecimal } from "@/server/domain/money";
import { ServiceError } from "@/server/errors";
import { getBuyerOrder, type BuyerOrder } from "@/server/services/storefront";

import { bookingCopy, type SlipRow } from "./booking-copy";

// The URL holds the order's status capability, so it must not leak through a referrer or a search
// engine. This page only reads the stored state.
export const metadata: Metadata = {
  title: "Your order | AgentShelf",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const STANDING_TEXT = {
  accepted: "text-accepted",
  doubt: "text-doubt",
};

// Where to go after a payment that did not happen. A shop page sells products, and only an assistant
// books a repair, so a deposit cannot be started again from the shop.
function tryAgain(deposit: boolean): string {
  return deposit
    ? "To try again, ask your assistant."
    : "You can start again from the shop, or ask your assistant.";
}

const COPY: Record<
  BuyerOrder["paymentStatus"],
  {
    title: string;
    body: (amount: string, shop: string, deposit: boolean) => string;
    charge: Pick<SlipRow, "label" | "standing">;
  }
> = {
  paid: {
    title: "Payment confirmed",
    body: (amount, shop) =>
      `PayPal has confirmed your payment of ${amount}, and ${shop} has your order. You can close this tab.`,
    charge: { label: "Paid", standing: "accepted" },
  },
  approved: {
    title: "Confirming your payment",
    body: () =>
      "You approved this payment in PayPal, and it is not confirmed yet. Do not pay again. Check again in a moment.",
    charge: { label: "Approved, not confirmed yet", standing: "doubt" },
  },
  pending: {
    title: "Not approved yet",
    body: (_amount, _shop, deposit) =>
      `PayPal does not show an approval for this order, and nothing has been charged. ${tryAgain(deposit)}`,
    charge: { label: "Not charged" },
  },
  cancelled: {
    title: "Checkout cancelled",
    body: (_amount, _shop, deposit) => `Nothing has been charged. ${tryAgain(deposit)}`,
    charge: { label: "Not charged" },
  },
  failed: {
    title: "The payment did not go through",
    body: (_amount, _shop, deposit) =>
      `PayPal did not complete this payment, and nothing has been charged. ${tryAgain(deposit)}`,
    charge: { label: "Not charged" },
  },
  review_required: {
    title: "This order needs a check",
    body: (_amount, shop) =>
      `Something about this payment needs a person to look at it. Please do not pay for this order again until ${shop} has been in touch.`,
    charge: { label: "Being checked", standing: "doubt" },
  },
};

const UNAVAILABLE = {
  title: "We cannot show this order",
  body: "This link does not open an order. Your assistant can check the order's status.",
};

const TITLE_CLASS = "text-3xl font-medium text-balance";
const BODY_CLASS = `max-w-xl text-lg/7 text-pretty ${SECONDARY_TEXT}`;
const SLIP_RULES = "divide-y divide-zinc-200 dark:divide-zinc-800";

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
      <div className="flex flex-col gap-3">
        <h1 className={TITLE_CLASS}>{UNAVAILABLE.title}</h1>
        <p className={BODY_CLASS}>{UNAVAILABLE.body}</p>
      </div>
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
  const plain = COPY[order.paymentStatus];
  const title = special?.title ?? plain.title;
  const body = special?.body ?? plain.body(amount, order.shop.name, order.booking !== null);
  const rows = special?.rows ?? [{ ...plain.charge, value: amount }];
  // Goes through the return route on purpose, so this asks PayPal rather than rereading this page.
  // A plain anchor, because a prefetch must not start that.
  const checkAgain = `/checkout/return?${new URLSearchParams({
    order: orderId ?? "",
    status: statusToken ?? "",
  })}`;

  const canCheckAgain = order.paymentStatus === "approved";

  return (
    <>
      <p className="font-medium break-words">{order.shop.name}</p>
      <div className="flex flex-col gap-3">
        <h1 className={TITLE_CLASS}>{title}</h1>
        <p className={BODY_CLASS}>{body}</p>
      </div>
      <div className={`max-w-xl border-y border-zinc-200 dark:border-zinc-800 ${SLIP_RULES}`}>
        {order.lines.length > 0 ? (
          <ul className={SLIP_RULES}>
            {order.lines.map((line) => (
              <li key={line.title} className="py-3 break-words">
                {line.quantity > 1 ? `${line.quantity} x ` : ""}
                {line.title}
              </li>
            ))}
          </ul>
        ) : null}
        <dl className={SLIP_RULES}>
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3"
            >
              <dt className={row.standing ? STANDING_TEXT[row.standing] : SECONDARY_TEXT}>
                {row.label}
              </dt>
              <dd className="ml-auto text-right font-medium tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        {canCheckAgain ? (
          <a
            href={checkAgain}
            className="inline-flex h-12 items-center rounded-lg bg-ink px-5 font-medium text-background transition-[background-color,transform] hover:bg-ink/90 active:scale-[0.98] motion-reduce:active:scale-100"
          >
            Check again
          </a>
        ) : null}
        {/* Beside the button it takes the button's height, so the two stay one row of even steps
            when a phone stacks them. */}
        <Link
          href={`/shops/${order.shop.slug}`}
          className={`${QUIET_LINK} ${canCheckAgain ? "inline-flex h-12 items-center" : ""}`}
        >
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
      <main className="flex flex-1 flex-col">
        <div className={`${PAGE_COLUMN} gap-6`}>
          <Suspense fallback={<p className={SECONDARY_TEXT}>Checking your order</p>}>
            <OrderResult searchParams={searchParams} />
          </Suspense>
        </div>
      </main>
    </>
  );
}
