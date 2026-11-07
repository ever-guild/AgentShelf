import "server-only";

import { and, asc, count, eq, inArray, ne, or, sql } from "drizzle-orm";

import { importId } from "../contracts/imports";
import type { ImportView } from "../contracts/imports";
import {
  catalogProductId,
  catalogProductPatch,
  catalogSyncRequest,
  type CatalogProductView,
  type CatalogSyncAnswer,
  type CatalogSyncStatus,
  type CatalogView,
} from "../contracts/seller-catalog";
import type { Db } from "../db/client";
import { importJobs, importRows, products, shops } from "../db/schema";
import { ServiceError, parseInput } from "../errors";
import { hasBlocker, minorToText, rowIssues } from "../imports/draft-rows";
import { parsePriceText, priceProblemMessage } from "../imports/price-text";
import { buildCatalogRecord } from "../paypal/catalog";
import {
  merchantEligibilityPool,
  resolveShopPayPalRoute,
} from "../paypal/merchant-eligibility";
import {
  describePayPalFailure,
  paypalFor,
  type PayPalProvider,
  type PayPalSellerApi,
} from "../paypal/orders";
import { getImport, type SellerShop } from "./imports";
import type { Tx } from "./payment-reconciliation";
import { queueSearchIndexing } from "./search-index";

// Publication and the seller's catalog. A product is discoverable once it is `published` here. The
// PayPal Catalog record is a separate per-product state with its own retry, because Orders v2 does
// not need one. Every function takes the shop from the seller's session, and a product in another
// shop gets the same answer as one that does not exist.

// Small enough that a seller sees progress and a request ends well before anything times it out.
const SYNC_BATCH = 10;
const LIST_LIMIT = 1000;

export type CatalogChange = {
  shopId: string;
  productIds: string[];
  change: "published" | "edited" | "unpublished";
};

export type CatalogDeps = {
  paypalFor: PayPalProvider;
  // Runs inside the transaction of every change to what buyers can find, so this is the one place
  // the search index hears about them. If it throws, the change does not happen, so it only writes
  // to a queue, and a model is asked later.
  onCatalogChange: (tx: Tx, change: CatalogChange) => Promise<void>;
};

export const defaultCatalogDeps: CatalogDeps = {
  paypalFor,
  onCatalogChange: queueSearchIndexing,
};

type ProductRecord = typeof products.$inferSelect;

type SyncFailure = "timeout" | "unavailable" | "not_authorized" | "rejected" | "unexpected_answer";

const SYNC_PROBLEMS: Record<SyncFailure, string> = {
  timeout: "PayPal did not answer in time. Try again. It cannot create a second record.",
  unavailable: "PayPal could not be reached. Try again. It cannot create a second record.",
  not_authorized:
    "PayPal refused this shop's credentials. Check that its PayPal app can manage products, then try again.",
  rejected: "PayPal did not accept this record. Try again, and if it repeats, tell the AgentShelf team.",
  unexpected_answer:
    "PayPal answered with a different record than the one requested. Try again, and if it repeats, tell the AgentShelf team.",
};

const NOT_CONFIGURED =
  "This shop has no PayPal credentials on this server yet, so nothing can go to PayPal Catalog. Buyers can still find your products.";

function syncProblem(row: ProductRecord): string | null {
  if (row.paypalSyncStatus === "not_configured") {
    return NOT_CONFIGURED;
  }
  if (row.paypalSyncStatus === "failed") {
    return SYNC_PROBLEMS[row.paypalSyncError as SyncFailure] ?? SYNC_PROBLEMS.unavailable;
  }
  return null;
}

function toProductView(row: ProductRecord): CatalogProductView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status === "published" ? "published" : "unpublished",
    title: row.title,
    description: row.description,
    descriptionLv: row.descriptionLv,
    price: minorToText(row.priceMinor),
    deposit: minorToText(row.depositMinor),
    serviceDurationMinutes: row.serviceDurationMinutes,
    sync: {
      status: row.paypalSyncStatus,
      paypalProductId: row.paypalProductId,
      syncedAt: row.paypalSyncedAt?.toISOString() ?? null,
      problem: syncProblem(row),
    },
  };
}

const notFound = () =>
  new ServiceError("PRODUCT_NOT_FOUND", "This product is not in your catalog.");

type ShopPayPalAccount = { shopId: string; credentialRef: string; merchantId: string | null };

