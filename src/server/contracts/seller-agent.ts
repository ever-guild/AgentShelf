import { z } from "zod";

// Seller-agent inputs deliberately omit shopId, prices, PayPal recipients, and credentials. The
// caller's seller grant selects the tenant; persisted shop data supplies all consequential values.
export const sellerAgentCreateShopInput = z.strictObject({
  shop: z.strictObject({
    name: z.string().trim().min(2).max(120),
    slug: z.string().trim().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    location: z.string().trim().min(2).max(160),
    currency: z.literal("EUR"),
    timezone: z.string().trim().min(1).max(80),
  }),
  idempotencyKey: z.uuid(),
});

export const sellerAgentShopResult = z.strictObject({
  shop: z.strictObject({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    location: z.string(),
    currency: z.literal("EUR"),
    timezone: z.string(),
  }),
  paymentStatus: z.literal("not_configured"),
});

export const sellerAgentImportInput = z.strictObject({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.enum(["text/csv", "application/vnd.ms-excel", "image/jpeg", "image/png", "image/webp"]),
  contentBase64: z.string().min(1).max(8_000_000),
  idempotencyKey: z.uuid(),
});

export const sellerAgentImportResult = z.strictObject({
  importId: z.uuid(),
  status: z.enum(["queued", "running", "needs_review", "failed", "completed"]),
  acceptedCount: z.number().int().nonnegative(),
  reviewUrl: z.string().url(),
});

export const sellerAgentReviewInput = z.strictObject({
  importId: z.uuid(),
  action: z.enum(["get", "accept_clean", "publish"]),
});

export const sellerAgentReviewRow = z.strictObject({
  id: z.uuid(),
  position: z.number().int().nonnegative(),
  sourceRef: z.string().max(120),
  status: z.enum(["pending", "accepted", "removed"]),
  title: z.string().nullable(),
  kind: z.enum(["product", "service"]).nullable(),
  price: z.string().nullable(),
  priceText: z.string().nullable(),
  currency: z.string().nullable(),
  serviceDurationMinutes: z.number().int().nullable(),
  deposit: z.string().nullable(),
  description: z.string().nullable(),
  descriptionEn: z.string().nullable(),
  descriptionLv: z.string().nullable(),
  issues: z.array(z.strictObject({
    code: z.string(),
    field: z.enum(["title", "description", "kind", "price", "currency", "duration", "deposit"]).nullable(),
    severity: z.enum(["blocker", "warning"]),
    message: z.string(),
  })),
});

export const sellerAgentReviewResult = z.strictObject({
  importId: z.uuid(),
  status: z.enum(["queued", "running", "needs_review", "failed", "completed"]),
  rows: z.array(sellerAgentReviewRow),
  publishedProductIds: z.array(z.uuid()),
  reviewUrl: z.string().url(),
});

export const sellerAgentCatalogInput = z.strictObject({
  action: z.enum(["list", "create", "edit", "publish", "unpublish"]),
  productId: z.uuid().optional(),
  product: z.strictObject({
    kind: z.enum(["product", "service"]),
    title: z.string().trim().min(1).max(240),
    description: z.string().max(4000).optional(),
    price: z.string().max(60),
    serviceDurationMinutes: z.number().int().min(1).max(1440).optional(),
    deposit: z.string().max(60).optional(),
  }).optional(),
  patch: z.strictObject({ price: z.string().max(60).optional(), deposit: z.string().max(60).optional() }).optional(),
}).superRefine((input, ctx) => {
  const hasProduct = input.product !== undefined;
  const hasPatch = input.patch !== undefined;
  if (input.action === "create" && (!hasProduct || input.productId !== undefined || hasPatch)) {
    ctx.addIssue({ code: "custom", message: "Create requires a new product and cannot include a product ID or patch." });
  }
  if (["edit", "publish", "unpublish"].includes(input.action) && (!input.productId || hasProduct || (input.action === "edit" ? !hasPatch : hasPatch))) {
    ctx.addIssue({ code: "custom", message: "This action requires a product ID and only accepts its relevant fields." });
  }
  if (input.action === "list" && (input.productId !== undefined || hasProduct || hasPatch)) {
    ctx.addIssue({ code: "custom", message: "Listing the catalog takes no product fields." });
  }
  if (input.action === "edit" && input.patch && Object.keys(input.patch).length === 0) {
    ctx.addIssue({ code: "custom", message: "Provide at least one field to edit." });
  }
});

