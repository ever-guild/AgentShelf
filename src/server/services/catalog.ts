import "server-only";

import { and, asc, desc, eq, like, lte, sql, type SQLWrapper } from "drizzle-orm";

import {
  getPublishedProductInput,
  listPublishedProductsInput,
  searchProductsInput,
  type ProductSummary,
} from "../contracts/commerce";
import type { Db } from "../db/client";
import { products, shops } from "../db/schema";
import { ServiceError, parseInput } from "../errors";

// An explicit list, so a new shop or product column is private until someone adds it here.
const summaryColumns = {
  productId: products.id,
  shopId: products.shopId,
  shopName: shops.name,
  location: shops.location,
  kind: products.kind,
  title: products.title,
  description: products.description,
  priceMinor: products.priceMinor,
  currency: shops.currency,
  availability: products.availability,
  serviceDurationMinutes: products.serviceDurationMinutes,
  depositMinor: products.depositMinor,
};

type SummaryRow = Omit<ProductSummary, "priceMinor"> & {
  priceMinor: number | null;
};

function toSummary(row: SummaryRow): ProductSummary {
  if (row.priceMinor === null) {
    // Unreachable while the products_published_requires_price constraint holds.
    throw new Error(`Published product ${row.productId} has no price`);
  }
  return { ...row, priceMinor: row.priceMinor };
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
): Promise<ProductSummary[]> {
  const { shopId } = parseInput(listPublishedProductsInput, rawInput);
  await assertShopExists(db, shopId);
  const rows = await db
    .select(summaryColumns)
    .from(products)
    .innerJoin(shops, eq(products.shopId, shops.id))
    .where(and(eq(products.shopId, shopId), eq(products.status, "published")))
    .orderBy(asc(products.title));
  return rows.map(toSummary);
}

export async function getPublishedProduct(
  db: Db,
  rawInput: unknown,
): Promise<ProductSummary> {
  const { shopId, productId } = parseInput(getPublishedProductInput, rawInput);
  await assertShopExists(db, shopId);
  const [row] = await db
    .select(summaryColumns)
    .from(products)
    .innerJoin(shops, eq(products.shopId, shops.id))
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
  return toSummary(row);
}

// Deterministic text matching across all shops: every meaningful word of the query must
// appear in the product or shop text. Words only ever hold letters and digits, so they
// cannot act as LIKE wildcards. Latvian letters are folded on both sides, so "Liepāja" and
// "Liepaja" match each other.
const STOP_WORDS = new Set(
  "a an and at for from in near of on the to with".split(" "),
);
const MAX_SEARCH_WORDS = 12;
const FOLD_FROM = "āčēģīķļņšūž";
const FOLD_TO = "acegiklnsuz";

function foldLatin(text: string): string {
  return text
    .toLowerCase()
    .replace(/[āčēģīķļņšūž]/g, (letter) => FOLD_TO[FOLD_FROM.indexOf(letter)]);
}

function foldedColumn(expression: SQLWrapper) {
  return sql`translate(lower(${expression}), ${FOLD_FROM}, ${FOLD_TO})`;
}

function searchWords(text: string): string[] {
  const words = foldLatin(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const meaningful = words.filter((word) => !STOP_WORDS.has(word));
  return (meaningful.length > 0 ? meaningful : words).slice(0, MAX_SEARCH_WORDS);
}

export async function searchProducts(
  db: Db,
  rawInput: unknown,
): Promise<{ products: ProductSummary[] }> {
  const input = parseInput(searchProductsInput, rawInput);
  const queryWords = searchWords(input.query);
  const locationWords = input.location ? searchWords(input.location) : [];
  if (queryWords.length === 0 || (input.location && locationWords.length === 0)) {
    return { products: [] };
  }

  const searchable = foldedColumn(
    sql`concat_ws(' ', ${products.title}, ${products.description}, ${shops.name}, ${shops.location})`,
  );
  const location = foldedColumn(sql`coalesce(${shops.location}, '')`);
  const title = foldedColumn(products.title);

  const rows = await db
    .select(summaryColumns)
    .from(products)
    .innerJoin(shops, eq(products.shopId, shops.id))
    .where(
      and(
        eq(products.status, "published"),
        ...queryWords.map((word) => like(searchable, `%${word}%`)),
        ...locationWords.map((word) => like(location, `%${word}%`)),
        input.maxPriceMinor === undefined
          ? undefined
          : lte(products.priceMinor, input.maxPriceMinor),
        input.currency ? eq(shops.currency, input.currency) : undefined,
      ),
    )
    .orderBy(
      asc(products.availability),
      desc(sql`${and(...queryWords.map((word) => like(title, `%${word}%`)))}`),
      asc(products.priceMinor),
      asc(products.id),
    )
    .limit(input.limit);
  return { products: rows.map(toSummary) };
}
