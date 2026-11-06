import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { getDb } from "@/server/db";
import { ServiceError } from "@/server/errors";
import { getStorefrontProduct } from "@/server/services/storefront";

import {
  BookingNote,
  ProductText,
  formatPrice,
  languageFrom,
} from "../../../shop-parts";
import { BuyPanel } from "./buy-panel";

type PageProps = {
  params: Promise<{ slug: string; productId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = { title: "Buy | AgentShelf" };

async function Product({ params, searchParams }: PageProps) {
  const { slug, productId } = await params;
  const language = languageFrom((await searchParams).lang);

  let page;
  try {
    page = await getStorefrontProduct(getDb(), slug, productId, language);
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
  if (product.kind === "service") {
    action = <BookingNote shopName={shop.name} />;
  } else if (product.availability !== "available") {
    action = <p className="text-doubt">This is not available right now. Please check back later.</p>;
  } else if (!paypalClientId) {
    action = (
      <p className="text-doubt">
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
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-8 sm:px-6">
      <Link
        href={shopHref}
        className="self-start text-sm text-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        Back to {shop.name}
      </Link>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight break-words">{product.title}</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Sold by {shop.name}
          {shop.location ? `, ${shop.location}` : ""}
        </p>
        <ProductText product={product} />
      </div>
      <p className="font-mono text-2xl">{formatPrice(product.priceMinor, product.currency)}</p>
      {product.kind === "product" && product.availability === "available" && paypalClientId ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          One item. You approve the payment in PayPal, and the money goes directly to {shop.name}.
        </p>
      ) : null}
      {action}
    </div>
  );
}

export default function ProductPage(props: PageProps) {
  return (
    <Suspense
      fallback={<p className="px-6 py-8 text-zinc-600 dark:text-zinc-400">Loading this product</p>}
    >
      <Product {...props} />
    </Suspense>
  );
}
