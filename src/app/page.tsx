import Link from "next/link";
import { connection } from "next/server";
import { Suspense, type CSSProperties } from "react";

import { DEMO_TECHNICIANS } from "@/server/db/seed";
import { publicOrigin } from "@/server/public-origin";

import { AgentStage } from "./agent-stage";
import { ConnectorAddress } from "./connector-address";
import { PayPalLoginButton } from "./paypal-login-button";
import { Replay, Reveal } from "./reveal";
import { ShopFlow } from "./shop-flow";

const SECONDARY_TEXT = "text-zinc-600";
// One column for the whole page, so the header, every section and the footer share their edges.
const PAGE_WIDTH = "mx-auto w-full max-w-6xl px-4 sm:px-6";
const SECTION = `${PAGE_WIDTH} flex flex-col gap-10 py-20 lg:py-24`;
const SECTION_TITLE = "text-3xl leading-[1.1] font-medium tracking-[-0.02em] text-balance sm:text-5xl sm:tracking-[-0.03em]";
const LEAD = `max-w-2xl text-lg/7 text-pretty ${SECONDARY_TEXT}`;
const TEXT_LINK = "font-medium underline underline-offset-4 transition-colors hover:text-ink";
const REPOSITORY = "https://github.com/ever-guild/AgentShelf";

// What an assistant could get wrong on its own, and the rule in AgentShelf that prevents it.
const GUARDS = [
  {
    risk: "A made-up price",
    rule: "Prices are stored in minor units, so 1490 means 14.90 EUR. On import, a price that is not a single amount, like “from 60”, is left empty for the owner to fill in.",
  },
  {
    risk: "A different answer each time",
    rule: "Search is PostgreSQL full-text search with no model call per query, so the same question returns the same items",
  },
  {
    risk: "The last one sold twice",
    rule: "Stock is reserved at checkout and a repair slot is held for 15 minutes. Tests cover the last unit bought twice.",
  },
  {
    risk: "An order the shop cannot fill",
    rule: "A product with no stock decision cannot be bought, and a shop with no PayPal connection cannot take an order",
  },
  {
    risk: "Money spent without a person",
    rule: "The assistant only gets a PayPal approval link. A person approves, and the payment is captured after PayPal reports the approval.",
  },
];

// Runs on the hosted service on 10 November 2026, each recorded in docs/capabilities.md.
const RUNS = [
  { through: "Claude", what: "Tempered glass, iPhone 14", amount: "10.90 EUR", result: "Paid" },
  { through: "ChatGPT", what: "Silicone case, iPhone 13", amount: "14.00 EUR", result: "Paid" },
  {
    through: "Claude",
    what: "Screen replacement, 09:00 slot",
    amount: "20.00 EUR deposit",
    result: "Paid, booking confirmed",
  },
  { through: "PayPal button on the shop page", what: "Cable", amount: "7.50 EUR", result: "Paid" },
];

// The same words as the demo seed's search fixtures that found nothing at the demo workshop.
const NOT_FOUND = ["magsafe charger", "wireless magsafe charger", "iphone 15 screen repair"];

const MONEY_STEPS = [
  {
    title: "The assistant creates the order",
    text: "It names the shop as the payee and returns a PayPal approval link. It cannot charge anything itself.",
  },
  {
    title: "A person approves it in PayPal",
    text: "Every payment is confirmed by the buyer in PayPal’s own window, never inside the chat",
  },
  {
    title: "PayPal pays the shop",
    text: "The payment is captured only after PayPal reports the approval, and it goes to the shop’s own PayPal account",
  },
];

// Three hours of the day in half-hour columns, so a one-hour repair is two columns wide.
const HOURS = ["09:00", "10:00", "11:00"];
const BAR = "col-span-2 mx-1 my-2 self-center truncate rounded-md border px-2 py-1 font-medium";
const HELD = `${BAR} border-dashed border-doubt bg-doubt/10 text-doubt`;
const CONFIRMED = `${BAR} border-accepted bg-accepted/10 text-accepted`;

