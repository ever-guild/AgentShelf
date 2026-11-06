import "server-only";

import { and, asc, eq, getTableColumns, type Column } from "drizzle-orm";
import type { z } from "zod";

import {
  getOrderStatusResult,
  storefrontCheckoutInput,
  storefrontCheckoutResult,
} from "../contracts/commerce";
import type { Db } from "../db/client";
import { orderLines, orders, products, shops } from "../db/schema";
import { ServiceError, parseInput } from "../errors";
import { errorResponse, readBodyWithin } from "../http";
import { paypalFor as defaultPayPalFor, type PayPalProvider } from "../paypal/orders";
import { createCheckout, type CheckoutDeps } from "./checkout";
import { getOrderStatus } from "./order-status";

// The public shop pages. Everything a page shows comes through here, as explicit fields, so a new
// shop or product column stays private until someone adds it. The merchant ID and credential
// reference are read to decide what a page may offer, and are never part of a result.

const SLUG_FORMAT = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_BODY_BYTES = 4 * 1024;

export type DescriptionLanguage = "en" | "lv";

export type StorefrontShop = {
  slug: string;
  name: string;
  location: string | null;
};

export type StorefrontProduct = {
  id: string;
  kind: "product" | "service";
  title: string;
  description: string;
  // Set when the text is known to be in this language. A source's own words may be in any.
  descriptionLanguage: DescriptionLanguage | null;
  priceMinor: number;
  currency: string;
  availability: "available" | "unavailable";
  serviceDurationMinutes: number | null;
  depositMinor: number | null;
};

export type Storefront = {
  shop: StorefrontShop;
  // False until the shop has a merchant and its PayPal app is configured.
  acceptsPayment: boolean;
  hasLatvian: boolean;
  products: StorefrontProduct[];
};

export type StorefrontProductPage = {
  shop: StorefrontShop;
  product: StorefrontProduct;
  // Public by design, and only present when this shop can really take the payment.
  paypalClientId: string | null;
};

type ProductTexts = {
  description: string;
  descriptionEn?: string | null;
  descriptionLv?: string | null;
};

// The seller's reviewed text in the language asked for, then the other reviewed text in English,
// then the source's own words. Never a machine translation made here.
export function chooseDescription(
  texts: ProductTexts,
  language: DescriptionLanguage,
): { text: string; language: DescriptionLanguage | null } {
  const latvian = texts.descriptionLv?.trim();
  const english = texts.descriptionEn?.trim();
  if (language === "lv" && latvian) {
    return { text: latvian, language: "lv" };
  }
  if (english) {
    return { text: english, language: "en" };
  }
  return { text: texts.description, language: null };
}

// Reviewed translations reach `products` through publication, in #9. Reading them by name keeps
// this page working before and after that column lands.
function reviewedTextColumns(): Record<string, Column> {
  const columns = getTableColumns(products) as unknown as Record<string, Column | undefined>;
  return Object.fromEntries(
    ["descriptionEn", "descriptionLv"].flatMap((name) => {
      const column = columns[name];
      return column ? [[name, column]] : [];
    }),
  );
}

const productColumns = {
  id: products.id,
  kind: products.kind,
  title: products.title,
  description: products.description,
  priceMinor: products.priceMinor,
  availability: products.availability,
  serviceDurationMinutes: products.serviceDurationMinutes,
  depositMinor: products.depositMinor,
};

type ProductRow = {
  id: string;
  kind: "product" | "service";
  title: string;
  description: string;
  priceMinor: number | null;
  availability: "available" | "unavailable";
  serviceDurationMinutes: number | null;
  depositMinor: number | null;
  descriptionEn?: string | null;
  descriptionLv?: string | null;
};

function toStorefrontProduct(
  row: ProductRow,
  currency: string,
  language: DescriptionLanguage,
): StorefrontProduct {
  if (row.priceMinor === null) {
    // Unreachable while the products_published_requires_price constraint holds.
    throw new Error(`Published product ${row.id} has no price`);
  }
  const description = chooseDescription(row, language);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: description.text,
    descriptionLanguage: description.language,
    priceMinor: row.priceMinor,
    currency,
    availability: row.availability,
    serviceDurationMinutes: row.serviceDurationMinutes,
    depositMinor: row.depositMinor,
  };
}

async function findShop(db: Db, slug: string) {
  const notFound = () => new ServiceError("SHOP_NOT_FOUND", "This shop does not exist.");
  if (!SLUG_FORMAT.test(slug)) {
    throw notFound();
  }
  const [shop] = await db
    .select({
      id: shops.id,
      slug: shops.slug,
      name: shops.name,
      location: shops.location,
      currency: shops.currency,
      merchantId: shops.paypalMerchantId,
      credentialRef: shops.paypalCredentialRef,
    })
    .from(shops)
    .where(eq(shops.slug, slug));
  if (!shop) {
    throw notFound();
  }
  return shop;
}

function publicShop(shop: Awaited<ReturnType<typeof findShop>>): StorefrontShop {
  return { slug: shop.slug, name: shop.name, location: shop.location };
}

function browserClientId(
  shop: Awaited<ReturnType<typeof findShop>>,
  paypalFor: PayPalProvider,
): string | null {
  return shop.merchantId ? (paypalFor(shop.credentialRef)?.clientId ?? null) : null;
}

export async function getStorefrontShop(db: Db, slug: string): Promise<StorefrontShop> {
  return publicShop(await findShop(db, slug));
}

