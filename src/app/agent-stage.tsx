import type { CSSProperties, ReactNode } from "react";

import { DEMO_CHARGER_ID, DEMO_INVENTORY, DEMO_PRODUCTS, DEMO_SERVICE_ID } from "@/server/db/seed";
import { SELLER_AGENT_TOOL_NAMES } from "@/server/contracts/seller-agent";
import { minorToDecimal } from "@/server/domain/money";

// The opening scene: the shop owner's assistant changes a record, AgentShelf holds it, and a buyer's
// assistant sells from it. The words in ink are this page's illustration of what an owner and a
// buyer say. The title, the price and the stock count beside them are read from the demo seed, and
// the tool names from the contracts, so the scene cannot drift from what the demo workshop sells.
const OWNER_SAYS = "Set the USB-C wall charger to 14,90 and count four in stock";
const BUYER_SAYS = "A USB-C wall charger near Liepaja";

// Seconds from the start of the scene, one step after another.
const T = {
  ownerSays: 0.6,
  ownerTools: 2.2,
  ownerDone: 2.8,
  record: 3.8,
  buyerSays: 4.8,
  buyerTools: 6.4,
  buyerOffer: 7.0,
  reserved: 7.6,
  approve: 8.4,
  approved: 9.6,
  paid: 10.2,
};

const SECONDARY_TEXT = "text-zinc-600";
const TOOLS = `font-mono text-xs ${SECONDARY_TEXT}`;
const SAID = "max-w-[92%] self-end rounded-2xl bg-zinc-100 px-3 py-2 text-ink";

function at(seconds: number, until?: number): CSSProperties {
  return {
    "--at": `${seconds}s`,
    ...(until === undefined ? {} : { "--until": `${until}s` }),
  } as CSSProperties;
}

function euros(minor: number): string {
  return `${minorToDecimal(minor, "EUR")} EUR`;
}

function seedProduct(id: string) {
  const product = DEMO_PRODUCTS.find((candidate) => candidate.id === id);
  if (product?.priceMinor == null) {
    throw new Error(`The demo seed has no priced product ${id}.`);
  }
  return { ...product, priceMinor: product.priceMinor };
}

function seedStock(id: string): number {
  const row = DEMO_INVENTORY.find((candidate) => candidate.productId === id);
  if (!row) {
    throw new Error(`The demo seed has no stock for ${id}.`);
  }
  return row.onHand;
}

function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className="flex min-w-0 flex-col gap-3">
      <h3 className="text-sm font-medium text-zinc-400">{label}</h3>
      <div className="flex min-h-80 flex-1 flex-col gap-3 rounded-xl border border-zinc-200 bg-background p-4 text-sm text-foreground">
        {children}
      </div>
    </li>
  );
}

