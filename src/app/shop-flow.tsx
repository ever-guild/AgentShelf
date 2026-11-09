import type { ReactNode } from "react";

import {
  DEMO_CHARGER_ID,
  DEMO_PRODUCT_ID,
  DEMO_PRODUCTS,
  DEMO_SERVICE_ID,
} from "@/server/db/seed";
import { minorToDecimal } from "@/server/domain/money";

// What AgentShelf does, shown on the demo workshop: a price list as the seller wrote it, the catalog
// it becomes, and a buyer's assistant ordering from that catalog. The words in ink are this page's
// illustration of what a seller writes and a buyer asks. Everything beside them is read from the
// demo seed, so the picture cannot drift from what the demo workshop sells.
const LINES = [
  { id: DEMO_SERVICE_ID, written: "iPhone 13 screen, 1 h", price: "80" },
  { id: DEMO_PRODUCT_ID, written: "Glass for iPhone 13", price: "9,90" },
  { id: DEMO_CHARGER_ID, written: "USB-C charger", price: "14,90" },
];

// The same words as one of the seed's search fixtures.
const ASKED = "iphone 13 screen protector";

const SECONDARY_TEXT = "text-zinc-600";
const SHEET = "rounded-lg border border-zinc-200 bg-background";

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

function catalogMeta(product: ReturnType<typeof seedProduct>): string {
  if (product.kind === "service") {
    return `Repair, about ${product.serviceDurationMinutes} minutes, ${euros(product.depositMinor ?? 0)} deposit`;
  }
  return product.availability === "available" ? "In stock" : "Not available right now";
}

function Step({
  number,
  title,
  text,
  children,
}: {
  number: number;
  title: string;
  text: string;
  children: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-4">
      <div className="flex gap-4">
        <span aria-hidden="true" className="font-medium text-ink tabular-nums">
          {number}
        </span>
        <div className="flex flex-col gap-1">
          <h3 className="font-medium">{title}</h3>
          <p className={`text-sm ${SECONDARY_TEXT}`}>{text}</p>
        </div>
      </div>
      <div className="flex flex-1 flex-col justify-center rounded-xl bg-zinc-100 p-4">{children}</div>
    </li>
  );
}

export function ShopFlow() {
  const found = seedProduct(DEMO_PRODUCT_ID);
  return (
    <ol className="grid gap-x-6 gap-y-10 lg:grid-cols-3">
      <Step number={1} title="Photograph your price list" text="A photo or a CSV file is enough">
        <div className={`${SHEET} flex flex-col gap-3 p-4 text-ink`}>
          <p className="font-medium">Demo Phone Workshop</p>
          <ul className="flex flex-col gap-2">
            {LINES.map(({ id, written, price }) => (
              <li key={id} className="flex items-baseline gap-2">
                <span className="min-w-0">{written}</span>
                <span
                  aria-hidden="true"
                  className="min-w-4 flex-1 border-b border-dotted border-current opacity-50"
                />
                <span className="tabular-nums">{price}</span>
              </li>
            ))}
          </ul>
        </div>
      </Step>

      <Step number={2} title="Check the catalog it becomes" text="Fix what was read wrong, then publish">
        <ul className={`${SHEET} divide-y divide-zinc-200 px-4`}>
          {LINES.map(({ id }) => {
            const product = seedProduct(id);
            return (
              <li key={id} className="flex flex-col gap-1 py-3">
                <p className="flex items-baseline justify-between gap-4 text-sm">
                  <span className="min-w-0 font-medium">{product.title}</span>
                  <span className="shrink-0 tabular-nums">{euros(product.priceMinor)}</span>
                </p>
                <p className={`text-xs ${SECONDARY_TEXT}`}>{catalogMeta(product)}</p>
              </li>
            );
          })}
        </ul>
      </Step>

      <Step
        number={3}
        title="Assistants find it, buyers pay in PayPal"
        text="The money goes directly to you"
      >
        <div className="flex flex-col gap-3 text-sm">
          <p className={`${SHEET} max-w-[85%] self-end px-3 py-2 text-ink`}>
            <span className="sr-only">A buyer asks their assistant: </span>
            {ASKED}
          </p>
          <p className={`${SHEET} max-w-[85%] self-start px-3 py-2`}>
            <span className="sr-only">The assistant answers: </span>
            Demo Phone Workshop in Liepaja has {found.title} for{" "}
            <span className="tabular-nums">{euros(found.priceMinor)}</span>
          </p>
          <p className={`${SHEET} flex items-baseline justify-between gap-4 px-3 py-2`}>
            <span className="font-medium text-accepted">The buyer approves it in PayPal</span>
            <span className="shrink-0 tabular-nums">{euros(found.priceMinor)}</span>
          </p>
        </div>
      </Step>
    </ol>
  );
}
