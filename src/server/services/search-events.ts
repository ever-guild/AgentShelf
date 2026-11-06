import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, lt, or, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { productSearchTerms, products, searchEvents, shops } from "../db/schema";
import {
  currentTerms,
  inLocation,
  matchesListing,
  matchesPlace,
  type ReadQuery,
} from "./search-query";

// The record of what buyers looked for. Only the normalized query and its filters are stored, never
// who asked. docs/architecture.md has the attribution rule in words.

const MAX_ATTRIBUTED_SHOPS = 5;
const MAX_BASIS_PRODUCTS = 5;
const RETENTION = sql`interval '90 days'`;

export type SearchFilters = {
  maxPriceMinor?: number;
  currency?: string;
  kind?: "product" | "service";
};

type Attribution = { shopId: string; words: string[]; productIds: string[] };

// A miss belongs to a seller only if that seller's listings already share at least half of what was
// asked for, and at least one word, within the place, currency and kind asked for. A word naming the
// shop's own place says nothing about the item, so it is left out of the count. A maximum price does
// not rule a shop out, because selling the same thing above the budget is exactly what a seller
// wants to hear about. Everything else is a global miss, and tells no seller anything.
async function attributeMiss(
  db: Db,
  query: ReadQuery,
  filters: SearchFilters,
): Promise<Attribution[]> {
  const { words } = query;
  const listed = sql.join(
    words.map((word) => sql`bool_or(${matchesListing(word, true)})`),
    sql`, `,
  );
  const placed = sql.join(
    words.map((word) => sql`bool_or(${matchesPlace(word, true)})`),
    sql`, `,
  );
  const anyWord = or(...words.map((word) => matchesListing(word, true)));

  const rows = await db
    .select({
      shopId: products.shopId,
      listed: sql<boolean[]>`ARRAY[${listed}]`,
      placed: sql<boolean[]>`ARRAY[${placed}]`,
      productIds: sql<string[] | null>`(array_agg(${products.id} ORDER BY ${products.id}) FILTER (WHERE ${anyWord}))[1:${sql.raw(String(MAX_BASIS_PRODUCTS))}]`,
    })
    .from(products)
    .innerJoin(shops, eq(products.shopId, shops.id))
    .leftJoin(productSearchTerms, currentTerms)
    .where(
      and(
        eq(products.status, "published"),
        inLocation(query.locationWords, true),
        filters.currency ? eq(shops.currency, filters.currency) : undefined,
        filters.kind ? eq(products.kind, filters.kind) : undefined,
      ),
    )
    .groupBy(products.shopId);

  return rows
    .flatMap((row): Attribution[] => {
      const shared = words.filter((_, index) => row.listed[index]);
      const aboutTheItem = words.filter((_, index) => row.listed[index] || !row.placed[index]);
      const enough = shared.length > 0 && shared.length * 2 >= aboutTheItem.length;
      return enough
        ? [{ shopId: row.shopId, words: shared, productIds: row.productIds ?? [] }]
        : [];
    })
    .sort((a, b) => b.words.length - a.words.length || a.shopId.localeCompare(b.shopId))
    .slice(0, MAX_ATTRIBUTED_SHOPS);
}

// A search still answers if this fails, because demand data is not worth losing a sale over.
export async function recordSearch(
  db: Db,
  event: {
    query: ReadQuery;
    filters: SearchFilters;
    matchedProductIds: string[];
    degraded: boolean;
  },
): Promise<void> {
  const { query, filters, matchedProductIds, degraded } = event;
  // Nothing of it survived normalization, so there is nothing to learn from it.
  if (!query.normalizedQuery) {
    return;
  }
  try {
    const attributed =
      matchedProductIds.length === 0 && !query.locationUnreadable
        ? await attributeMiss(db, query, filters)
        : [];
    const common = {
      searchId: randomUUID(),
      queryNormalized: query.normalizedQuery,
      location: query.normalizedLocation,
      maxPriceMinor: filters.maxPriceMinor,
      currency: filters.currency,
      kind: filters.kind,
      resultCount: matchedProductIds.length,
      matchedProductIds,
      degraded,
    };
    await db.insert(searchEvents).values(
      attributed.length === 0
        ? [common]
        : attributed.map((shop) => ({
            ...common,
            attributedShopId: shop.shopId,
            attributionWords: shop.words,
            attributionProductIds: shop.productIds,
          })),
    );
  } catch (error) {
    console.error("Could not record a search", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

// Fixtures are labeled demo data, not anyone's activity, so they stay.
export async function pruneSearchEvents(db: Db): Promise<void> {
  await db
    .delete(searchEvents)
    .where(
      and(
        eq(searchEvents.origin, "observed"),
        lt(searchEvents.createdAt, sql`now() - ${RETENTION}`),
      ),
    );
}
