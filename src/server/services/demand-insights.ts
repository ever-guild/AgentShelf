import "server-only";

import { createHash } from "node:crypto";

import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { AiFailure, type DemandAi, type DemandFacts } from "../ai/types";
import type { Db } from "../db/client";
import {
  assistantDemandQuery,
  insightRequest,
  type DashboardInsights,
  type DemandDataAnswer,
  type DemandGroup,
  type DemandInsight,
  type DemandInsightItem,
} from "../contracts/seller-insights";
import { demandInsights, products, searchEvents, sellerAiCalls } from "../db/schema";
import { checkDemandExplanation } from "../domain/demand-claims";
import { groupDemandQueries, type DemandQueryStats } from "../domain/demand-groups";
import { formatLocalDate, localDateTimeString } from "../domain/shop-time";
import { parseInput, ServiceError } from "../errors";
import { periodOf, type DashboardShop } from "./seller-dashboard";

// Unmet demand as one shop's aggregates, and the words written about them. Everything here reads rows
// attributed to the session's shop by the rule in search-events.ts, so a global miss and another
// shop's row never reach a count, a model or a tool. Counts always come from these queries, and a
// model only ever adds words next to them.

const MAX_QUERIES = 500;
const MAX_REFS_PER_QUERY = 20;
// A model reads the largest groups, which keeps the request small and the note short.
const MAX_GROUPS_EXPLAINED = 8;
const DEFAULT_GROUPS_RETURNED = 10;
const AI_CALLS_PER_HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;

type Options = { now?: Date };

type Aggregates = {
  envelope: ReturnType<typeof periodOf>["envelope"];
  periodEndDate: string;
  truncated: boolean;
  unmetSearches: number;
  groups: DemandGroup[];
};

async function readAggregates(
  db: Db,
  shop: DashboardShop,
  rawQuery: unknown,
  now: Date,
): Promise<Aggregates> {
  const { from, today, envelope } = periodOf(shop, rawQuery, now);
  const attributedHere = and(
    eq(searchEvents.attributedShopId, shop.id),
    gte(searchEvents.createdAt, from),
  );
  const inner = sql`inner_event`;
  // Spelled out, because a single-table select drops the table name from a column it renders, and
  // this comparison would then be the inner row with itself.
  const sameQuery = sql`${inner}.attributed_shop_id = ${shop.id}
    AND ${inner}.created_at >= ${from.toISOString()}::timestamptz
    AND ${inner}.query_normalized = search_events.query_normalized`;

  // Counted by the database, so a row limit cannot change a count.
  const rows = await db
    .select({
      query: searchEvents.queryNormalized,
      searches: sql<number>`count(*)::int`,
      sampleSearches: sql<number>`(count(*) FILTER (WHERE ${searchEvents.origin} = 'fixture'))::int`,
      degradedSearches: sql<number>`(count(*) FILTER (WHERE ${searchEvents.degraded}))::int`,
      first: sql<Date>`min(${searchEvents.createdAt})`.mapWith(searchEvents.createdAt),
      last: sql<Date>`max(${searchEvents.createdAt})`.mapWith(searchEvents.createdAt),
      eventRefs: sql<string[]>`(array_agg(${searchEvents.id}::text ORDER BY ${searchEvents.createdAt} DESC, ${searchEvents.id} DESC))[1:${sql.raw(String(MAX_REFS_PER_QUERY))}]`,
      locations: sql<string[]>`COALESCE(array_agg(DISTINCT ${searchEvents.location}) FILTER (WHERE ${searchEvents.location} IS NOT NULL), '{}')`,
      kinds: sql<string[]>`COALESCE(array_agg(DISTINCT ${searchEvents.kind}::text) FILTER (WHERE ${searchEvents.kind} IS NOT NULL), '{}')`,
      words: sql<string[]>`ARRAY(SELECT DISTINCT word FROM search_events AS ${inner}, unnest(${inner}.attribution_words) AS word WHERE ${sameQuery})`,
      productIds: sql<string[]>`ARRAY(SELECT DISTINCT product_id::text FROM search_events AS ${inner}, unnest(${inner}.attribution_product_ids) AS product_id WHERE ${sameQuery})`,
    })
    .from(searchEvents)
    .where(attributedHere)
    .groupBy(searchEvents.queryNormalized)
    .orderBy(desc(sql`count(*)`), searchEvents.queryNormalized)
    .limit(MAX_QUERIES + 1);
  const visible = rows.slice(0, MAX_QUERIES);

  const [{ unmetSearches }] = await db
    .select({ unmetSearches: sql<number>`count(*)::int` })
    .from(searchEvents)
    .where(attributedHere);

  // Only this shop's listings are named, whatever an event's array holds.
  const productIds = [...new Set(visible.flatMap((row) => row.productIds))];
  const listings = productIds.length
    ? await db
        .select({ id: products.id, title: products.title })
        .from(products)
        .where(and(eq(products.shopId, shop.id), inArray(products.id, productIds)))
    : [];
  const titles = new Map(listings.map(({ id, title }) => [id, title]));

  const stats: DemandQueryStats[] = visible.map((row) => ({
    query: row.query,
    searches: row.searches,
    sampleSearches: row.sampleSearches,
    degradedSearches: row.degradedSearches,
    firstSearchedLocal: localDateTimeString(row.first, shop.timezone),
    lastSearchedLocal: localDateTimeString(row.last, shop.timezone),
    sharedWords: row.words,
    listings: row.productIds.flatMap((id) => titles.get(id) ?? []),
    locations: row.locations,
    kinds: row.kinds as DemandQueryStats["kinds"],
    eventRefs: row.eventRefs,
  }));

  return {
    envelope,
    periodEndDate: formatLocalDate(today),
    truncated: rows.length > MAX_QUERIES,
    unmetSearches,
    groups: groupDemandQueries(stats),
  };
}

