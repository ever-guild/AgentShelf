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
    return await handleEnrichment(request, params, query);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    let query: string | undefined;
    try {
      const body = await readJsonWithin(request);
      if (body && typeof body === "object") {
        const parsed = catalogEnrichmentRequest.safeParse(body);
        if (parsed.success && parsed.data.query) {
          query = parsed.data.query;
        }
      }
    } catch {
      // Body is optional
    }

    return await handleEnrichment(request, params, query);
  } catch (error) {
    return errorResponse(error);
  }
}
