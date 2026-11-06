import "server-only";

import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import { createSearchAi } from "../ai";
import { cleanSearchTerms } from "../ai/search-terms";
import { AiFailure, type SearchAi, type SearchTermFacts } from "../ai/types";
import { getDb } from "../db";
import type { Db } from "../db/client";
import { productSearchTerms, products, shops } from "../db/schema";
import type { Tx } from "./payment-reconciliation";
import { pruneSearchEvents } from "./search-events";
import { listingHash } from "./search-query";
import type { CatalogChange } from "./seller-catalog";

// Keeps the model's search terms in step with what is published. A catalog change only writes to a
// queue, inside its own transaction, and the sweep asks the model later with no transaction open. A
// product is searchable by its own words from the moment it is published, and a search says so while
// a listing it could have reached has no terms yet.

const SWEEP_INTERVAL_MS = 30 * 1000;
// One shop's listings per request, so no reply can ever touch another shop's product.
const BATCH_SIZE = 20;
const MAX_BATCHES_PER_PASS = 5;
const LEASE = sql`interval '5 minutes'`;
// Doubles from 5 minutes up to 6 hours, so an outage settles by itself and costs little meanwhile.
const backoff = (attempts: number) =>
  sql`now() + least(interval '5 minutes' * power(2, greatest(${attempts}, 1) - 1), interval '6 hours')`;

const pendingAgain = {
  status: "pending" as const,
  sourceHash: null,
  terms: [],
  placeTerms: [],
  attempts: 0,
  error: null,
  model: null,
  promptVersion: null,
  indexedAt: null,
  nextAttemptAt: sql`now()`,
};

// Terms for an older version of a listing no longer count anywhere, and here they go back in line.
async function requeueChangedListings(db: Db | Tx, shopId?: string): Promise<void> {
  await db
    .update(productSearchTerms)
    .set(pendingAgain)
    .where(
      and(
        eq(productSearchTerms.status, "indexed"),
        shopId ? eq(productSearchTerms.shopId, shopId) : undefined,
        sql`EXISTS (
          SELECT 1 FROM ${products} JOIN ${shops} ON ${shops.id} = ${products.shopId}
          WHERE ${products.id} = ${productSearchTerms.productId}
            AND ${listingHash} IS DISTINCT FROM ${productSearchTerms.sourceHash}
        )`,
      ),
    );
}

// The `onCatalogChange` hook for every publish, edit and unpublish.
export async function queueSearchIndexing(tx: Tx, change: CatalogChange): Promise<void> {
  const ofThisChange = and(
    eq(productSearchTerms.shopId, change.shopId),
    inArray(productSearchTerms.productId, change.productIds),
  );
  if (change.change === "unpublished") {
    await tx.delete(productSearchTerms).where(ofThisChange);
    return;
  }
  await tx
    .insert(productSearchTerms)
    .values(change.productIds.map((productId) => ({ productId, shopId: change.shopId })))
    .onConflictDoNothing({ target: productSearchTerms.productId });
  await requeueChangedListings(tx, change.shopId);
}

// Catches what no hook saw, such as seeded rows, and removes what is no longer on sale.
async function syncQueue(db: Db): Promise<void> {
  await db.delete(productSearchTerms).where(
    sql`NOT EXISTS (
      SELECT 1 FROM ${products}
      WHERE ${products.id} = ${productSearchTerms.productId} AND ${products.status} = 'published'
    )`,
  );
  await db.execute(sql`
    INSERT INTO ${productSearchTerms} ("product_id", "shop_id")
    SELECT ${products.id}, ${products.shopId} FROM ${products}
    WHERE ${products.status} = 'published'
    ON CONFLICT ("product_id") DO NOTHING
  `);
  await requeueChangedListings(db);
  // A shop has one place, and a real model often gives its names on only some rows of a request.
  // Changed listings are back in line by now, so no row here can hand on an old place.
  await db.execute(sql`
    UPDATE "product_search_terms" AS row SET "place_terms" = donor."place_terms"
    FROM (
      SELECT DISTINCT ON ("shop_id") "shop_id", "place_terms" FROM "product_search_terms"
      WHERE "status" = 'indexed' AND cardinality("place_terms") > 0
      ORDER BY "shop_id", "indexed_at" DESC
    ) AS donor
    WHERE row."shop_id" = donor."shop_id"
      AND row."status" = 'indexed'
      AND cardinality(row."place_terms") = 0
  `);
}

type Claimed = { productId: string; shopId: string; hash: string; attempts: number; facts: SearchTermFacts };