// The one rule for whether a record can go to PayPal Catalog: a route to the shop's PayPal account,
// through a ready merchant connection or the shop's own app, and credentials for it on this server.
// Publishing, sending and the catalog page all ask it, so what the page offers is what sending does.
async function catalogSender(
  db: Db,
  account: ShopPayPalAccount,
  paypalFor: PayPalProvider,
): Promise<PayPalSellerApi | undefined> {
  const route = await resolveShopPayPalRoute(merchantEligibilityPool(db), {
    shopId: account.shopId,
    credentialRef: account.credentialRef,
    legacyMerchantId: account.merchantId,
  });
  return route ? paypalFor(route.credentialRef, route.payeeMerchantId) : undefined;
}

// Whether sending this shop's products to PayPal Catalog can work right now. It sends nothing.
export async function canSendToPayPalCatalog(
  db: Db,
  shop: SellerShop,
  deps: Pick<CatalogDeps, "paypalFor"> = defaultCatalogDeps,
): Promise<boolean> {
  const [account] = await db
    .select({
      shopId: shops.id,
      credentialRef: shops.paypalCredentialRef,
      merchantId: shops.paypalMerchantId,
    })
    .from(shops)
    .where(eq(shops.id, shop.id));
  return account ? (await catalogSender(db, account, deps.paypalFor)) !== undefined : false;
}

export async function getSellerCatalog(db: Db, shop: SellerShop): Promise<CatalogView> {
  const ofThisShop = and(eq(products.shopId, shop.id), ne(products.status, "draft"));
  const [rows, [tally]] = await Promise.all([
    db
      .select()
      .from(products)
      .where(ofThisShop)
      .orderBy(asc(products.title), asc(products.id))
      .limit(LIST_LIMIT),
    db
      .select({
        total: count(),
        published: sql<number>`count(*) FILTER (WHERE ${products.status} = 'published')::int`,
        waiting: sql<number>`count(*) FILTER (WHERE ${products.status} = 'published' AND ${products.paypalSyncStatus} = 'pending')::int`,
        unsent: sql<number>`count(*) FILTER (WHERE ${products.status} = 'published' AND ${products.paypalSyncStatus} <> 'synced')::int`,
      })
      .from(products)
      .where(ofThisShop),
  ]);
  return {
    shopCurrency: shop.currency,
    products: rows.map(toProductView),
    truncated: tally.total > rows.length,
    counts: {
      published: tally.published,
      unpublished: tally.total - tally.published,
      waiting: tally.waiting,
      unsent: tally.unsent,
    },
  };
}

// Puts the accepted rows of a finished review on sale, in one transaction, and deletes their drafts.
// The rows are checked again, because a shop's settings can have changed since the review. A row
// that no longer passes stays as a draft, with what is wrong with it showing on the review page.
// Holding the job makes a concurrent repeat wait and then find nothing left to do, and the job and
// position on a product stop a second one existing whatever code writes it.
export async function publishImport(
  db: Db,
  shop: SellerShop,
  rawJobId: unknown,
  deps: CatalogDeps = defaultCatalogDeps,
): Promise<ImportView> {
  const id = importId.safeParse(rawJobId);
  await db.transaction(async (tx) => {
    const [job] = id.success
      ? await tx
          .select({ id: importJobs.id, status: importJobs.status })
          .from(importJobs)
          .where(and(eq(importJobs.id, id.data), eq(importJobs.shopId, shop.id)))
          .for("update")
      : [];
    if (!job) {
      throw new ServiceError("IMPORT_NOT_FOUND", "This import does not exist.");
    }
    if (job.status !== "completed") {
      throw new ServiceError(
        "IMPORT_REVIEW_INCOMPLETE",
        "Finish reviewing this import before you publish it.",
      );
    }

    const [owner] = await tx
      .select({ currency: shops.currency, credentialRef: shops.paypalCredentialRef, merchantId: shops.paypalMerchantId })
      .from(shops)
      .where(eq(shops.id, shop.id));
    const ofThisJob = and(eq(importRows.jobId, job.id), eq(importRows.shopId, shop.id));
    const accepted = await tx
      .select()
      .from(importRows)
      .where(and(ofThisJob, eq(importRows.status, "accepted")))
      .orderBy(asc(importRows.position));
    const ready = accepted.filter((row) => !hasBlocker(rowIssues(row, owner.currency)));

    if (ready.length > 0) {
      const sender = await catalogSender(
        db,
        { shopId: shop.id, credentialRef: owner.credentialRef, merchantId: owner.merchantId },
        deps.paypalFor,
      );
      const paypalSyncStatus = sender ? "pending" : "not_configured";
      const published = await tx
        .insert(products)
        .values(
          ready.map((row) => ({
            shopId: shop.id,
            // An accepted row has these, by import_rows_accepted_is_complete.
            kind: row.kind as "product" | "service",
            title: row.title as string,
            status: "published" as const,
            description: row.descriptionEn ?? row.description ?? "",
            descriptionEn: row.descriptionEn,
            descriptionLv: row.descriptionLv,
            priceMinor: row.priceMinor,
            serviceDurationMinutes: row.serviceDurationMinutes,
            depositMinor: row.depositMinor,
            paypalSyncStatus: paypalSyncStatus as CatalogSyncStatus,
            importJobId: job.id,
            importPosition: row.position,
          })),
        )
        .onConflictDoNothing({ target: [products.importJobId, products.importPosition] })
        .returning({ id: products.id });
      await tx.delete(importRows).where(
        and(
          ofThisJob,
          inArray(
            importRows.id,
            ready.map((row) => row.id),
          ),
        ),
      );
      if (published.length > 0) {
        await deps.onCatalogChange(tx, {
          shopId: shop.id,
          productIds: published.map((row) => row.id),
          change: "published",
        });
      }
    }
    // A review does not reopen, so nothing can bring these back.
    await tx.delete(importRows).where(and(ofThisJob, eq(importRows.status, "removed")));
  });
  return getImport(db, shop, rawJobId);
}