// The hash of everything a note could be about: the window, the total and every group. Words are
// current only while this is the same.
function snapshotOf({ envelope, periodEndDate, unmetSearches, groups }: Aggregates): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        shopId: envelope.shopId,
        periodDays: envelope.periodDays,
        periodStartDate: envelope.periodStartDate,
        periodEndDate,
        unmetSearches,
        groups,
      }),
    )
    .digest("hex");
}

function factsOf({ envelope, periodEndDate, unmetSearches, groups }: Aggregates): DemandFacts {
  return {
    window: {
      startDate: envelope.periodStartDate,
      endDate: periodEndDate,
      days: envelope.periodDays,
      timezone: envelope.timezone,
    },
    unmetSearches,
    groups: groups.slice(0, MAX_GROUPS_EXPLAINED).map((group) => ({
      groupId: group.groupId,
      label: group.label,
      searches: group.searches,
      recordedSearches: group.recordedSearches,
      sampleSearches: group.sampleSearches,
      degradedSearches: group.degradedSearches,
      examples: group.examples,
      sharedWords: group.sharedWords,
      closestListings: group.listings,
      locations: group.locations,
    })),
  };
}

async function readInsight(
  db: Db,
  aggregates: Aggregates,
): Promise<Pick<DashboardInsights, "state" | "insight">> {
  // With nothing recorded there is nothing for old words to describe.
  if (aggregates.groups.length === 0) {
    return { state: "no_data", insight: null };
  }
  const { shopId, periodDays } = aggregates.envelope;
  const [row] = await db
    .select()
    .from(demandInsights)
    .where(and(eq(demandInsights.shopId, shopId), eq(demandInsights.periodDays, periodDays)));
  if (!row) {
    return { state: "not_written", insight: null };
  }
  const insight: DemandInsight = {
    writtenLocal: localDateTimeString(row.writtenAt, aggregates.envelope.timezone),
    windowStartDate: row.windowStartDate,
    windowEndDate: row.windowEndDate,
    unmetSearches: row.unmetSearches,
    model: row.model,
    items: row.items as DemandInsightItem[],
  };
  return { state: row.snapshot === snapshotOf(aggregates) ? "fresh" : "stale", insight };
}

function answerOf(
  aggregates: Aggregates,
  written: Pick<DashboardInsights, "state" | "insight">,
  aiAvailable: boolean,
): DashboardInsights {
  return {
    ...aggregates.envelope,
    periodEndDate: aggregates.periodEndDate,
    truncated: aggregates.truncated,
    unmetSearches: aggregates.unmetSearches,
    groups: aggregates.groups,
    aiAvailable,
    ...written,
  };
}

// For the page's polling: reads only, and never calls a model.
export async function getDashboardInsights(
  db: Db,
  shop: DashboardShop,
  rawQuery: unknown,
  { now = new Date(), aiAvailable }: Options & { aiAvailable: boolean },
): Promise<DashboardInsights> {
  const aggregates = await readAggregates(db, shop, parseInput(insightRequest, rawQuery), now);
  return answerOf(aggregates, await readInsight(db, aggregates), aiAvailable);
}

// Counted before the call, so what a failed call cost is counted too. The row is one per hour, and a
// shop's old rows go as it makes new ones.
export async function takeAiCall(
  db: Db,
  shopId: string,
  now: Date,
  limitMessage = "This shop has used its AI answers for this hour. The counts on the page are still correct. Try again later.",
): Promise<void> {
  const hour = new Date(now.getTime() - (now.getTime() % HOUR_MS));
  const [{ calls }] = await db
    .insert(sellerAiCalls)
    .values({ shopId, hour, calls: 1 })
    .onConflictDoUpdate({
      target: [sellerAiCalls.shopId, sellerAiCalls.hour],
      set: { calls: sql`${sellerAiCalls.calls} + 1` },
    })
    .returning({ calls: sellerAiCalls.calls });
  await db
    .delete(sellerAiCalls)
    .where(and(eq(sellerAiCalls.shopId, shopId), lt(sellerAiCalls.hour, hour)));
  if (calls > AI_CALLS_PER_HOUR) {
    throw new ServiceError("AI_LIMIT_REACHED", limitMessage);
  }
}

