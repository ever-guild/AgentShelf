import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { currentSellerOrSignIn } from "@/server/auth/current-seller";
import { publicOrigin } from "@/server/public-origin";

import { SellerHeader } from "../seller-header";

export const metadata: Metadata = {
  title: "Assistant | AgentShelf",
  robots: { index: false, follow: false },
};

const SECONDARY_TEXT = "text-zinc-600 dark:text-zinc-400";
const TEXT_LINK = "underline underline-offset-4 transition-colors hover:text-ink";
const GUIDE = "https://github.com/ever-guild/AgentShelf/blob/main/docs/seller-agent-mcp.md#connect-claude-code";

// Examples of what an owner would say. Each one is something the seller tools can do.
const ASKS = [
  "Import this price list and show me the rows to check",
  "Publish the rows I checked",
  "Set the USB-C wall charger to 14.90 EUR",
  "Count four chargers in stock",
];

const KEPT = [
  "Only you issue and revoke access, and an assistant cannot widen its own",
  "Imported rows are checked before anything is published",
  "The assistant has no payment tool, buyers approve every payment in PayPal",
];

function shopEndpoint(shopId: string): string {
  const path = `/mcp/seller/shop/${shopId}`;
  try {
    return `${publicOrigin()}${path}`;
  } catch {
    return path;
  }
}

async function Assistant() {
  const shop = await currentSellerOrSignIn();
  return (
    <>
      <SellerHeader shopName={shop.name} />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-medium text-balance">Work through your assistant</h1>
          <p className={`max-w-prose ${SECONDARY_TEXT}`}>
            Your own assistant can import a price list, correct and publish the catalog, and keep
            stock for {shop.name}. The screens in the menu show the same records, so you can check
            what it did.
          </p>
        </div>

        <ol className="grid gap-x-6 gap-y-8 md:grid-cols-3">
          <li className="flex flex-col gap-3">
            <div className="flex gap-4">
              <span aria-hidden="true" className="font-medium text-ink tabular-nums">
                1
              </span>
              <div className="flex flex-col gap-1">
                <h2 className="font-medium">Give it access</h2>
                <p className={`text-sm ${SECONDARY_TEXT}`}>
                  Issue a credential for this shop from your owner account. It lasts 15 minutes and
                  you can revoke it sooner.
                </p>
              </div>
            </div>
            <Link
              href="/seller/agent-access"
              className="inline-flex h-11 w-fit items-center rounded-lg bg-ink px-4 font-medium text-background transition-[background-color,transform] hover:bg-ink/90 active:scale-[0.98]"
            >
              Open agent access
            </Link>
          </li>

          <li className="flex flex-col gap-3">
            <div className="flex gap-4">
              <span aria-hidden="true" className="font-medium text-ink tabular-nums">
                2
              </span>
              <div className="flex flex-col gap-1">
                <h2 className="font-medium">Connect it</h2>
                <p className={`text-sm ${SECONDARY_TEXT}`}>
                  Point your assistant at this shop’s address and give it the credential as a Bearer
                  header. Checked with Claude Code.
                </p>
              </div>
            </div>
            <code className="rounded-lg bg-zinc-100 px-3 py-2 font-mono text-sm break-all select-all dark:bg-zinc-800">
              {shopEndpoint(shop.id)}
            </code>
            <a href={GUIDE} className={`w-fit text-sm ${TEXT_LINK}`}>
              Read the connection guide
            </a>
          </li>

          <li className="flex flex-col gap-3">
            <div className="flex gap-4">
              <span aria-hidden="true" className="font-medium text-ink tabular-nums">
                3
              </span>
              <div className="flex flex-col gap-1">
                <h2 className="font-medium">Ask in your own words</h2>
                <p className={`text-sm ${SECONDARY_TEXT}`}>It changes the same records you see here</p>
              </div>
            </div>
            <ul className="flex flex-col divide-y divide-zinc-200 border-y border-zinc-200 text-ink dark:divide-zinc-800 dark:border-zinc-800">
              {ASKS.map((ask) => (
                <li key={ask} className="py-2">
                  {ask}
                </li>
              ))}
            </ul>
          </li>
        </ol>

        <section className="flex flex-col gap-3 border-t border-zinc-200 pt-8 dark:border-zinc-800">
          <h2 className="font-medium">What stays with you</h2>
          <ul className={`flex flex-col gap-2 ${SECONDARY_TEXT}`}>
            {KEPT.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p>
            Prefer to do it yourself?{" "}
            <Link href="/seller/imports" className={TEXT_LINK}>
              Add your price list
            </Link>
          </p>
        </section>
      </div>
    </>
  );
}

export default function AssistantPage() {
  return (
    <main className="flex flex-1 flex-col">
      <Suspense
        fallback={
          <p className="mx-auto w-full max-w-5xl px-4 py-8 text-zinc-600 sm:px-6 dark:text-zinc-400">
            Loading your shop
          </p>
        }
      >
        <Assistant />
      </Suspense>
    </main>
  );
}
