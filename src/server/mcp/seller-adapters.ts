import "server-only";

import { eq } from "drizzle-orm";

import { publicOrigin } from "../public-origin";
import type { Db } from "../db/client";
import { shops } from "../db/schema";
import { resolveAuthorizedSellerAgent, createShopForAuthorizedAgent } from "../seller-identity/service";
import type { IdentityStore } from "../seller-identity/service";
import { createImport, getImport, updateImportRow, applyBulkAction, finishImportReview } from "../services/imports";
import { defaultImportDeps } from "../services/import-start";
import { getSellerCatalog, updateCatalogProduct, publishImport, defaultCatalogDeps } from "../services/seller-catalog";
import { readStock, adjustInventory, setInventoryMode } from "../inventory/postgres";
import type { SellerAgentServices } from "./seller-server";
import { merchantConnectionRuntime } from "../paypal/merchant-connection-runtime";

const REVIEW_PATH = "/seller/imports";
type MerchantRuntimeState = { service?: MerchantConnectionService; configured: boolean };
type MerchantConnectionService = NonNullable<ReturnType<typeof merchantConnectionRuntime>["service"]>;

export function createSellerAgentServices(input: {
  db: Db;
  identity: IdentityStore;
  shopId?: string;
  allowShopCreation?: boolean;
  grantTokenFromRequest: (extra: unknown) => string | undefined;
  paypalConnection?: SellerAgentServices["paypalConnection"];
}): SellerAgentServices {
  const { db } = input;
  const shopFor = async (shopId: string) => {
    const [shop] = await db.select({ id: shops.id, currency: shops.currency }).from(shops).where(eq(shops.id, shopId));
    if (!shop) throw Object.assign(new Error("The seller shop could not be found."), { code: "UNAUTHORIZED" });
    return shop;
  };
  const reviewUrl = (id: string) => new URL(`${REVIEW_PATH}/${id}`, publicOrigin()).toString();
  const viewResult = (view: Awaited<ReturnType<typeof getImport>>) => ({
    importId: view.id,
    status: view.status,
    rows: view.rows,
    publishedCount: view.publishedCount,
    reviewUrl: reviewUrl(view.id),
  });

  return {
    ...(input.allowShopCreation === false ? {} : { identity: {
      createShopForAuthorizedAgent: (token, raw) => createShopForAuthorizedAgent(
        input.identity,
        token,
        raw,
        new URL("/seller/agent-access", publicOrigin()).toString(),
      ),
    } }),
    authorizeShop: async (token, scope, requestedShopId) => {
      if (scope === "connect_paypal") {
        const principal = await resolveAuthorizedSellerAgent(input.identity, token, "connect_paypal", requestedShopId);
        if (!principal.shopId || principal.shopId !== requestedShopId || !principal.shareDataConsentAt ||
          !(principal.shareDataConsentAt instanceof Date) || Number.isNaN(principal.shareDataConsentAt.getTime())) {
          throw Object.assign(new Error("The owner has not authorized PayPal data sharing for this shop."), { code: "UNAUTHORIZED" });
        }
        return principal;
      }
      const principal = await resolveAuthorizedSellerAgent(input.identity, token, scope, requestedShopId);
      if (!principal.shopId || principal.shopId !== requestedShopId) {
        throw Object.assign(new Error("This seller authorization does not cover the requested shop."), { code: "UNAUTHORIZED" });
      }
      return principal;
    },
    ...(input.shopId ? { shopIdFromRequest: () => input.shopId } : {}),
    grantTokenFromRequest: input.grantTokenFromRequest,
    imports: {
      start: async (principal, file) => {
        const shop = await shopFor(principal.shopId);
        const bytes = Buffer.from(file.contentBase64, "base64");
        const view = await createImport(db, shop, { name: file.fileName, bytes }, defaultImportDeps());
        return { importId: view.id, status: view.status, acceptedCount: view.counts.accepted, reviewUrl: reviewUrl(view.id) };
      },
      review: async (principal, request) => {
        const shop = await shopFor(principal.shopId);
        if (request.action === "get") return viewResult(await getImport(db, shop, request.importId));
        if (request.action === "edit_row") return viewResult(await updateImportRow(db, shop, request.importId, request.rowId, request.patch));
        if (request.action === "remove_row") return viewResult(await updateImportRow(db, shop, request.importId, request.rowId, { status: "removed" }));
        if (request.action === "accept_clean" || request.action === "set_missing_currency") {
          return viewResult(await applyBulkAction(db, shop, request.importId, { action: request.action }));
        }
        await finishImportReview(db, shop, request.importId);
        return viewResult(await publishImport(db, shop, request.importId, defaultCatalogDeps));
      },
    },
    catalog: {
      supportedActions: ["list", "edit", "publish", "unpublish"],
      run: async (principal, request) => {
        const shop = await shopFor(principal.shopId);
        const catalog = request.action === "list"
          ? await getSellerCatalog(db, shop)
          : await updateCatalogProduct(db, shop, request.productId, request.action === "edit"
            ? request.patch
            : { status: request.action === "publish" ? "published" : "unpublished" }, defaultCatalogDeps);
        return {
          products: catalog.products.map((product) => ({
            id: product.id,
            kind: product.kind,
            status: product.status,
            title: product.title,
            description: product.description,
            descriptionLv: product.descriptionLv,
            price: product.price,
            deposit: product.deposit,
            serviceDurationMinutes: product.serviceDurationMinutes,
            sync: { status: product.sync.status, syncedAt: product.sync.syncedAt, problem: product.sync.problem },
          })),
          paypalSync: catalog.products.length === 0 ? "not_attempted" : catalog.products.some((p) => p.sync.status === "failed") ? "failed" : catalog.products.some((p) => p.sync.status === "pending") ? "pending" : catalog.products.every((p) => p.sync.status === "synced") ? "synced" : "not_configured",
        };
      },
    },
    stock: {
      read: async (principal, productId) => stockResult(await readStock(poolFor(db), principal, productId)),
      adjust: async (principal, request) => stockResult(await adjustInventory(poolFor(db), principal, {
        productId: request.productId,
        delta: request.delta,
        expectedVersion: request.expectedVersion,
        idempotencyKey: request.idempotencyKey,
        reason: request.reason,
      })),
      setMode: async (principal, request) => stockResult(await setInventoryMode(poolFor(db), principal, request.productId, request.mode === "tracked"
        ? { mode: "tracked", onHand: request.onHand!, idempotencyKey: request.idempotencyKey, reason: request.reason }
        : { mode: "untracked", idempotencyKey: request.idempotencyKey, reason: request.reason })),
    },
    paypalConnection: {
      start: (principal, request) => {
        if (input.paypalConnection) return input.paypalConnection.start(principal, request);
        const runtime = getMerchantRuntime();
        if (!runtime?.configured || !runtime.service) return Promise.resolve({ connection: { shopId: principal.shopId, status: "error" as const, nextAction: "contact_support" as const } });
        return runtime.service.start(principal, request);
      },
    },
  };
}

function poolFor(db: Db) {
  return (db as Db & { $client: import("pg").Pool }).$client;
}

function getMerchantRuntime(): MerchantRuntimeState | null {
  try {
    const runtime = merchantConnectionRuntime();
    return { service: runtime.service, configured: runtime.platformConfigured };
  } catch {
    // Local HTTP and incomplete sandbox settings block this capability only. Other seller MCP
    // tools remain available; the connection tool returns an explicit blocked state.
    return null;
  }
}

function stockResult<T extends { productId: string; version: number }>(stock: T) {
  const updatedAt = (stock as T & { updatedAt?: Date }).updatedAt;
  if (!(updatedAt instanceof Date)) throw new Error("The inventory service did not return its update timestamp.");
  return { ...stock, updatedAt: updatedAt.toISOString() };
}
