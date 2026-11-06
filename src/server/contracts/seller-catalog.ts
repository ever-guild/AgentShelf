import { z } from "zod";

// What a seller may do to a published catalog. Strict, so a request naming a shop, a PayPal record
// or any other unknown field is refused rather than ignored. Amounts are text and go through the
// same parser as a price list.

export const catalogProductId = z.uuid();

export const catalogProductPatch = z
  .strictObject({
    price: z.string().max(60),
    deposit: z.string().max(60),
    status: z.enum(["published", "unpublished"]),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Name something to change.");

export type CatalogProductPatch = z.infer<typeof catalogProductPatch>;

// With neither field, this sends the next products waiting. `productId` retries one product, and
// `retryFailed` puts every product that did not make it back in the queue first.
export const catalogSyncRequest = z.strictObject({
  productId: catalogProductId.optional(),
  retryFailed: z.literal(true).optional(),
});

export type CatalogSyncStatus = "pending" | "synced" | "failed" | "not_configured";

export type CatalogProductView = {
  id: string;
  kind: "product" | "service";
  status: "published" | "unpublished";
  title: string;
  description: string;
  descriptionLv: string | null;
  price: string | null;
  deposit: string | null;
  serviceDurationMinutes: number | null;
  sync: {
    status: CatalogSyncStatus;
    paypalProductId: string | null;
    syncedAt: string | null;
    problem: string | null;
  };
};

export type CatalogView = {
  shopCurrency: string;
  products: CatalogProductView[];
  // The first products by name, when a shop has more than one page holds.
  truncated: boolean;
  counts: { published: number; unpublished: number; waiting: number; unsent: number };
};

export type CatalogSyncAnswer = {
  view: CatalogView;
  // Products still waiting. `stopped` means PayPal is not answering, so asking again at once is no use.
  remaining: number;
  stopped: boolean;
};
