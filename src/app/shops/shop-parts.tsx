import { minorToDecimal } from "@/server/domain/money";
import { publicOrigin } from "@/server/public-origin";
import type {
  DescriptionLanguage,
  StorefrontProduct,
  StorefrontShop,
} from "@/server/services/storefront";

export const SECONDARY_TEXT = "text-zinc-600 dark:text-zinc-400";

// One column for every public page, so the left edge stays put from a shop to a product to a result.
export const PAGE_COLUMN = "mx-auto flex w-full max-w-3xl flex-col px-4 py-8 sm:px-6";

export const QUIET_LINK = `${SECONDARY_TEXT} underline underline-offset-4 transition-colors hover:text-foreground`;

export function languageFrom(value: string | string[] | undefined): DescriptionLanguage {
  return value === "lv" ? "lv" : "en";
}

export function formatPrice(minor: number, currency: string): string {
  return `${minorToDecimal(minor, currency)} ${currency}`;
}

export function ShopHeading({ shop }: { shop: StorefrontShop }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h1 className="text-3xl font-medium break-words sm:text-4xl">{shop.name}</h1>
      {shop.location ? <p className={SECONDARY_TEXT}>{shop.location}</p> : null}
    </div>
  );
}

export function ProductText({
  product,
  className = "",
}: {
  product: StorefrontProduct;
  className?: string;
}) {
  if (!product.description) {
    return null;
  }
  return (
    <p
      lang={product.descriptionLanguage ?? undefined}
      className={`max-w-prose break-words text-pretty ${SECONDARY_TEXT} ${className}`}
    >
      {product.description}
    </p>
  );
}

// How long a repair takes and what it costs to hold the time, where a service states them.
export function ServiceTerms({
  product,
  className = "",
}: {
  product: StorefrontProduct;
  className?: string;
}) {
  const terms = [
    product.serviceDurationMinutes ? `About ${product.serviceDurationMinutes} minutes.` : null,
    product.depositMinor !== null
      ? `${formatPrice(product.depositMinor, product.currency)} deposit when you book.`
      : null,
  ].filter(Boolean);
  if (terms.length === 0) {
    return null;
  }
  return <p className={`tabular-nums ${SECONDARY_TEXT} ${className}`}>{terms.join(" ")}</p>;
}

function connectorUrl(): string | null {
  try {
    return `${publicOrigin()}/mcp`;
  } catch {
    return null;
  }
}

// A service is sold by booking a slot, and that flow belongs to the assistant connector. This page
// only points there, so there is one booking flow with one set of rules.
export function BookingNote({ shopName }: { shopName: string }) {
  const url = connectorUrl();
  return (
    <div className={`flex max-w-prose flex-col gap-2 text-pretty ${SECONDARY_TEXT}`}>
      <p>
        To book, ask your assistant, such as Claude or ChatGPT, for a free slot at {shopName}. You
        pay the deposit in PayPal.
      </p>
      {url ? (
        <p>
          Your assistant needs the AgentShelf connector at
          <span className="block break-words text-foreground select-all">{url}</span>
        </p>
      ) : (
        <p>Your assistant needs the AgentShelf connector.</p>
      )}
    </div>
  );
}