function parseAmount(text: string, field: "price" | "deposit", shop: SellerShop): number {
  const parsed = parsePriceText(text);
  if (parsed.problem) {
    throw new ServiceError("CATALOG_EDIT_INVALID", priceProblemMessage(parsed.problem), { field });
  }
  if (parsed.currency && parsed.currency !== shop.currency) {
    throw new ServiceError(
      "CATALOG_EDIT_INVALID",
      `This shop sells in ${shop.currency}. Enter the amount in ${shop.currency}.`,
      { field },
    );
  }
  return parsed.minor;
}

// A price lives only here, so changing one never involves PayPal. It applies to the next checkout,
// because an order keeps what it was created with. Taking a product off sale does not touch its
// Catalog record either, because PayPal has no way to delete one.
export async function updateCatalogProduct(
  db: Db,
  shop: SellerShop,
  rawProductId: unknown,
  rawPatch: unknown,
  deps: CatalogDeps = defaultCatalogDeps,
): Promise<CatalogView> {
  const patch = parseInput(catalogProductPatch, rawPatch);
  const id = catalogProductId.safeParse(rawProductId);
  await db.transaction(async (tx) => {
    const [row] = id.success
      ? await tx
          .select()
          .from(products)
          .where(
            and(
              eq(products.id, id.data),
              eq(products.shopId, shop.id),
              ne(products.status, "draft"),
            ),
          )
          .for("update")
      : [];
    if (!row) {
      throw notFound();
    }

    const priceMinor =
      patch.price === undefined ? row.priceMinor : parseAmount(patch.price, "price", shop);
    if (patch.deposit !== undefined && row.kind !== "service") {
      throw new ServiceError("CATALOG_EDIT_INVALID", "Only a service takes a deposit.", {
        field: "deposit",
      });
    }
    const depositMinor =
      patch.deposit === undefined ? row.depositMinor : parseAmount(patch.deposit, "deposit", shop);
    if (depositMinor !== null && priceMinor !== null && depositMinor > priceMinor) {
      throw new ServiceError(
        "CATALOG_EDIT_INVALID",
        "The deposit cannot be more than the price. Change the deposit first.",
        { field: patch.deposit === undefined ? "price" : "deposit" },
      );
    }
    const status = patch.status ?? row.status;

    const amountsChanged = priceMinor !== row.priceMinor || depositMinor !== row.depositMinor;
    if (!amountsChanged && status === row.status) {
      return;
    }
    await tx
      .update(products)
      .set({ priceMinor, depositMinor, status })
      .where(and(eq(products.id, row.id), eq(products.shopId, shop.id)));

    const change =
      status === row.status ? "edited" : status === "published" ? "published" : "unpublished";
    await deps.onCatalogChange(tx, { shopId: shop.id, productIds: [row.id], change });
  });
  return getSellerCatalog(db, shop);
}

type SyncOutcome =
  | { ok: true; paypalProductId: string }
  | { ok: false; failure: SyncFailure };

