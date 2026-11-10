import "server-only";

import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";

import {
  getPublishedProductInput,
  listPublishedProductsInput,
  searchProductsInput,
  type ProductSummary,
} from "../contracts/commerce";
import type { Db } from "../db/client";
import { paypalFor as defaultPayPalFor, type PayPalProvider } from "../paypal/orders";
import { inventoryStock, productSearchTerms, products, shops } from "../db/schema";
import { ServiceError, parseInput } from "../errors";
import { resolvePaymentReadiness, type PaymentReadiness } from "./payment-readiness";
import { recordSearch, type SearchFilters } from "./search-events";
import { effectiveProductAvailability } from "./product-availability";
import {
  currentTerms,
  inLocation,
  matchesAnywhere,
  nearSpellingCouldHelp,
  readQuery,
  relevance,
  type ReadQuery,
} from "./search-query";

// An explicit list, so a new shop or product column is private until someone adds it here.
const summaryColumns = {
  productId: products.id,
  shopId: products.shopId,
  shopName: shops.name,
  location: shops.location,
  kind: products.kind,
  title: products.title,
  description: products.description,
  descriptionLv: products.descriptionLv,
  priceMinor: products.priceMinor,
  currency: shops.currency,
  availability: products.availability,
  inventoryMode: inventoryStock.mode,
  inventoryOnHand: inventoryStock.onHand,
  inventoryReserved: inventoryStock.reserved,
  serviceDurationMinutes: products.serviceDurationMinutes,
  depositMinor: products.depositMinor,
  // Internal: read only to resolve payment readiness, then dropped from the summary.
  paypalCredentialRef: shops.paypalCredentialRef,
  paypalMerchantId: shops.paypalMerchantId,
};

type SummaryRow = Omit<
  ProductSummary,
  "priceMinor" | "availability" | "paymentReady" | "paymentUnavailableReason"
> & {
  paypalCredentialRef: string;
  paypalMerchantId: string | null;
  priceMinor: number | null;
  availability: ProductSummary["availability"];
  inventoryMode: string | null;
  inventoryOnHand: number | null;
  inventoryReserved: number | null;
};

async function summarize(
  db: Db,
  rows: SummaryRow[],
  paypalFor: PayPalProvider,
): Promise<ProductSummary[]> {
  const readiness = await resolvePaymentReadiness(
    db,
    rows.map((row) => ({
      shopId: row.shopId,
      credentialRef: row.paypalCredentialRef,
      legacyMerchantId: row.paypalMerchantId,
    })),
    paypalFor,
  );
  return rows.map((row) => toSummary(row, readiness.get(row.shopId)!));
}

function toSummary(row: SummaryRow, payment: PaymentReadiness): ProductSummary {
  if (row.priceMinor === null) {
    // Unreachable while the products_published_requires_price constraint holds.
    throw new Error(`Published product ${row.productId} has no price`);
  }
  const {
    inventoryMode,
    inventoryOnHand,
    inventoryReserved,
    ...summary
  } = row;
  // Payment routing columns were read only to resolve readiness and never reach the summary.
  delete (summary as Partial<SummaryRow>).paypalCredentialRef;
  delete (summary as Partial<SummaryRow>).paypalMerchantId;
  return {
    ...summary,
    ...payment,
    availability: effectiveProductAvailability(row.kind, row.availability, {
      mode: inventoryMode,
      onHand: inventoryOnHand,
      reserved: inventoryReserved,
    }),
    priceMinor: row.priceMinor,
  };
}

function joinInventoryStock() {
  return and(
    eq(inventoryStock.shopId, products.shopId),
    eq(inventoryStock.productId, products.id),
  );
}

async function assertShopExists(db: Db, shopId: string): Promise<void> {
  const [shop] = await db
    .select({ id: shops.id })
    .from(shops)
    .where(eq(shops.id, shopId));
  if (!shop) {
    throw new ServiceError("SHOP_NOT_FOUND", "This shop does not exist.");
  }
}

export async function listPublishedProducts(
  db: Db,
  rawInput: unknown,
  paypalFor: PayPalProvider = defaultPayPalFor,
): Promise<ProductSummary[]> {
  const { shopId } = parseInput(listPublishedProductsInput, rawInput);
  await assertShopExists(db, shopId);
  const rows = await db
    .select(summaryColumns)
    .from(products)
    .innerJoin(shops, eq(products.shopId, shops.id))
    .leftJoin(inventoryStock, joinInventoryStock())
    .where(and(eq(products.shopId, shopId), eq(products.status, "published")))
    .orderBy(asc(products.title));
  return summarize(db, rows, paypalFor);
}