export function AgentStage() {
  const charger = seedProduct(DEMO_CHARGER_ID);
  const repair = seedProduct(DEMO_SERVICE_ID);
  const stock = seedStock(DEMO_CHARGER_ID);
  const price = euros(charger.priceMinor);

  return (
    <ol className="grid gap-x-5 gap-y-8 md:grid-cols-3">
      <Panel label="The shop owner's assistant">
        <p className={`stage-step ${SAID}`} style={at(T.ownerSays)}>
          <span className="sr-only">The owner says: </span>
          <span className="stage-type inline-block" style={at(T.ownerSays)}>
            {OWNER_SAYS}
          </span>
        </p>
        <p className={`stage-step ${TOOLS}`} style={at(T.ownerTools)}>
          {SELLER_AGENT_TOOL_NAMES.manageCatalog} · {SELLER_AGENT_TOOL_NAMES.manageStock}
        </p>
        <p className="stage-step" style={at(T.ownerDone)}>
          <span className="sr-only">The assistant answers: </span>
          Done, {charger.title} is <span className="tabular-nums">{price}</span> with {stock} in stock
        </p>
        <p className={`mt-auto border-t border-zinc-200 pt-3 text-xs ${SECONDARY_TEXT}`}>
          The owner&apos;s own assistant, under a grant the owner can revoke
        </p>
      </Panel>

      <Panel label="AgentShelf keeps the record">
        <p className="border-b border-zinc-200 pb-3 font-medium">Demo Phone Workshop</p>
        <div className="flex items-baseline justify-between gap-4">
          <div className="flex min-w-0 flex-col">
            <p className="font-medium">{repair.title}</p>
            <p className={`text-xs ${SECONDARY_TEXT}`}>
              Repair, about {repair.serviceDurationMinutes} minutes
            </p>
          </div>
          <span className="shrink-0 tabular-nums">{euros(repair.priceMinor)}</span>
        </div>
        <div className="stage-step flex items-baseline justify-between gap-4" style={at(T.record)}>
          <div className="flex min-w-0 flex-col">
            <p className="font-medium">{charger.title}</p>
            {/* Three states of one count share a line. Only the last one stays. */}
            <p className="grid text-xs font-medium *:col-start-1 *:row-start-1">
              <span aria-hidden="true" className={`stage-passing ${SECONDARY_TEXT}`} style={at(T.record, T.reserved)}>
                {stock} in stock
              </span>
              <span aria-hidden="true" className="stage-passing text-doubt" style={at(T.reserved, T.paid)}>
                {stock - 1} available, 1 reserved
              </span>
              <span className={`stage-step ${SECONDARY_TEXT}`} style={at(T.paid)}>
                {stock - 1} in stock
              </span>
            </p>
          </div>
          <span className="shrink-0 tabular-nums">{price}</span>
        </div>
        <ul className={`mt-auto flex min-h-16 flex-col gap-1 border-t border-zinc-200 pt-3 ${TOOLS}`}>
          <li className="stage-step" style={at(T.record)}>
            price stored as {charger.priceMinor} minor units
          </li>
          <li className="stage-step" style={at(T.reserved)}>
            1 unit reserved at checkout
          </li>
          <li className="stage-step text-accepted" style={at(T.paid)}>
            captured after PayPal approval
          </li>
        </ul>
      </Panel>

      <Panel label="The buyer's assistant">
        <p className={`stage-step ${SAID}`} style={at(T.buyerSays)}>
          <span className="sr-only">A buyer says: </span>
          <span className="stage-type inline-block" style={at(T.buyerSays)}>
            {BUYER_SAYS}
          </span>
        </p>
        <p className={`stage-step ${TOOLS}`} style={at(T.buyerTools)}>
          search_products · create_checkout
        </p>
        <p className="stage-step" style={at(T.buyerOffer)}>
          <span className="sr-only">The assistant answers: </span>
          Demo Phone Workshop has one for <span className="tabular-nums">{price}</span>. I cannot pay for
          you, approve it in PayPal.
        </p>
        <p className="grid font-medium *:col-start-1 *:row-start-1">
          <span
            aria-hidden="true"
            className="stage-passing flex items-center justify-between gap-4 rounded-3xl bg-ink px-4 py-3 text-white"
            style={at(T.approve, T.approved)}
          >
            Approve in PayPal <span className="shrink-0 whitespace-nowrap tabular-nums">{price}</span>
          </span>
          <span
            className="stage-step flex items-center justify-between gap-4 rounded-3xl bg-accepted/10 px-4 py-3 text-accepted"
            style={at(T.approved)}
          >
            Approved in PayPal <span className="shrink-0 whitespace-nowrap tabular-nums">{price}</span>
          </span>
        </p>
        <p
          className="stage-step mt-auto flex items-center justify-between gap-4 border-t border-zinc-200 pt-3 font-medium"
          style={at(T.paid)}
        >
          Order paid to the shop
          <span className="-rotate-6 rounded border-2 border-accepted px-2 text-accepted">Paid</span>
        </p>
      </Panel>
    </ol>
  );
}
