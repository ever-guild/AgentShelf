import {
  DEMO_CABLE_ID,
  DEMO_CHARGER_ID,
  DEMO_PRODUCT_ID,
  DEMO_PRODUCTS,
  DEMO_SERVICE_ID,
} from "@/server/db/seed";
import { minorToDecimal } from "@/server/domain/money";

import "./carbon-sheet.css";

// The carbon-blue lines are this page's illustration of what a seller might write. Everything typed
// beside them is read from the demo seed, so the sheet cannot drift from what the demo workshop sells.
const LINES = [
  { id: DEMO_SERVICE_ID, written: "iPhone 13 screen, 1 h", price: "80" },
  { id: DEMO_PRODUCT_ID, written: "Glass for iPhone 13", price: "9,90" },
  { id: DEMO_CHARGER_ID, written: "USB-C charger", price: "14,90" },
  { id: DEMO_CABLE_ID, written: "Lightning cable 1 m", price: "7,50" },
];

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

// The same words as two of the seed's search fixtures: one the catalog answers and one it cannot.
const SEARCHES = [
  {
    words: "iphone 13 screen protector",
    result: `Found, ${euros(seedProduct(DEMO_PRODUCT_ID).priceMinor)}`,
  },
  { words: "magsafe charger", result: "Not in the catalog, so the seller sees it" },
];

const COLUMNS = "grid gap-x-6 gap-y-1 @min-[640px]:grid-cols-[minmax(0,3fr)_minmax(0,5fr)]";
const LABEL = "text-[13px] leading-5 text-zinc-600";
const RULE = "border-t border-zinc-900/10";

export function CarbonSheet() {
  return (
    <div className="carbon-book @container w-full max-w-[42rem]">
      {/* The filter that roughens the carbon-blue words. A browser without it shows them plain. */}
      <svg aria-hidden="true" focusable="false" width="0" height="0" className="absolute">
        <filter id="carbon-press" x="-2%" y="-20%" width="104%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" />
          <feDisplacementMap in="SourceGraphic" scale="1.3" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>

      <figure className="carbon-sheet text-zinc-900">
        <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 pt-4 pb-3 sm:px-6">
          <span className="font-medium">
            Demo Phone Workshop<span className="font-normal text-zinc-600">, Liepaja</span>
          </span>
          <span className={LABEL}>Demo data, a made-up workshop</span>
        </figcaption>
        <div aria-hidden="true" className="carbon-perforation" />

        <div className="flex flex-col gap-6 px-4 pt-4 pb-4 sm:px-6 sm:pb-6">
          <div>
            <div aria-hidden="true" className={`${COLUMNS} pb-2 ${LABEL}`}>
              <span>The price list says</span>
              <span>In the catalog, after the seller checked it</span>
            </div>
            <ul>
              {LINES.map(({ id, written, price }, index) => {
                const product = seedProduct(id);
                return (
                  // A narrow sheet gets three rows, so it stays one object and not a long page.
                  <li
                    key={id}
                    className={`carbon-line ${COLUMNS} ${RULE} py-3 ${index === 3 ? "hidden @min-[640px]:grid" : ""}`}
                  >
                    <p className="carbon-words flex min-w-0 items-baseline gap-2 text-base leading-6">
                      <span className="sr-only">The price list says: </span>
                      <span className="min-w-0">{written}</span>
                      <span
                        aria-hidden="true"
                        className="min-w-4 flex-1 border-b border-dotted border-current opacity-50"
                      />
                      <span>{price}</span>
                    </p>
                    <div className="min-w-0">
                      <p className="flex items-baseline justify-between gap-4 text-sm leading-6">
                        <span className="sr-only">In the catalog: </span>
                        <span className="min-w-0 font-medium">{product.title}</span>
                        <span className="shrink-0 tabular-nums">{euros(product.priceMinor)}</span>
                      </p>
                      <p className={LABEL}>{catalogMeta(product)}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          <div>
            <p className={`pb-2 ${LABEL}`}>A buyer’s assistant searched for</p>
            <ul>
              {SEARCHES.map(({ words, result }) => (
                <li key={words} className={`carbon-line ${COLUMNS} ${RULE} items-baseline py-3`}>
                  <p className="carbon-words min-w-0 text-base leading-6">{words}</p>
                  <p className="min-w-0 text-sm leading-6 tabular-nums">{result}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </figure>
    </div>
  );
}
