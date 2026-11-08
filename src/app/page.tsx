import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { publicOrigin } from "@/server/public-origin";

import { CarbonSheet } from "./carbon-sheet";
import { ConnectorAddress } from "./connector-address";
import { PayPalLoginButton } from "./paypal-login-button";

const SECONDARY_TEXT = "text-zinc-600 dark:text-zinc-400";

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
    <main className="grid flex-1 lg:min-h-svh lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:grid-rows-[1fr_auto]">
      <div className="flex flex-col gap-12 px-4 pt-6 pb-12 sm:px-8 lg:gap-8 lg:px-12 lg:pb-8">
        <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <p className="font-medium">AgentShelf</p>
          <p className={`text-sm ${SECONDARY_TEXT}`}>
            PayPal sandbox only: no real money, no real seller accounts
          </p>
        </header>

        <div className="my-auto flex max-w-xl flex-col gap-6">
          <h1 className="text-[2.5rem] leading-[1.05] font-medium tracking-[-0.02em] text-balance xl:text-[3.5rem] xl:tracking-[-0.03em]">
            <span className="whitespace-nowrap">A paper price list</span> that buyers’ assistants
            can order from
          </h1>
          <div className={`flex flex-col gap-3 text-lg/7 text-pretty ${SECONDARY_TEXT}`}>
            <p>
              For small shops and workshops with no online store. Photograph your price list, correct
              the result in a table and publish.
            </p>
            <p>
              A buyer’s own assistant, such as Claude or ChatGPT, finds a product or a free repair slot
              through one connector. The buyer confirms payment in PayPal, and the money goes directly
              to you.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-2">
            <Link
              href="/shops/demo-phone-workshop"
              className="inline-flex h-12 items-center rounded-[24px] bg-ink px-5 font-medium text-background transition-[background-color,transform] hover:bg-ink/90 active:scale-[0.98]"
            >
              See the demo workshop
            </Link>
            <PayPalLoginButton />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center overflow-hidden bg-zinc-100 px-4 py-12 sm:px-8 lg:col-start-2 lg:row-span-2 lg:row-start-1 dark:bg-zinc-900">
        <CarbonSheet />
      </div>

      <div className="px-4 py-8 sm:px-8 lg:px-12 lg:pt-0 lg:pb-8">
        <div className="flex max-w-xl flex-col gap-2 lg:border-t lg:border-zinc-200 lg:pt-4 lg:dark:border-zinc-800">
          <h2 className="text-sm font-medium">
            Add one MCP connector to your assistant, and it covers every shop
          </h2>
          <Suspense fallback={<ConnectorFallback />}>
            <LiveConnectorAddress />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