// Takes one shop's due rows and moves them forward by a lease, so a run that dies is simply retried.
// A row that has failed before goes alone, so one listing a model refuses cannot sink its neighbours.
async function claimBatch(db: Db): Promise<Claimed[]> {
  return db.transaction(async (tx) => {
    const due = and(
      inArray(productSearchTerms.status, ["pending", "failed"]),
      lte(productSearchTerms.nextAttemptAt, sql`now()`),
    );
    const order = [asc(productSearchTerms.nextAttemptAt), asc(productSearchTerms.productId)];
    const [first] = await tx
      .select({ shopId: productSearchTerms.shopId, attempts: productSearchTerms.attempts })
      .from(productSearchTerms)
      .where(due)
      .orderBy(...order)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!first) {
      return [];
    }
    const taken = await tx
      .select({ productId: productSearchTerms.productId })
      .from(productSearchTerms)
      .where(
        and(
          due,
          eq(productSearchTerms.shopId, first.shopId),
          first.attempts === 0 ? eq(productSearchTerms.attempts, 0) : undefined,
        ),
      )
      .orderBy(...order)
      .limit(first.attempts === 0 ? BATCH_SIZE : 1)
      .for("update", { skipLocked: true });
    const ids = taken.map((row) => row.productId);
    await tx
      .update(productSearchTerms)
      .set({
        attempts: sql`${productSearchTerms.attempts} + 1`,
        nextAttemptAt: sql`now() + ${LEASE}`,
      })
      .where(inArray(productSearchTerms.productId, ids));

    const rows = await tx
      .select({
        productId: products.id,
        shopId: products.shopId,
        kind: products.kind,
        title: products.title,
        description: products.description,
        descriptionLv: products.descriptionLv,
        location: shops.location,
        attempts: productSearchTerms.attempts,
        hash: listingHash,
      })
      .from(productSearchTerms)
      .innerJoin(products, eq(products.id, productSearchTerms.productId))
      .innerJoin(shops, eq(shops.id, products.shopId))
      // Only what is on sale ever reaches a model, whatever the queue holds.
      .where(and(inArray(productSearchTerms.productId, ids), eq(products.status, "published")))
      .orderBy(asc(products.id));
    return rows.map((row, position) => ({
      productId: row.productId,
      shopId: row.shopId,
      hash: row.hash,
      attempts: row.attempts,
      facts: {
        position,
        title: row.title,
        kind: row.kind,
        description: row.description || null,
        descriptionLv: row.descriptionLv,
        location: row.location,
      },
    }));
  });
}

// Writes only if the listing is still on sale and still what the model read. Otherwise the row waits
// out its lease and is read again, or has already been deleted by unpublishing.
async function storeTerms(
  db: Db,
  row: Claimed,
  found: { terms: string[]; placeTerms: string[] },
  source: { model: string; promptVersion: string },
): Promise<void> {
  await db
    .update(productSearchTerms)
    .set({
      status: "indexed",
      sourceHash: row.hash,
      terms: found.terms,
      placeTerms: found.placeTerms,
      attempts: 0,
      error: null,
      model: source.model,
      promptVersion: source.promptVersion,
      indexedAt: sql`now()`,
    })
    .where(
      and(
        eq(productSearchTerms.productId, row.productId),
        eq(productSearchTerms.shopId, row.shopId),
        sql`EXISTS (
          SELECT 1 FROM ${products} JOIN ${shops} ON ${shops.id} = ${products.shopId}
          WHERE ${products.id} = ${productSearchTerms.productId}
            AND ${products.status} = 'published'
            AND ${listingHash} = ${row.hash}
        )`,
      ),
    );
}

async function markFailed(db: Db, row: Claimed, code: string): Promise<void> {
  await db
    .update(productSearchTerms)
    .set({ status: "failed", error: code, nextAttemptAt: backoff(row.attempts) })
    .where(eq(productSearchTerms.productId, row.productId));
}

// One batch's worth of work. Says whether further requests in this pass are worth making.
async function indexBatch(db: Db, ai: SearchAi, batch: Claimed[]): Promise<boolean> {
  let reading;
  try {
    reading = await ai.suggestSearchTerms(batch.map((row) => row.facts));
  } catch (error) {
    const code = error instanceof AiFailure ? error.code : "UNEXPECTED";
    console.error("Search indexing failed", { code });
    for (const row of batch) {
      await markFailed(db, row, code);
    }
    // A refusal or a malformed reply is about these rows. Anything else would only repeat itself.
    return code === "REFUSED" || code === "MALFORMED_OUTPUT" || code === "TOO_LONG" || code === "SOURCE_REJECTED";
  }
  if (reading.rows.length !== batch.length) {
    console.error("Search terms reply has the wrong number of rows", {
      asked: batch.length,
      answered: reading.rows.length,
    });
  }
  for (const row of batch) {
    const suggested = reading.rows.find((entry) => entry.position === row.facts.position);
    if (suggested) {
      await storeTerms(db, row, cleanSearchTerms(row.facts, suggested), reading);
    } else {
      await markFailed(db, row, "MISSING_FROM_REPLY");
    }
  }
  return true;
}

// One pass of the sweep. With no model configured nothing is queued for it, and search stays on
// listings' own words and says so.
export async function runSearchIndexing(db: Db, ai: SearchAi | undefined): Promise<void> {
  await pruneSearchEvents(db);
  if (!ai) {
    return;
  }
  await syncQueue(db);
  for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch += 1) {
    const claimed = await claimBatch(db);
    if (claimed.length === 0 || !(await indexBatch(db, ai, claimed))) {
      return;
    }
  }
}

export function startSearchIndexSweep(): void {
  let running = false;
  setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    runSearchIndexing(getDb(), createSearchAi(process.env))
      .catch((error: unknown) => {
        console.error("Search index sweep failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => {
        running = false;
      });
  }, SWEEP_INTERVAL_MS).unref();
}
