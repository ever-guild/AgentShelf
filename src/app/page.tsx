import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { publicOrigin } from "@/server/public-origin";

import { ConnectorAddress } from "./connector-address";
import { PayPalLoginButton } from "./paypal-login-button";
import { ShopFlow } from "./shop-flow";

const SECONDARY_TEXT = "text-zinc-600";
// One column for the whole page, so the header, the steps and the connector share their edges.
const PAGE_WIDTH = "mx-auto w-full max-w-6xl px-4 sm:px-6";

function ConnectorFallback() {
  return <p className={SECONDARY_TEXT}>It is at /mcp on this site</p>;
}

function connectorUrl(): string | null {
  try {
    return `${publicOrigin()}/mcp`;
  } catch {
    return null;
  }
}

// The address comes from the running service's own environment, so this one part is read at request
// time and the rest of the page stays static.
async function LiveConnectorAddress() {
  await connection();
  const address = connectorUrl();
  return address ? <ConnectorAddress address={address} /> : <ConnectorFallback />;
}

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <header className={`${PAGE_WIDTH} flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-4`}>
        <p className="font-medium">AgentShelf</p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <p className={SECONDARY_TEXT}>PayPal sandbox only: no real money, no real seller accounts</p>
          <Link
            href="/seller/sign-in"
            className="font-medium underline-offset-4 transition-colors hover:text-ink hover:underline"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="flex flex-1 flex-col">
        <section className="mx-auto flex w-full max-w-5xl flex-col items-center gap-6 px-4 pt-16 pb-12 text-center sm:px-6 lg:pt-20">
          <h1 className="text-[2.5rem] leading-[1.05] font-medium tracking-[-0.02em] text-balance sm:text-6xl sm:tracking-[-0.03em]">
            Turn your price list into a shop AI assistants can buy from
          </h1>
          <p className={`max-w-2xl text-lg/7 text-pretty ${SECONDARY_TEXT}`}>
            AgentShelf is for small shops and workshops with no online store. Buyers ask an assistant
            such as Claude or ChatGPT, confirm the payment in PayPal, and the money goes directly to
            you.
          </p>
          {/* The demo action takes the text color, so it does not read as a second PayPal button. */}
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <Link
              href="/shops/demo-phone-workshop"
              className="inline-flex h-12 items-center rounded-[24px] bg-foreground px-6 font-medium text-background transition-[background-color,transform] hover:bg-foreground/85 active:scale-[0.98]"
            >
              See the demo workshop
            </Link>
            <PayPalLoginButton />
          </div>
        </section>

        <section className={`${PAGE_WIDTH} flex flex-col gap-6 pb-12`}>
          <h2 className="sr-only">How it works, on the demo workshop</h2>
          <ShopFlow />
        </section>

        <section className={`${PAGE_WIDTH} mt-auto pb-8`}>
          <div className="border-t border-zinc-200 pt-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-col gap-0.5">
                <h2 className="text-sm font-medium">One MCP connector covers every shop</h2>
                <p className={`text-xs ${SECONDARY_TEXT}`}>
                  Ask Claude or ChatGPT to find goods and book repair slots via PayPal Sandbox
                </p>
              </div>
              <Suspense fallback={<ConnectorFallback />}>
                <LiveConnectorAddress />
              </Suspense>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