function delay(seconds: number): CSSProperties {
  return { "--at": `${seconds}s` } as CSSProperties;
}

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

// One day in the demo workshop: a slot an assistant holds, and the same slot once its deposit is
// captured. Both sit in one cell, and only the confirmed one stays.
function DaySchedule() {
  const [first, second] = DEMO_TECHNICIANS;
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[28rem] grid-cols-[7.5rem_repeat(6,minmax(0,1fr))] border-t border-zinc-200 text-xs">
        <span />
        {HOURS.map((hour) => (
          <span
            key={hour}
            className={`col-span-2 border-l border-zinc-200 py-2 pl-2 tabular-nums ${SECONDARY_TEXT}`}
          >
            {hour}
          </span>
        ))}

        <span className="col-start-1 row-start-2 flex min-h-16 items-center border-t border-zinc-200 text-sm font-medium">
          {first?.name}
        </span>
        <span className="col-span-6 col-start-2 row-start-2 border-t border-zinc-200" />
        <span aria-hidden="true" className={`reveal-first col-start-2 row-start-2 ${HELD}`}>
          Held
          <br />
          Deposit pending
        </span>
        <span className={`reveal-then col-start-2 row-start-2 ${CONFIRMED}`}>
          Confirmed
          <br />
          Deposit paid
        </span>

        <span className="col-start-1 row-start-3 flex min-h-16 items-center border-t border-zinc-200 text-sm font-medium">
          {second?.name}
        </span>
        <span className="col-span-6 col-start-2 row-start-3 border-y border-zinc-200" />
        <span className={`col-start-5 row-start-3 ${CONFIRMED}`}>
          Confirmed
          <br />
          Screen repair
        </span>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <div className="bg-zinc-950 text-zinc-50">
        <header className={`${PAGE_WIDTH} flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-4`}>
          <p className="font-medium">AgentShelf</p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
            <p className="text-zinc-400">PayPal sandbox only: no real money, no real seller accounts</p>
            <Link
              href="/seller/sign-in"
              className="font-medium underline-offset-4 transition-colors hover:text-zinc-300 hover:underline"
            >
              Sign in
            </Link>
          </div>
        </header>
      </div>

      <main className="flex flex-1 flex-col">
        <div className="bg-zinc-950 text-zinc-50">
          <section className={`${PAGE_WIDTH} flex flex-col gap-6 pt-10 pb-10 lg:pt-12`}>
            <h1 className="stage-step max-w-5xl text-[2.5rem] leading-[1.04] font-medium tracking-[-0.02em] text-balance sm:text-5xl sm:tracking-[-0.03em] lg:text-6xl xl:text-7xl">
              The shop and the buyer each talk to an assistant, AgentShelf keeps the deal exact
            </h1>
            <p className="stage-step max-w-2xl text-lg/7 text-pretty text-zinc-400" style={delay(0.1)}>
              A small shop with no online store keeps its catalog and stock through its own assistant.
              Buyers find, book and order through Claude or ChatGPT. Prices, stock and slots are
              records, not guesses, and a person approves every payment in PayPal.
            </p>
            {/* The first action takes the page's own light tone, so it does not read as a second PayPal button. */}
            <div className="stage-step flex flex-wrap items-center gap-3 pt-2" style={delay(0.2)}>
              <a
                href="#connect"
                className="inline-flex h-12 items-center rounded-[24px] bg-zinc-50 px-6 font-medium text-zinc-950 transition-[background-color,transform] hover:bg-zinc-200 active:scale-[0.98]"
              >
                Connect your assistant
              </a>
              <PayPalLoginButton />
            </div>
          </section>

          <section className={`${PAGE_WIDTH} flex flex-col gap-4 pb-16`}>
            <h2 className="sr-only">One sale, from the owner’s words to a paid order</h2>
            <Replay caption="The demo workshop’s own data, in PayPal Sandbox">
              <AgentStage />
            </Replay>
          </section>
        </div>

        <Reveal>
          <section className={SECTION}>
            <div className="reveal flex flex-col gap-4">
              <h2 className={SECTION_TITLE}>The assistant talks, the record decides</h2>
              <p className={LEAD}>
                Assistants improvise. Here they can only read and change exact records, so the answer a
                buyer gets is the one the shop published.
              </p>
            </div>
            <dl className="border-t border-foreground">
              {GUARDS.map(({ risk, rule }, index) => (
                <div
                  key={risk}
                  className="reveal grid gap-x-10 gap-y-1 border-b border-zinc-200 py-5 md:grid-cols-[1fr_2fr]"
                  style={delay(0.1 + index * 0.06)}
                >
                  <dt className="text-xl font-medium tracking-[-0.01em]">{risk}</dt>
                  <dd className={`text-pretty ${SECONDARY_TEXT}`}>{rule}</dd>
                </div>
              ))}
            </dl>
          </section>
        </Reveal>

        <Reveal className="border-y border-zinc-200 bg-zinc-50">
          <section id="proof" className={SECTION}>
            <div className="reveal flex flex-col gap-4">
              <h2 className={SECTION_TITLE}>Four payments already went through on this site</h2>
              <p className={LEAD}>
                Real runs on 10 November 2026. A person approved each one in PayPal Sandbox, so no real
                money moved.
              </p>
            </div>
            <div className="reveal overflow-x-auto" style={delay(0.1)}>
              <table className="w-full min-w-[36rem] border-collapse text-left">
                <thead>
                  <tr className={`border-b border-foreground text-sm ${SECONDARY_TEXT}`}>
                    <th scope="col" className="py-3 pr-4 font-normal">
                      Bought through
                    </th>
                    <th scope="col" className="py-3 pr-4 font-normal">
                      What
                    </th>
                    <th scope="col" className="py-3 pr-4 text-right font-normal">
                      Amount
                    </th>
                    <th scope="col" className="py-3 font-normal">
                      Result
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {RUNS.map(({ through, what, amount, result }) => (
                    <tr key={`${through} ${what}`} className="border-b border-zinc-200">
                      <th scope="row" className="py-4 pr-4 text-lg font-medium">
                        {through}
                      </th>
                      <td className="py-4 pr-4">{what}</td>
                      <td className="py-4 pr-4 text-right whitespace-nowrap tabular-nums">{amount}</td>
                      <td className="py-4 font-medium text-accepted">{result}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={`reveal ${SECONDARY_TEXT}`} style={delay(0.2)}>
              Three rehearsals on one deployed commit produced six captures.{" "}
              <a href={`${REPOSITORY}/blob/main/docs/capabilities.md`} className={`text-foreground ${TEXT_LINK}`}>
                Read the evidence
              </a>
            </p>
          </section>
        </Reveal>

        <Reveal>
          <section className={SECTION}>
            <div className="reveal flex flex-col gap-4">
              <h2 className={SECTION_TITLE}>No catalog yet, start from the paper price list</h2>
              <p className={LEAD}>
                Photograph it or upload a CSV, yourself or through your assistant. Correct the table
                once, then publish.{" "}
                <Link href="/shops/liepaja-phone-workshop" className={`text-foreground ${TEXT_LINK}`}>
                  See the demo workshop
                </Link>
              </p>
            </div>
            <div className="reveal" style={delay(0.1)}>
              <ShopFlow />
            </div>
          </section>
        </Reveal>

        <Reveal className="border-y border-zinc-200 bg-zinc-50">
          <section className={SECTION}>
            <div className="reveal flex flex-col gap-4">
              <h2 className={SECTION_TITLE}>The owner can look whenever they want</h2>
              <p className={LEAD}>
                The assistant does the work. The schedule and the demand list are there to check it.
              </p>
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <div
                className="reveal flex min-w-0 flex-col gap-5 rounded-xl border border-zinc-200 bg-background p-6"
                style={delay(0.1)}
              >
                <div className="flex flex-col gap-1">
                  <h3 className="text-xl font-medium tracking-[-0.01em]">The day’s repairs</h3>
                  <p className={SECONDARY_TEXT}>
                    An assistant holds a slot, and it is confirmed only after the PayPal deposit is
                    captured
                  </p>
                </div>
                <DaySchedule />
                <p className={`mt-auto text-sm ${SECONDARY_TEXT}`}>
                  An example day at the demo workshop. The schedule is built on Bryntum Scheduler.
                </p>
              </div>

              <div
                className="reveal flex min-w-0 flex-col gap-5 rounded-xl border border-zinc-200 bg-background p-6"
                style={delay(0.2)}
              >
                <div className="flex flex-col gap-1">
                  <h3 className="text-xl font-medium tracking-[-0.01em]">Asked for, not found</h3>
                  <p className={SECONDARY_TEXT}>
                    What buyers’ assistants searched for that the shop does not list, which an ordinary
                    store never sees
                  </p>
                </div>
                <ul className="border-t border-zinc-200 text-lg text-ink">
                  {NOT_FOUND.map((query, index) => (
                    <li
                      key={query}
                      className="reveal border-b border-zinc-200 py-3"
                      style={delay(0.5 + index * 0.35)}
                    >
                      {query}
                    </li>
                  ))}
                </ul>
                <p className={`mt-auto text-sm ${SECONDARY_TEXT}`}>
                  Missed searches from the demo workshop’s data. The dashboard and its assistant are
                  built on AG Studio.
                </p>
              </div>
            </div>
          </section>
        </Reveal>

        <Reveal>
          <section className={SECTION}>
            <h2 className={`reveal ${SECTION_TITLE}`}>An assistant can order, only a person can pay</h2>
            <div aria-hidden="true" className="h-0.5 bg-zinc-200">
              <div className="reveal-line h-full bg-ink" />
            </div>
            <ol className="grid gap-8 md:grid-cols-3">
              {MONEY_STEPS.map(({ title, text }, index) => (
                <li key={title} className="reveal flex flex-col gap-2" style={delay(0.2 + index * 0.25)}>
                  <span aria-hidden="true" className="font-medium text-ink tabular-nums">
                    {index + 1}
                  </span>
                  <h3 className="text-xl font-medium tracking-[-0.01em]">{title}</h3>
                  <p className={`text-pretty ${SECONDARY_TEXT}`}>{text}</p>
                </li>
              ))}
            </ol>
          </section>
        </Reveal>

        <section id="connect" className="scroll-mt-4 border-t border-zinc-200">
          <div className={`${PAGE_WIDTH} flex flex-col gap-8 py-16 lg:flex-row lg:items-center lg:justify-between`}>
            <div className="flex max-w-xl flex-col gap-3">
              <h2 className={SECTION_TITLE}>One connector, no new app to learn</h2>
              <p className={`text-lg/7 text-pretty ${SECONDARY_TEXT}`}>
                Buyers add it once to Claude or ChatGPT, then ask for goods or a repair slot. A shop
                owner gives their own assistant a grant they can revoke.
              </p>
            </div>
            <Suspense fallback={<ConnectorFallback />}>
              <LiveConnectorAddress />
            </Suspense>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-200">
        <div className={`${PAGE_WIDTH} flex flex-wrap justify-between gap-x-6 gap-y-2 py-6 text-sm ${SECONDARY_TEXT}`}>
          <p>Open source under the MIT license</p>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <a href={REPOSITORY} className="underline-offset-4 transition-colors hover:text-ink hover:underline">
              GitHub
            </a>
            <Link href="/privacy" className="underline-offset-4 transition-colors hover:text-ink hover:underline">
              Privacy
            </Link>
            <Link href="/terms" className="underline-offset-4 transition-colors hover:text-ink hover:underline">
              Terms
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
