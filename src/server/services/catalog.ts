import "server-only";

import { and, asc, eq } from "drizzle-orm";

import {
  getPublishedProductInput,
  listPublishedProductsInput,
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
