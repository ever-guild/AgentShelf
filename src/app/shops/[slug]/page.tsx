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
  PAGE_COLUMN,
  ProductText,
  QUIET_LINK,
  SECONDARY_TEXT,
  ServiceTerms,
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

// A line of a price list: the name on the left, and the price in a column of its own that a long name
// wraps beside instead of pushing onto the next line.
const ROW_CLASS = "grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 gap-y-1 py-4";
const LIST_CLASS =
  "divide-y divide-zinc-200 border-t border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800";
const PRICE_CLASS = "font-medium whitespace-nowrap tabular-nums";

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
  const canBuy = available && acceptsPayment;
  return (
    <li className={ROW_CLASS}>
      <h3 className="font-medium break-words">{product.title}</h3>
      <span className={PRICE_CLASS}>{formatPrice(product.priceMinor, product.currency)}</span>
      <ProductText product={product} className="col-span-2" />
      <span className={`mt-1 text-sm ${available ? SECONDARY_TEXT : "text-doubt"}`}>
        {available ? "In stock" : "Not available right now"}
      </span>
      <Link
        href={`/shops/${slug}/products/${product.id}`}
        className={
          canBuy
            ? "mt-1 justify-self-end font-medium underline underline-offset-4 transition-colors hover:text-zinc-600 dark:hover:text-zinc-400"
            : `mt-1 justify-self-end ${QUIET_LINK}`
        }
      >
        {canBuy ? "Buy" : "Details"}
        <span className="sr-only"> {product.title}</span>
      </Link>
    </li>
  );
}

function ServiceRow({ product }: { product: StorefrontProduct }) {
  return (
    <li className={ROW_CLASS}>
      <h3 className="font-medium break-words">{product.title}</h3>
      <span className={PRICE_CLASS}>{formatPrice(product.priceMinor, product.currency)}</span>
      <ProductText product={product} className="col-span-2" />
      <ServiceTerms product={product} className="col-span-2 mt-1 text-sm" />
      {product.availability === "available" ? null : (
        <p className="col-span-2 text-sm text-doubt">Not available right now</p>
      )}
    </li>
  );
}

function LanguageChoice({ slug, language }: { slug: string; language: "en" | "lv" }) {
  return (
    <p className="text-sm">
      {language === "lv" ? (
        <Link href={`/shops/${slug}`} className={QUIET_LINK} hrefLang="en">
          Show descriptions in English
        </Link>
      ) : (
        <Link href={`/shops/${slug}?lang=lv`} className={QUIET_LINK} hrefLang="lv" lang="lv">
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
    <div className={`${PAGE_COLUMN} gap-12`}>
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <ShopHeading shop={shop} />
          {hasLatvian ? <LanguageChoice slug={shop.slug} language={language} /> : null}
        </div>
        {acceptsPayment ? (
          <p className={`max-w-prose text-pretty ${SECONDARY_TEXT}`}>
            You pay {shop.name} directly through PayPal, and you approve every payment there.
          </p>
        ) : (
          <p className="max-w-prose text-pretty text-doubt">
            Payment is not set up for this shop yet, so you can look but not buy. Please come back
            later.
          </p>
        )}
      </header>

      {products.length === 0 ? (
        <p className={SECONDARY_TEXT}>
          This shop has not published anything yet. Please come back later.
        </p>
      ) : null}

      {forSale.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Products</h2>
          <ul className={LIST_CLASS}>
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
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Repairs and services</h2>
          <BookingNote shopName={shop.name} />
          <ul className={`${LIST_CLASS} mt-1`}>
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
    <Suspense fallback={<p className={`${PAGE_COLUMN} ${SECONDARY_TEXT}`}>Loading this shop</p>}>
      <Shop {...props} />
    </Suspense>
  );
}
