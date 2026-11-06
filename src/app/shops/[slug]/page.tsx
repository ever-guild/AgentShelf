import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { getDb } from "@/server/db";
import { ServiceError } from "@/server/errors";
import {
  getStorefront,
  getStorefrontShop,
  type StorefrontProduct,
} from "@/server/services/storefront";

import {
  BookingNote,
  ProductText,
  ShopHeading,
  formatPrice,
  languageFrom,
} from "../shop-parts";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  try {
    const shop = await getStorefrontShop(getDb(), slug);
    return { title: `${shop.name} | AgentShelf` };
  } catch (error) {
    if (error instanceof ServiceError) {
      return { title: "Shop not found | AgentShelf", robots: { index: false } };
    }
    throw error;
  }
}

const ROW_CLASS = "flex flex-col gap-2 py-4";

function ProductRow({
  slug,
  product,
  acceptsPayment,
}: {
  slug: string;
  product: StorefrontProduct;
  acceptsPayment: boolean;
}) {
  const available = product.availability === "available";
  return (
    <li className={ROW_CLASS}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="min-w-0 font-medium break-words">{product.title}</h3>
        <span className="font-mono">{formatPrice(product.priceMinor, product.currency)}</span>
      </div>
      <ProductText product={product} />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className={`text-sm ${available ? "text-accepted" : "text-doubt"}`}>
          {available ? "In stock" : "Not available right now"}
        </span>
        <Link
          href={`/shops/${slug}/products/${product.id}`}
          className="text-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          {available && acceptsPayment ? "Buy" : "Details"}
          <span className="sr-only"> {product.title}</span>
        </Link>
      </div>
    </li>
  );
}

function ServiceRow({ product }: { product: StorefrontProduct }) {
  return (
    <li className={ROW_CLASS}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="min-w-0 font-medium break-words">{product.title}</h3>
        <span className="font-mono">{formatPrice(product.priceMinor, product.currency)}</span>
      </div>
      <ProductText product={product} />
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {product.serviceDurationMinutes ? `About ${product.serviceDurationMinutes} minutes. ` : ""}
        {product.depositMinor !== null
          ? `${formatPrice(product.depositMinor, product.currency)} deposit when you book.`
          : ""}
        {product.availability === "available" ? "" : " Not available right now."}
      </p>
    </li>
  );
}

function LanguageChoice({ slug, language }: { slug: string; language: "en" | "lv" }) {
  const linkClass =
    "underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";
  return (
    <p className="text-sm text-zinc-600 dark:text-zinc-400">
      {language === "lv" ? (
        <Link href={`/shops/${slug}`} className={linkClass} hrefLang="en">
          Show descriptions in English
        </Link>
      ) : (
        <Link href={`/shops/${slug}?lang=lv`} className={linkClass} hrefLang="lv" lang="lv">
          Rādīt aprakstus latviešu valodā
        </Link>
      )}
    </p>
  );
}

async function Shop({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const language = languageFrom((await searchParams).lang);

  let storefront;
  try {
    storefront = await getStorefront(getDb(), slug, language);
  } catch (error) {
    if (error instanceof ServiceError && error.code === "SHOP_NOT_FOUND") {
      notFound();
    }
    throw error;
  }
  const { shop, acceptsPayment, hasLatvian, products } = storefront;
  const forSale = products.filter((product) => product.kind === "product");
  const services = products.filter((product) => product.kind === "service");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-3">
        <ShopHeading shop={shop} />
        {hasLatvian ? <LanguageChoice slug={shop.slug} language={language} /> : null}
        {acceptsPayment ? (
          <p className="max-w-prose text-zinc-600 dark:text-zinc-400">
            You pay {shop.name} directly through PayPal, and you approve every payment there.
          </p>
        ) : (
          <p className="max-w-prose text-doubt">
            Payment is not set up for this shop yet, so you can look but not buy. Please come back
            later.
          </p>
        )}
      </header>

      {products.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          This shop has not published anything yet. Please come back later.
        </p>
      ) : null}

      {forSale.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Products</h2>
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {forSale.map((product) => (
              <ProductRow
                key={product.id}
                slug={shop.slug}
                product={product}
                acceptsPayment={acceptsPayment}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {services.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Repairs and services</h2>
          <BookingNote shopName={shop.name} />
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {services.map((product) => (
              <ServiceRow key={product.id} product={product} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export default function ShopPage(props: PageProps) {
  return (
    <Suspense
      fallback={<p className="px-6 py-8 text-zinc-600 dark:text-zinc-400">Loading this shop</p>}
    >
      <Shop {...props} />
    </Suspense>
  );
}
