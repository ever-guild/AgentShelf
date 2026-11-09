import "server-only";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { currentSeller } from "@/server/auth/current-seller";
import { enrichCatalogProduct } from "@/server/channel3/client";
import { catalogEnrichmentRequest } from "@/server/contracts/catalog-enrichment";
import { getDb } from "@/server/db";
import { products } from "@/server/db/schema";
import { ServiceError } from "@/server/errors";
import { errorResponse, readJsonWithin } from "@/server/http";
import { ownerIdentityRuntime } from "@/server/seller-identity/runtime";

interface RouteParams {
  params: Promise<{ id: string }>;
}

async function handleEnrichment(
  request: Request,
  paramsPromise: Promise<{ id: string }>,
  queryOverride?: string,
) {
  const shop = await currentSeller(request);
  const { id } = await paramsPromise;
  const shopId = (shop as { shopId?: string }).shopId ?? shop.id;

  const idParsed = z.string().uuid().safeParse(id);
  if (!idParsed.success) {
    throw new ServiceError("PRODUCT_NOT_FOUND", "This product is not in your catalog.");
  }

  const db = getDb();
  const [product] = await db
    .select({
      id: products.id,
      title: products.title,
      shopId: products.shopId,
    })
    .from(products)
    .where(and(eq(products.id, idParsed.data), eq(products.shopId, shopId)));

  if (!product) {
    throw new ServiceError("PRODUCT_NOT_FOUND", "This product is not in your catalog.");
  }

  if ((process.env.CHANNEL3_API_KEY ?? "").trim()) {
    const allowed = await ownerIdentityRuntime().limiter.consume(
      `channel3-enrichment:${shopId}`,
      10,
      60 * 60_000,
      new Date(),
    );
    if (!allowed) {
      throw new ServiceError("AI_LIMIT_REACHED", "Catalog enrichment request limit reached. Try again later.");
    }
  }

  const result = await enrichCatalogProduct({
    productId: product.id,
    productTitle: product.title,
    query: queryOverride,
    shopCurrency: shop.currency,
  });

  return Response.json(result);
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("query") || undefined;
    if (query && !catalogEnrichmentRequest.safeParse({ query }).success) {
      throw new ServiceError("INVALID_INPUT", "The request is not valid.");
    }
    return await handleEnrichment(request, params, query);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    let query: string | undefined;
    if (request.body) {
      const body = await readJsonWithin(request);
      const parsed = catalogEnrichmentRequest.safeParse(body);
      if (!parsed.success) {
        throw new ServiceError("INVALID_INPUT", "The request is not valid.");
      }
      query = parsed.data.query;
    }

    return await handleEnrichment(request, params, query);
  } catch (error) {
    return errorResponse(error);
  }
}