export const sellerAgentCatalogProduct = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["product", "service"]),
  status: z.enum(["published", "unpublished"]),
  title: z.string(),
  description: z.string(),
  descriptionLv: z.string().nullable(),
  price: z.string().nullable(),
  deposit: z.string().nullable(),
  serviceDurationMinutes: z.number().int().nullable(),
  sync: z.strictObject({
    status: z.enum(["pending", "synced", "failed", "not_configured"]),
    syncedAt: z.string().datetime().nullable(),
    problem: z.string().nullable(),
  }),
});

export const sellerAgentCatalogResult = z.strictObject({
  products: z.array(sellerAgentCatalogProduct),
  paypalSync: z.enum(["not_attempted", "pending", "synced", "not_configured", "failed"]),
});

export const sellerAgentStockInput = z.strictObject({
  action: z.enum(["read", "adjust"]),
  productId: z.uuid(),
  delta: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
  reason: z.string().trim().min(3).max(500).optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/).optional(),
}).superRefine((input, ctx) => {
  if (input.action === "adjust" && (input.delta === undefined || input.delta === 0 || input.expectedVersion === undefined || !input.reason || !input.idempotencyKey)) {
    ctx.addIssue({ code: "custom", message: "A non-zero delta, expected version, reason and idempotency key are required to adjust stock." });
  }
  if (input.action === "read" && (input.delta !== undefined || input.expectedVersion !== undefined || input.reason !== undefined || input.idempotencyKey !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Stock reads cannot include an adjustment." });
  }
});

export const sellerAgentStockResult = z.strictObject({
  productId: z.uuid(),
  mode: z.enum(["tracked", "untracked"]),
  onHand: z.number().int().nonnegative().nullable(),
  reserved: z.number().int().nonnegative().nullable(),
  available: z.number().int().nonnegative().nullable(),
  version: z.number().int().nonnegative(),
});

export const sellerAgentPayPalConnectInput = z.strictObject({
  action: z.literal("start"),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/),
});

const sandboxPayPalUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.origin === "https://www.sandbox.paypal.com" &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.hash &&
    /^\/(?:[a-z]{2}\/)?merchantsignup\/partner\/onboardingentry$/i.test(url.pathname) &&
    url.searchParams.getAll("token").length === 1 &&
    Boolean(url.searchParams.get("token"));
}, "Expected the PayPal sandbox partner-onboarding action URL.");

export const sellerAgentPayPalConnectResult = z.strictObject({
  status: z.enum(["not_connected", "pending", "ready", "revoked", "error"]),
  nextAction: z.enum(["continue_paypal", "retry_status", "retry_connection", "contact_support"]).optional(),
  humanActionUrl: sandboxPayPalUrl.optional(),
});

export type SellerAgentCreateShopInput = z.infer<typeof sellerAgentCreateShopInput>;
export type SellerAgentShopResult = z.infer<typeof sellerAgentShopResult>;
export type SellerAgentImportInput = z.infer<typeof sellerAgentImportInput>;
export type SellerAgentImportResult = z.infer<typeof sellerAgentImportResult>;
export type SellerAgentReviewInput = z.infer<typeof sellerAgentReviewInput>;
export type SellerAgentReviewResult = z.infer<typeof sellerAgentReviewResult>;
export type SellerAgentCatalogInput = z.infer<typeof sellerAgentCatalogInput>;
export type SellerAgentCatalogResult = z.infer<typeof sellerAgentCatalogResult>;
export type SellerAgentStockInput = z.infer<typeof sellerAgentStockInput>;
export type SellerAgentStockResult = z.infer<typeof sellerAgentStockResult>;
export type SellerAgentPayPalConnectInput = z.infer<typeof sellerAgentPayPalConnectInput>;
export type SellerAgentPayPalConnectResult = z.infer<typeof sellerAgentPayPalConnectResult>;

export const SELLER_AGENT_TOOL_NAMES = {
  createShop: "seller_create_shop",
  importPriceList: "seller_import_price_list",
  reviewImport: "seller_review_import",
  manageCatalog: "seller_manage_catalog",
  manageStock: "seller_manage_stock",
  connectPayPal: "seller_connect_paypal",
} as const;