// Both the PayPal-Request-Id and the record's ID are fixed per product, so no number of repeats can
// make a second record. A repeat within 72 hours gets the first answer back. After that PayPal
// refuses the ID as taken, and the record it names is read and adopted.
async function sendToCatalog(paypal: PayPalSellerApi, row: ProductRecord): Promise<SyncOutcome> {
  const record = buildCatalogRecord(row);
  const judge = (answer: { id?: string }): SyncOutcome =>
    answer.id === record.id
      ? { ok: true, paypalProductId: record.id }
      : { ok: false, failure: "unexpected_answer" };
  const failed = (thrown: unknown): SyncOutcome => {
    const failure = describePayPalFailure(thrown);
    console.error("PayPal catalog sync failed", { productId: row.id, ...failure });
    return { ok: false, failure: failure.kind };
  };

  try {
    return judge(await paypal.createCatalogRecord(record, row.id));
  } catch (thrown) {
    if (!describePayPalFailure(thrown).issues?.includes("DUPLICATE_RESOURCE_IDENTIFIER")) {
      return failed(thrown);
    }
  }
  try {
    return judge(await paypal.readCatalogRecord(record.id));
  } catch (thrown) {
    return failed(thrown);
  }
}

// A refusal is about one record, and the next may be fine. Anything else would only repeat itself
// and keep the seller waiting, so the batch ends and the rest stay in the queue.
const stopsBatch = (failure: SyncFailure) =>
  failure === "timeout" || failure === "unavailable" || failure === "not_authorized";

// Sends one batch, and says how many are left, so the page can show progress and a closed tab loses
// nothing. Unpublished products are not sent, and a published one sells whatever happens here.
export async function syncCatalog(
  db: Db,
  shop: SellerShop,
  rawInput: unknown,
  deps: Pick<CatalogDeps, "paypalFor"> = defaultCatalogDeps,
): Promise<CatalogSyncAnswer> {
  const input = parseInput(catalogSyncRequest, rawInput ?? {});
  const published = and(eq(products.shopId, shop.id), eq(products.status, "published"));

  if (input.productId) {
    const [row] = await db
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.id, input.productId),
          eq(products.shopId, shop.id),
          ne(products.status, "draft"),
        ),
      );
    if (!row) {
      throw notFound();
    }
  }
  if (input.productId || input.retryFailed) {
    await db
      .update(products)
      .set({ paypalSyncStatus: "pending" })
      .where(
        and(
          published,
          input.productId ? eq(products.id, input.productId) : undefined,
          or(
            eq(products.paypalSyncStatus, "failed"),
            eq(products.paypalSyncStatus, "not_configured"),
          ),
        ),
      );
  }

  const waiting = and(published, eq(products.paypalSyncStatus, "pending"));
  const [owner] = await db
    .select({
      shopId: shops.id,
      credentialRef: shops.paypalCredentialRef,
      merchantId: shops.paypalMerchantId,
    })
    .from(shops)
    .where(eq(shops.id, shop.id));
  let stopped = false;

  const sender = owner ? await catalogSender(db, owner, deps.paypalFor) : undefined;
  if (!owner || !sender) {
    await db
      .update(products)
      .set({ paypalSyncStatus: "not_configured", paypalSyncError: null })
      .where(waiting);
  } else {
    const batch = await db
      .select()
      .from(products)
      .where(and(waiting, input.productId ? eq(products.id, input.productId) : undefined))
      .orderBy(asc(products.createdAt), asc(products.id))
      .limit(SYNC_BATCH);
    for (const row of batch) {
      // Recheck immediately before each external write so a revoked connection cannot be reused
      // for a later item in the same batch.
      const paypal = await catalogSender(db, owner, deps.paypalFor);
      if (!paypal) {
        await db
          .update(products)
          .set({ paypalSyncStatus: "not_configured", paypalSyncError: null })
          .where(eq(products.id, row.id));
        continue;
      }
      const outcome = await sendToCatalog(paypal, row);
      if (outcome.ok) {
        await db
          .update(products)
          .set({
            paypalSyncStatus: "synced",
            paypalProductId: outcome.paypalProductId,
            paypalSyncError: null,
            paypalSyncedAt: new Date(),
          })
          .where(eq(products.id, row.id));
        continue;
      }
      // A concurrent attempt that succeeded stands. Its record exists, whatever this one heard.
      await db
        .update(products)
        .set({ paypalSyncStatus: "failed", paypalSyncError: outcome.failure })
        .where(and(eq(products.id, row.id), ne(products.paypalSyncStatus, "synced")));
      if (stopsBatch(outcome.failure)) {
        stopped = true;
        break;
      }
    }
  }

  const [left] = await db.select({ value: count() }).from(products).where(waiting);
  return { view: await getSellerCatalog(db, shop), remaining: left.value, stopped };
}
