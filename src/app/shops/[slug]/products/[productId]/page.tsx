import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache, Suspense } from "react";

import { getDb } from "@/server/db";
import { ServiceError } from "@/server/errors";
import { getStorefrontProduct, type DescriptionLanguage } from "@/server/services/storefront";

import {
  BookingNote,
  PAGE_COLUMN,
  ProductText,
  QUIET_LINK,
  SECONDARY_TEXT,
  ServiceTerms,
  formatPrice,
  languageFrom,
} from "../../../shop-parts";
import { BuyPanel } from "./buy-panel";

type PageProps = {
  params: Promise<{ slug: string; productId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// The title and the page read the same product, so one request reads it once.
const loadProduct = cache((slug: string, productId: string, language: DescriptionLanguage) =>
  getStorefrontProduct(getDb(), slug, productId, language),
);

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { slug, productId } = await params;
  const language = languageFrom((await searchParams).lang);
  try {
    const { shop, product } = await loadProduct(slug, productId, language);
    return { title: `${product.title} | ${shop.name}` };
  } catch (error) {
    if (error instanceof ServiceError) {
      return { title: "Product not found | AgentShelf", robots: { index: false } };
    }
    throw error;
  }
}

async function Product({ params, searchParams }: PageProps) {
  const { slug, productId } = await params;
  const language = languageFrom((await searchParams).lang);

  let page;
  try {
    page = await loadProduct(slug, productId, language);
  } catch (error) {
    if (
      error instanceof ServiceError &&
      (error.code === "SHOP_NOT_FOUND" || error.code === "PRODUCT_NOT_FOUND")
    ) {
      notFound();
    }
    throw error;
  }
  const { shop, product, paypalClientId } = page;
  const shopHref = `/shops/${shop.slug}${language === "lv" ? "?lang=lv" : ""}`;

  let action;
  if (product.availability !== "available") {
    action = <p className="text-doubt">This is not available right now. Please check back later.</p>;
  } else if (product.kind === "service") {
    action = <BookingNote shopName={shop.name} />;
  } else if (!paypalClientId) {
    action = (
      <p className="text-pretty text-doubt">
        Payment is not set up for this shop yet, so this cannot be bought here. Please come back
        later.
      </p>
    );
  } else {
    action = (
      <BuyPanel
        slug={shop.slug}
        productId={product.id}
        currency={product.currency}
        clientId={paypalClientId}
      />
    );
  }

  return (
    <div className={`${PAGE_COLUMN} gap-8`}>
      <Link href={shopHref} className={`self-start text-sm ${QUIET_LINK}`}>
        Back to {shop.name}
      </Link>
      <div className="flex flex-col gap-4">
        {/* The same line as on the shop's price list, set large: the name, and the price in a column
            of its own beside it. On a phone the price follows the seller. */}
        <header className="grid gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline sm:gap-x-8">
          <h1 className="text-3xl font-medium text-balance break-words">{product.title}</h1>
          <p className={`text-sm sm:col-start-1 sm:row-start-2 ${SECONDARY_TEXT}`}>
            Sold by {shop.name}
            {shop.location ? `, ${shop.location}` : ""}
          </p>
          <p className="mt-3 text-3xl font-medium whitespace-nowrap tabular-nums sm:col-start-2 sm:row-start-1 sm:mt-0">
            {formatPrice(product.priceMinor, product.currency)}
          </p>
        </header>
        <ProductText product={product} />
        {product.kind === "service" ? <ServiceTerms product={product} /> : null}
      </div>
      <div className="border-t border-zinc-200 pt-6 dark:border-zinc-800">
        <div className="flex max-w-prose flex-col gap-4">
          {product.kind === "product" && product.availability === "available" && paypalClientId ? (
            <p className={`text-pretty ${SECONDARY_TEXT}`}>
              One item. You approve the payment in PayPal, and the money goes directly to{" "}
              {shop.name}.
            </p>
          ) : null}
          {action}
        </div>
      </div>
    </div>
  );
}

export default function ProductPage(props: PageProps) {
  return (
    <Suspense fallback={<p className={`${PAGE_COLUMN} ${SECONDARY_TEXT}`}>Loading this product</p>}>
      <Product {...props} />
    </Suspense>
  );
}