export async function getPublishedProduct(
  db: Db,
  rawInput: unknown,
  paypalFor: PayPalProvider = defaultPayPalFor,
): Promise<ProductSummary> {
  const { shopId, productId } = parseInput(getPublishedProductInput, rawInput);
  await assertShopExists(db, shopId);
  const [row] = await db
    .select(summaryColumns)
    .from(products)
    .innerJoin(shops, eq(products.shopId, shops.id))
    .leftJoin(inventoryStock, joinInventoryStock())
    .where(
      and(
        eq(products.id, productId),
        eq(products.shopId, shopId),
        eq(products.status, "published"),
      ),
    );
  if (!row) {
    throw new ServiceError(
      "PRODUCT_NOT_FOUND",
      "This shop has no published product with that identifier.",
    );
  }
  return (await summarize(db, [row], paypalFor))[0];
}

const DEGRADED_NOTICE =
  "Some listings have no search terms yet, so they can only be found by the words in their own text. A different wording may find more, and no result does not prove that nothing is on sale.";

function hardFilters(query: ReadQuery, filters: SearchFilters, near: boolean) {
  return and(
    eq(products.status, "published"),
    inLocation(query.locationWords, near),
    filters.maxPriceMinor === undefined
      ? undefined
      : lte(products.priceMinor, filters.maxPriceMinor),
    filters.currency ? eq(shops.currency, filters.currency) : undefined,
    filters.kind ? eq(products.kind, filters.kind) : undefined,
  );
}

async function findProducts(
  db: Db,
  query: ReadQuery,
  filters: SearchFilters,
  limit: number,
  near: boolean,
  paypalFor: PayPalProvider,
): Promise<ProductSummary[]> {
  const rows = await db
    .select(summaryColumns)
    .from(products)
    .innerJoin(shops, eq(products.shopId, shops.id))
    .leftJoin(inventoryStock, joinInventoryStock())
    .leftJoin(productSearchTerms, currentTerms)
    .where(
      and(
        hardFilters(query, filters, near),
        ...query.words.map((word) => matchesAnywhere(word, near)),
      ),
    )
    .orderBy(
      asc(products.availability),
      desc(relevance(query.words)),
      asc(products.priceMinor),
      asc(products.id),
    )
    .limit(limit);
  return summarize(db, rows, paypalFor);
}

// Whether a listing these filters could reach is matching on its own words alone.
async function isDegraded(
  db: Db,
  query: ReadQuery,
  filters: SearchFilters,
  near: boolean,
): Promise<boolean> {
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .innerJoin(shops, eq(products.shopId, shops.id))
    .leftJoin(productSearchTerms, currentTerms)
    .where(and(hardFilters(query, filters, near), isNull(productSearchTerms.productId)))
    .limit(1);
  return rows.length > 0;
}

// Ranks across all shops with no model call. Every meaningful word has to match, in a listing, its
// model-suggested terms or its shop, because a loose match would hide unmet demand behind something
// the buyer did not ask for. A near spelling is tried only when exact words find nothing. Hard
// filters never loosen.
export async function searchProducts(
  db: Db,
  rawInput: unknown,
  {
    recordDemand = true,
    paypalFor = defaultPayPalFor,
  }: { recordDemand?: boolean; paypalFor?: PayPalProvider } = {},
): Promise<{
  products: ProductSummary[];
  matching: { mode: "full" | "degraded"; notice: string | null };
}> {
  const input = parseInput(searchProductsInput, rawInput);
  const query = await readQuery(db, input);
  const filters: SearchFilters = {
    maxPriceMinor: input.maxPriceMinor,
    currency: input.currency,
    kind: input.kind,
  };

  let found: ProductSummary[] = [];
  let near = false;
  if (query.words.length > 0 && !query.locationUnreadable) {
    found = await findProducts(db, query, filters, input.limit, false, paypalFor);
    if (found.length === 0 && nearSpellingCouldHelp(query)) {
      near = true;
      found = await findProducts(db, query, filters, input.limit, true, paypalFor);
    }
  }

  const degraded = await isDegraded(db, query, filters, near);
  if (recordDemand) {
    await recordSearch(db, {
      query,
      filters,
      matchedProductIds: found.map((product) => product.productId),
      degraded,
    });
  }
  return {
    products: found,
    matching: degraded
      ? { mode: "degraded", notice: DEGRADED_NOTICE }
      : { mode: "full", notice: null },
  };
}