export async function getStorefront(
  db: Db,
  slug: string,
  language: DescriptionLanguage = "en",
  paypalFor: PayPalProvider = defaultPayPalFor,
): Promise<Storefront> {
  const shop = await findShop(db, slug);
  const rows = (await db
    .select({ ...productColumns, ...reviewedTextColumns() })
    .from(products)
    .where(and(eq(products.shopId, shop.id), eq(products.status, "published")))
    .orderBy(asc(products.availability), asc(products.title), asc(products.id))) as ProductRow[];
  return {
    shop: publicShop(shop),
    acceptsPayment: browserClientId(shop, paypalFor) !== null,
    hasLatvian: rows.some((row) => Boolean(row.descriptionLv?.trim())),
    products: rows.map((row) => toStorefrontProduct(row, shop.currency, language)),
  };
}

// A product that is not published in this very shop gets the same answer as one that does not
// exist, and so does a malformed identifier.
export async function getStorefrontProduct(
  db: Db,
  slug: string,
  productId: string,
  language: DescriptionLanguage = "en",
  paypalFor: PayPalProvider = defaultPayPalFor,
): Promise<StorefrontProductPage> {
  const shop = await findShop(db, slug);
  const notFound = () =>
    new ServiceError("PRODUCT_NOT_FOUND", "This shop has no published product with that identifier.");
  if (!storefrontCheckoutInput.shape.productId.safeParse(productId).success) {
    throw notFound();
  }
  const [row] = (await db
    .select({ ...productColumns, ...reviewedTextColumns() })
    .from(products)
    .where(
      and(
        eq(products.id, productId),
        eq(products.shopId, shop.id),
        eq(products.status, "published"),
      ),
    )) as ProductRow[];
  if (!row) {
    throw notFound();
  }
  return {
    shop: publicShop(shop),
    product: toStorefrontProduct(row, shop.currency, language),
    paypalClientId: browserClientId(shop, paypalFor),
  };
}

// The same checkout as MCP, restricted to one product of the shop in the URL. The key is namespaced
// so that a browser can never reach an order made through another channel by guessing its key.
export async function createStorefrontCheckout(
  db: Db,
  slug: string,
  rawInput: unknown,
  deps: CheckoutDeps = { paypalFor: defaultPayPalFor },
): Promise<z.infer<typeof storefrontCheckoutResult>> {
  const { productId, idempotencyKey } = parseInput(storefrontCheckoutInput, rawInput);
  const shop = await findShop(db, slug);

  // Any status here: createCheckout decides whether it is on sale, and answers a repeat from the
  // stored order even if the product has changed since.
  const [owned] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.shopId, shop.id)));
  if (!owned) {
    throw new ServiceError("PRODUCT_NOT_FOUND", "A product in this order is not on sale.", {
      productId,
    });
  }

  const checkout = await createCheckout(
    db,
    {
      items: [{ productId, quantity: 1 }],
      idempotencyKey: `storefront:${idempotencyKey}`,
    },
    deps,
  );
  const [stored] = await db
    .select({ paypalOrderId: orders.paypalOrderId })
    .from(orders)
    .where(eq(orders.id, checkout.orderId));

  const capability = new URLSearchParams({
    order: checkout.orderId,
    status: checkout.statusToken,
  });
  return storefrontCheckoutResult.parse({
    paypalOrderId: stored?.paypalOrderId,
    totalMinor: checkout.totalMinor,
    currency: checkout.currency,
    approvalUrl: checkout.approvalUrl,
    returnPath: `/checkout/return?${capability}`,
    cancelPath: `/checkout/cancel?${capability}`,
  });
}

export async function storefrontCheckoutResponse(
  request: Request,
  slug: string,
  db: Db,
  deps?: CheckoutDeps,
): Promise<Response> {
  try {
    const invalid = () => new ServiceError("INVALID_INPUT", "The request is not valid.");
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      throw invalid();
    }
    const body = await readBodyWithin(request, MAX_BODY_BYTES);
    if (!body) {
      throw invalid();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      throw invalid();
    }
    return Response.json(await createStorefrontCheckout(db, slug, parsed, deps), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export type BuyerOrder = {
  paymentStatus: z.infer<typeof getOrderStatusResult>["paymentStatus"];
  totalMinor: number;
  currency: string;
  shop: { slug: string; name: string };
  lines: { title: string; quantity: number }[];
};

// What a buyer's result page shows, for the holder of the order's capability only. The state is
// stored state, so success appears only after reconciliation has verified the capture.
export async function getBuyerOrder(db: Db, rawInput: unknown): Promise<BuyerOrder> {
  const status = await getOrderStatus(db, rawInput);
  const [shop] = await db
    .select({ slug: shops.slug, name: shops.name })
    .from(orders)
    .innerJoin(shops, eq(orders.shopId, shops.id))
    .where(eq(orders.id, status.orderId));
  if (!shop) {
    throw new ServiceError(
      "ORDER_STATUS_UNAVAILABLE",
      "This order is not available with that status token.",
    );
  }
  const lines = await db
    .select({ title: orderLines.title, quantity: orderLines.quantity })
    .from(orderLines)
    .where(eq(orderLines.orderId, status.orderId))
    .orderBy(asc(orderLines.title));
  return {
    paymentStatus: status.paymentStatus,
    totalMinor: status.totalMinor,
    currency: status.currency,
    shop,
    lines,
  };
}
