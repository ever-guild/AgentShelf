import { minorToDecimal } from "@/server/domain/money";
import { publicOrigin } from "@/server/public-origin";
import type {
  DescriptionLanguage,
  StorefrontProduct,
  StorefrontShop,
} from "@/server/services/storefront";

export function languageFrom(value: string | string[] | undefined): DescriptionLanguage {
  return value === "lv" ? "lv" : "en";
}

export function formatPrice(minor: number, currency: string): string {
  return `${minorToDecimal(minor, currency)} ${currency}`;
}

export function ShopHeading({ shop }: { shop: StorefrontShop }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-3xl font-semibold tracking-tight break-words">{shop.name}</h1>
      {shop.location ? (
        <p className="text-zinc-600 dark:text-zinc-400">{shop.location}</p>
      ) : null}
    </div>
  );
}

export function ProductText({ product }: { product: StorefrontProduct }) {
  if (!product.description) {
    return null;
  }
  return (
    <p
      lang={product.descriptionLanguage ?? undefined}
      className="break-words text-zinc-600 dark:text-zinc-400"
    >
      {product.description}
    </p>
  );
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
    <p className="text-sm text-zinc-600 dark:text-zinc-400">
      To book, ask your assistant, such as Claude or ChatGPT, for a free slot at {shopName}. It needs
      the AgentShelf connector
      {url ? (
        <>
          {" "}
          at <span className="font-mono break-all">{url}</span>
        </>
      ) : null}
      . You pay the deposit in PayPal.
    </p>
  );
}