const EXPLANATION_FAILED =
  "Could not write an explanation just now. The counts on the page are recorded searches and are still correct. Try again in a minute.";

// What the button does. The same snapshot never pays twice, no events never reach a model, and a
// reply that fails a check is treated as a failure, leaving the counts alone.
export async function writeDemandInsight(
  db: Db,
  shop: DashboardShop,
  rawQuery: unknown,
  ai: DemandAi | undefined,
  { now = new Date() }: Options = {},
): Promise<DashboardInsights> {
  const aggregates = await readAggregates(db, shop, parseInput(insightRequest, rawQuery), now);
  const current = await readInsight(db, aggregates);
  if (current.state === "no_data" || current.state === "fresh") {
    return answerOf(aggregates, current, ai !== undefined);
  }
  if (!ai) {
    throw new ServiceError(
      "AI_NOT_CONFIGURED",
      "Explanations are not set up on this service. The counts on the page are still correct.",
    );
  }
  await takeAiCall(db, shop.id, now);

  const facts = factsOf(aggregates);
  const shown = aggregates.groups.slice(0, MAX_GROUPS_EXPLAINED);
  let reading;
  try {
    reading = await ai.explainDemand(facts);
  } catch (error) {
    if (error instanceof AiFailure) {
      throw new ServiceError("AI_UNAVAILABLE", EXPLANATION_FAILED, { reason: error.code });
    }
    throw error;
  }
  const checked = checkDemandExplanation(reading, shown, aggregates.envelope.periodDays);
  if (!checked.ok) {
    console.error("A demand explanation failed its check", { problem: checked.problem });
    throw new ServiceError("AI_UNAVAILABLE", EXPLANATION_FAILED, { reason: "UNSUPPORTED_CLAIM" });
  }

  const row = {
    shopId: shop.id,
    periodDays: aggregates.envelope.periodDays,
    snapshot: snapshotOf(aggregates),
    windowStartDate: aggregates.envelope.periodStartDate,
    windowEndDate: aggregates.periodEndDate,
    unmetSearches: aggregates.unmetSearches,
    items: checked.items,
    model: reading.model,
    promptVersion: reading.promptVersion,
    writtenAt: now,
  };
  await db
    .insert(demandInsights)
    .values(row)
    .onConflictDoUpdate({
      target: [demandInsights.shopId, demandInsights.periodDays],
      set: row,
    });
  return answerOf(
    aggregates,
    {
      state: "fresh",
      insight: {
        writtenLocal: localDateTimeString(now, shop.timezone),
        windowStartDate: row.windowStartDate,
        windowEndDate: row.windowEndDate,
        unmetSearches: row.unmetSearches,
        model: row.model,
        items: checked.items,
      },
    },
    true,
  );
}

function matchesSearch(group: DemandGroup, search: string): boolean {
  const needle = search.toLowerCase();
  return [group.label, ...group.examples.map(({ query }) => query)].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

// The assistant's read tools. Every filter is checked by the strict contract and applied to rows this
// shop already owns, so no filter can widen what is read, and none of it goes into SQL.
export async function readDemandForAssistant(
  db: Db,
  shop: DashboardShop,
  rawQuery: unknown,
  { now = new Date() }: Options = {},
): Promise<DemandDataAnswer> {
  const { days, search, source, limit, groupId } = parseInput(assistantDemandQuery, rawQuery);
  const aggregates = await readAggregates(db, shop, days ? { days } : {}, now);
  const { envelope, periodEndDate, unmetSearches, truncated } = aggregates;

  const groups = aggregates.groups
    .filter((group) => !groupId || group.groupId === groupId)
    .filter((group) => !search || matchesSearch(group, search))
    .filter(
      (group) =>
        !source ||
        source === "all" ||
        (source === "recorded" ? group.recordedSearches > 0 : group.sampleSearches > 0),
    )
    .slice(0, groupId ? 1 : (limit ?? DEFAULT_GROUPS_RETURNED))
    // Event references answer a question about one group, and are noise in a list.
    .map((group) => (groupId ? group : { ...group, eventRefs: [], eventRefsOmitted: group.searches }));

  const window = `${envelope.periodStartDate} to ${periodEndDate}`;
  const note =
    unmetSearches === 0
      ? `No search found nothing and matched this shop from ${window}. There is no demand to report for these days.`
      : groups.length === 0
        ? `No group matched these filters from ${window}. The shop has ${unmetSearches} attributed searches in all.`
        : null;

  return {
    shopId: envelope.shopId,
    timezone: envelope.timezone,
    periodDays: envelope.periodDays,
    periodStartDate: envelope.periodStartDate,
    periodEndDate,
    unmetSearches,
    truncated,
    groups,
    note,
  };
}
