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
import { createMerchantConnectionRuntime } from "../paypal/merchant-connection-runtime";

const REVIEW_PATH = "/seller/imports";

export function createSellerAgentServices(input: {
  db: Db;
  identity: IdentityStore;
  shopId?: string;
  allowShopCreation?: boolean;
  grantTokenFromRequest: (extra: unknown) => string | undefined;
  paypalConnection?: SellerAgentServices["paypalConnection"];
}): SellerAgentServices {
  const { db } = input;
  const merchantConnection = input.paypalConnection ?? createMerchantConnectionRuntime({
    pool: poolFor(db),
    identityStore: input.identity,
    env: { ...process.env, APP_ORIGIN: publicOrigin() },
  }).service;
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
      const principal = await resolveAuthorizedSellerAgent(input.identity, token, scope, requestedShopId);
      if (!principal.shopId || principal.shopId !== requestedShopId) {
        throw Object.assign(new Error("This seller authorization does not cover the requested shop."), { code: "UNAUTHORIZED" });
      }
      const grant = principal as typeof principal & { shareDataConsent?: boolean };
      if (scope === "connect_paypal" && grant.shareDataConsent !== true) {
        throw Object.assign(new Error("The owner has not authorized PayPal data sharing."), { code: "UNAUTHORIZED" });
      }
      return scope === "connect_paypal" ? { ...principal, shareDataConsent: true as const } : principal;
    },
    shopIdFromRequest: () => input.shopId,
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
      read: (principal, productId) => readStock(poolFor(db), principal, productId),
      adjust: (principal, request) => adjustInventory(poolFor(db), principal, request),
      setMode: (principal, request) => setInventoryMode(poolFor(db), principal, request.productId, request.mode === "tracked"
        ? { mode: "tracked", onHand: request.onHand!, idempotencyKey: request.idempotencyKey, reason: request.reason }
        : { mode: "untracked", idempotencyKey: request.idempotencyKey, reason: request.reason }),
    },
    paypalConnection: {
      start: (principal, request) => merchantConnection.start(principal, request),
    },
  };
}

function poolFor(db: Db) {
  return (db as Db & { $client: import("pg").Pool }).$client;
}
