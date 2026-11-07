"use client";

import type { AgWidgetField, AgWidgetParams } from "ag-studio";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { DashboardPaymentTotal, PaymentGroup } from "@/server/contracts/seller-dashboard";
import type { DashboardInsights, DemandInsightItem } from "@/server/contracts/seller-insights";
import type { ScheduleStatus } from "@/server/contracts/seller-schedule";

import { depositText, effectiveStatus, statusLabel } from "../schedule/schedule-labels";
import {
  PAYMENT_GROUP_LABELS,
  attributionBasis,
  count,
  demandObservation,
  groupTotals,
  money,
  searches,
  shopDateTime,
  windowText,
} from "./dashboard-labels";
import { setDashboardState, useDashboardState, type DatasetName } from "./dashboard-store";

// The AgentShelf widgets inside AG Studio. They are plain React, and read their rows through
// the widget API, so Studio's page filters and cross filters apply to them like any built-in
// widget. Search queries and titles come from outside, so they are only ever rendered as text.

type WidgetParams = AgWidgetParams;
type Row = Record<string, string | number | null>;

function bareId(field: AgWidgetField): string {
  return String(field.fieldId).split(".").pop() as string;
}

// The widget's mapped rows, keyed by field name, kept up to date as filters and data change. Null
// until the first answer.
function useWidgetRows(params: WidgetParams, mapping = "fields"): { rows: Row[] | null; failed: boolean } {
  const { widgetApi } = params;
  const fields = (params.dataMapping as Record<string, AgWidgetField[] | undefined>)[mapping];
  const [answer, setAnswer] = useState<{ rows: Row[] | null; failed: boolean }>({ rows: null, failed: false });

  useEffect(() => {
    if (!fields?.length) {
      return;
    }
    let current = true;
    const toRows = (rows: Record<string, unknown>[]): Row[] =>
      rows.map((row) =>
        Object.fromEntries(fields.map((field) => [bareId(field), (row[field.key] ?? null) as Row[string]])),
      );
    widgetApi
      .getData(
        { fields },
        {
          queryId: "rows",
          maxRows: 1000,
          onDataUpdated: (response) => {
            if (current && !response.replaced) {
              setAnswer({ rows: toRows(response.results.rows), failed: false });
            }
          },
        },
      )
      .then((response) => {
        if (current && !response.replaced) {
          setAnswer({ rows: toRows(response.results.rows), failed: Boolean(response.results.metadata?.error) });
        }
      })
      .catch(() => {
        if (current) {
          setAnswer({ rows: null, failed: true });
        }
      });
    return () => {
      current = false;
    };
  }, [widgetApi, fields]);

  return answer;
}

const SECONDARY = "text-zinc-600 dark:text-zinc-400";
const NOTE = `text-[13px] leading-5 ${SECONDARY}`;
const RULE = "border-t border-zinc-200 first:border-t-0 dark:border-zinc-800";
const LINK = "underline underline-offset-4";

// The padding puts a widget's words on the same line as Studio's title above them. The frame
// scrolls, so its rows draw their focus ring inside themselves, where the frame cannot cut it.
function WidgetFrame({ children }: { children: ReactNode }) {
  return (
    <div className="widget-frame @container h-full overflow-y-auto px-2 pb-2 font-sans text-sm leading-5 text-zinc-900 dark:text-zinc-100">
      {children}
    </div>
  );
}

function Chevron() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="widget-chevron size-4 self-center text-zinc-500 dark:text-zinc-400"
    >
      <path d="m6 4 4 4-4 4" />
    </svg>
  );
}

// The same three states in every widget: still loading, could not load, and nothing there.
function DatasetState({
  dataset,
  label,
  rows,
  failed,
  empty,
  children,
}: {
  dataset: DatasetName;
  label: string;
  rows: Row[] | null;
  failed: boolean;
  empty: ReactNode;
  children: ReactNode;
}) {
  const state = useDashboardState();
  if (state.data[dataset] === null) {
    return state.failed.includes(dataset) ? (
      <p className="border-l-4 border-blocked pl-3">
        Could not load {label}. Use Refresh at the top of the page to try again.
      </p>
    ) : (
      <p className={SECONDARY}>Loading {label}</p>
    );
  }
  if (failed) {
    return (
      <p className="border-l-4 border-blocked pl-3">Could not read {label}. Reload the page to try again.</p>
    );
  }
  if (rows === null) {
    return <p className={SECONDARY}>Loading {label}</p>;
  }
  return rows.length === 0 ? <div className={SECONDARY}>{empty}</div> : <>{children}</>;
}

const GROUP_ORDER: PaymentGroup[] = ["paid", "awaiting", "review", "closed"];

const GROUP_NOTE: Record<PaymentGroup, string> = {
  paid: "Captures PayPal confirmed. This is your revenue for the period.",
  awaiting: "Buyers have a link or approved it. Not revenue until captured.",
  review: "Does not match PayPal. Check these before you act.",
  closed: "Cancelled, failed or never had a link.",
};

// The money that came in leads, and the rest reads as lines of a ledger beside it: one row each on
// a wide page, and two where the page is narrower, the count sharing a row with what it means. A
// state with no orders has nothing to warn about, so its mark stays quiet.
export function PaymentStatusWidget(params: WidgetParams) {
  const { rows, failed } = useWidgetRows(params);
  const state = useDashboardState();
  const totals = useMemo(() => groupTotals((rows ?? []) as unknown as DashboardPaymentTotal[]), [rows]);
  const orderGroupField = (params.dataMapping as Record<string, AgWidgetField[] | undefined>).orderGroup?.[0];
  const selections = params.widgetApi.getCrossFilterSelections();
  const selected = JSON.stringify(selections ?? []);
  const period = state.data.payments?.periodDays;
  const shopCurrency = state.data.payments?.currency ?? "EUR";
  const currencies = [...new Set(totals.map(({ currency }) => currency))];
  const shown = currencies.length ? currencies : [shopCurrency];

  return (
    <WidgetFrame>
      <DatasetState
        dataset="payments"
        label="payments"
        rows={rows}
        failed={failed}
        empty={
          <p>
            No orders in the last {period} days. When a buyer&apos;s assistant creates an order, it shows here as
            awaiting payment until the buyer approves it in PayPal. Check that your{" "}
            <Link className={LINK} href="/seller/catalog">
              catalog
            </Link>{" "}
            is published.
          </p>
        }
      >
        {shown.map((currency) => (
          <ul
            key={currency}
            className="mb-3 grid gap-2 @3xl:grid-cols-[18rem_minmax(0,1fr)] @3xl:gap-x-6 @3xl:gap-y-0"
          >
            {GROUP_ORDER.map((group) => {
              const total = totals.find((entry) => entry.group === group && entry.currency === currency);
              const label = PAYMENT_GROUP_LABELS[group];
              const pressed = selected.includes(JSON.stringify(label));
              const orders = total?.orderCount ?? 0;
              const amount = money(total?.amountMinor ?? 0, currency);
              const toggle = () =>
                orderGroupField &&
                params.widgetApi.toggleCrossFilter({
                  type: "value",
                  group: 0,
                  field: orderGroupField,
                  value: label,
                });
              const surface = `state-mark h-full w-full text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 ${pressed ? "bg-zinc-100 inset-ring inset-ring-zinc-400 dark:bg-zinc-800 dark:inset-ring-zinc-500" : ""}`;
              if (group === "paid") {
                return (
                  <li key={group} className="@3xl:row-span-3">
                    <button
                      type="button"
                      aria-pressed={pressed}
                      disabled={!orderGroupField}
                      data-state={orders > 0 ? group : "none"}
                      onClick={toggle}
                      className={`${surface} block py-1 pr-3`}
                    >
                      <span className="block font-medium">{label}</span>
                      <span className="block text-3xl leading-10 font-medium tabular-nums">{amount}</span>
                      <span className={`block ${NOTE} tabular-nums`}>
                        {count(orders, "order")}
                        {total?.depositsMinor ? `, of which ${money(total.depositsMinor, currency)} is deposits` : ""}
                      </span>
                      <span className={`block ${NOTE}`}>{GROUP_NOTE[group]}</span>
                    </button>
                  </li>
                );
              }
              return (
                <li key={group}>
                  <button
                    type="button"
                    aria-pressed={pressed}
                    disabled={!orderGroupField}
                    data-state={orders > 0 ? group : "none"}
                    onClick={toggle}
                    className={`${surface} grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 py-1.5 pr-3 @3xl:grid-cols-[4.5rem_minmax(0,1fr)_auto] @5xl:grid-cols-[10rem_7rem_5rem_minmax(0,1fr)]`}
                  >
                    <span className="font-medium @3xl:col-span-2 @5xl:col-span-1">{label}</span>
                    <span className="text-right font-medium tabular-nums">{amount}</span>
                    <span className={`${NOTE} col-span-2 tabular-nums @3xl:col-span-1`}>{count(orders, "order")}</span>
                    <span className={`${NOTE} col-span-2 @5xl:col-span-1`}>{GROUP_NOTE[group]}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ))}
        <p className={NOTE}>
          Orders made in the last {period} days, in {shown.join(", ")}. A deposit is part of a service&apos;s price: the
          rest is paid at the shop and is not in these totals. Select a line to filter the orders below.
        </p>
      </DatasetState>
    </WidgetFrame>
  );
}

const STATUS_RANK: Record<ScheduleStatus, number> = {
  review_required: 0,
  held: 1,
  confirmed: 1,
  expired: 2,
  cancelled: 2,
};

export function UpcomingBookingsWidget(params: WidgetParams) {
  const { rows, failed } = useWidgetRows(params);
  const { serverNow, data } = useDashboardState();

  const { upcoming, hidden } = useMemo(() => {
    const all = (rows ?? []).map((row) => {
      const holdExpiresAt = String(row.holdExpiresAt);
      const stored = row.status as ScheduleStatus;
      return { row, status: effectiveStatus({ status: stored, holdExpiresAt }, serverNow) };
    });
    // What still matters: anything that needs a person, and what has not ended yet.
    const keep = all.filter(
      ({ row, status }) =>
        status === "review_required" ||
        (STATUS_RANK[status] === 1 && Date.parse(String(row.endsAt)) > serverNow),
    );
    keep.sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        String(a.row.startsAt).localeCompare(String(b.row.startsAt)),
    );
    return { upcoming: keep, hidden: all.length - keep.length };
  }, [rows, serverNow]);

  return (
    <WidgetFrame>
      <DatasetState
        dataset="bookings"
        label="bookings"
        rows={rows}
        failed={failed}
        empty={
          <p>
            No bookings to show. When a buyer&apos;s assistant books a slot, the appointment appears here and on the{" "}
            <Link className={LINK} href="/seller/schedule">
              schedule
            </Link>
            .
          </p>
        }
      >
        {upcoming.length === 0 ? (
          <p className={SECONDARY}>Nothing coming up</p>
        ) : (
          <ul className="space-y-2">
            {upcoming.map(({ row, status }) => {
              const paymentStatus = row.paymentStatus as Parameters<typeof statusLabel>[1];
              const currency = String(row.currency);
              const reviewReason = (row.reviewReason || null) as "late_capture" | "captured_after_cancel" | null;
              const text = depositText(
                {
                  paymentStatus,
                  reviewReason,
                  depositMinor: Number(row.depositMinor),
                  remainingMinor: Number(row.remainingMinor),
                  currency,
                  holdExpiresLocal: String(row.holdExpiresLocal),
                },
                status,
              );
              return (
                <li key={String(row.bookingId)} className="booking-mark" data-status={status}>
                  <details>
                    <summary className="widget-summary grid grid-cols-[minmax(0,1fr)_1rem] gap-x-2 py-1 pr-2">
                      <span className="min-w-0">
                        <span className="block font-medium tabular-nums">{shopDateTime(String(row.startsLocal))}</span>
                        <span className="block break-words">{String(row.serviceTitle)}</span>
                        <span className={`block ${NOTE}`}>
                          {statusLabel(status, paymentStatus)}, with {String(row.technicianName)}
                        </span>
                      </span>
                      <Chevron />
                    </summary>
                    <div className="mt-1 mb-2 space-y-2 text-[13px] leading-5">
                      <p>{text}</p>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 tabular-nums">
                        <dt className={SECONDARY}>Service price</dt>
                        <dd>{money(Number(row.priceMinor), currency)}</dd>
                        <dt className={SECONDARY}>Deposit</dt>
                        <dd>{money(Number(row.depositMinor), currency)}</dd>
                        <dt className={SECONDARY}>Due at the shop</dt>
                        <dd>{money(Number(row.remainingMinor), currency)}</dd>
                        <dt className={SECONDARY}>Booking</dt>
                        <dd>{String(row.reference)}</dd>
                        {row.captureId ? (
                          <>
                            <dt className={SECONDARY}>PayPal capture</dt>
                            <dd className="break-all">{String(row.captureId)}</dd>
                          </>
                        ) : null}
                      </dl>
                      <Link
                        className={LINK}
                        href={`/seller/schedule?date=${String(row.startsDate).slice(0, 10)}`}
                      >
                        Open this day on the schedule
                      </Link>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
        {hidden > 0 ? (
          <p className={`mt-3 ${NOTE}`}>
            {count(hidden, "other booking")} in this period {hidden === 1 ? "has" : "have"} ended, expired or been
            cancelled
          </p>
        ) : null}
        {data.bookings ? (
          <p className={NOTE}>Times are in shop time ({data.bookings.timezone})</p>
        ) : null}
      </DatasetState>
    </WidgetFrame>
  );
}

// The screen's one bright element. The words a buyer's assistant used stay in carbon blue because
// they came from outside the system, and they are the largest words here. Everything else is ruled
// and quiet, like a page from a receipt book.
export function UnmetDemandWidget(params: WidgetParams) {
  const { rows, failed } = useWidgetRows(params);
  const { data } = useDashboardState();
  const demand = data.demand;

  return (
    <WidgetFrame>
      {demand && (demand.unmetSearches > 0 || demand.servedSearches > 0) ? (
        <p className={`mb-2 ${NOTE} tabular-nums`}>
          In the last {demand.periodDays} days, {searches(demand.unmetSearches)} that fit your shop found nothing, and{" "}
          {searches(demand.servedSearches)} returned your listings.
        </p>
      ) : null}
      <DatasetState
        dataset="demand"
        label="search demand"
        rows={rows}
        failed={failed}
        empty={
          <p>
            No missed searches in this period. When a buyer&apos;s assistant looks for something close to what you sell
            and finds nothing, the words it used appear here.
          </p>
        }
      >
        <ul>
          {(rows ?? []).map((row) => {
            const times = Number(row.searches);
            const origin = String(row.originLabel);
            // Recorded searches are the usual case, so only a demo sample says where it came from.
            const sampled = Number(row.sampleSearches) > 0;
            const basis = attributionBasis(String(row.sharedWords ?? ""), String(row.listings ?? ""));
            return (
              <li key={String(row.query)} className={RULE}>
                <details>
                  <summary className="widget-summary -mx-2 grid grid-cols-[minmax(0,1fr)_auto_1rem] items-baseline gap-x-3 px-2 py-2">
                    <span className="text-base leading-6 font-medium break-words text-ink @2xl:text-lg @2xl:leading-7">
                      {String(row.query)}
                    </span>
                    <span className={`grid grid-cols-[3ch_4rem] gap-x-1 ${NOTE} tabular-nums`}>
                      <span className="text-right font-medium text-foreground">{times}</span>
                      <span>{times === 1 ? "search" : "searches"}</span>
                    </span>
                    <Chevron />
                    <span className={`col-span-3 ${NOTE}`}>
                      {sampled ? `${origin}. ` : ""}
                      {basis}
                    </span>
                  </summary>
                  <div className="pb-3">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-[13px] leading-5">
                      <dt className={SECONDARY}>Source</dt>
                      <dd>{origin}</dd>
                      <dt className={SECONDARY}>Last searched</dt>
                      <dd className="tabular-nums">{shopDateTime(String(row.lastSearchedLocal))}</dd>
                      {row.askedFor ? (
                        <>
                          <dt className={SECONDARY}>Also asked for</dt>
                          <dd>{String(row.askedFor)}</dd>
                        </>
                      ) : null}
                    </dl>
                    {Number(row.degradedSearches) > 0 ? (
                      <p className="mt-1 border-l-4 border-doubt pl-3 text-[13px] leading-5">
                        {searches(Number(row.degradedSearches))} ran while some listings had no search terms, so this
                        may be a wording gap and not a gap in stock.
                      </p>
                    ) : null}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
        <p className={`mt-2 border-t border-zinc-200 pt-2 dark:border-zinc-800 ${NOTE}`}>
          Attribution basis: a search counts for your shop when it found nothing and your listings share at least half
          of its words about the item, within the place, currency and type asked for. Who searched is never recorded.
        </p>
      </DatasetState>
    </WidgetFrame>
  );
}

const widgetButton =
  "inline-flex h-9 flex-none items-center rounded-lg border border-zinc-300 px-3 text-sm font-medium transition-colors hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800";

const WRITE_FAILED =
  "Could not write an explanation just now. The observed counts here are still correct. Try again in a minute.";

function InsightStatus({
  insights,
  writing,
  failure,
  onWrite,
}: {
  insights: DashboardInsights;
  writing: boolean;
  failure: string | null;
  onWrite: () => void;
}) {
  const { state, insight, aiAvailable } = insights;
  const write = (label: string) =>
    aiAvailable ? (
      <button type="button" className={widgetButton} disabled={writing} onClick={onWrite}>
        {writing ? "Writing" : label}
      </button>
    ) : null;

  return (
    <div className="mb-2 space-y-2">
      {state === "stale" && insight ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-l-4 border-doubt pl-3">
          <p>
            Out of date. The notes below were written for {searches(insight.unmetSearches)} from{" "}
            {windowText(insight.windowStartDate, insight.windowEndDate)}, and the data has changed since. The counts
            are current.
          </p>
          {write("Write it again")}
        </div>
      ) : null}
      {state === "not_written" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className={SECONDARY}>
            {aiAvailable
              ? "The counts below are observed. A short note on what they may mean is written when you ask."
              : "The counts below are observed. Written notes are not set up on this service."}
          </p>
          {write("Explain these searches")}
        </div>
      ) : null}
      {failure ? (
        <p role="alert" className="border-l-4 border-blocked pl-3">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

function InsightSuggestion({ item, stale }: { item: DemandInsightItem; stale: boolean }) {
  return (
    <div className="mt-2 border-l-4 border-doubt pl-3">
      <p className={`${NOTE} font-medium`}>
        Written by a model, not a recorded fact
        {stale ? `. Written when this group had ${searches(item.searchesAtWriting)}` : ""}
      </p>
      <p>{item.explanation}</p>
      <p>
        <span className="font-medium">Suggestion: </span>
        {item.suggestedAction}
      </p>
    </div>
  );
}

export function DemandInsightWidget(params: WidgetParams) {
  const { rows, failed } = useWidgetRows(params);
  const { data } = useDashboardState();
  const insights = data.insights;
  const [writing, setWriting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const visible = useMemo(() => new Set((rows ?? []).map((row) => String(row.groupId))), [rows]);
  const period = insights?.periodDays;

  async function write() {
    setWriting(true);
    setFailure(null);
    try {
      const response = await fetch("/api/seller/dashboard/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: String(period) }),
        signal: AbortSignal.timeout(90_000),
      });
      const body = (await response.json().catch(() => null)) as
        | (DashboardInsights & { error?: { message?: string } })
        | null;
      if (response.ok && body) {
        setDashboardState({ data: { ...data, insights: body } });
      } else {
        setFailure(body?.error?.message ?? WRITE_FAILED);
      }
    } catch {
      setFailure(WRITE_FAILED);
    } finally {
      setWriting(false);
    }
  }

  const windowLine = insights ? windowText(insights.periodStartDate, insights.periodEndDate) : "";
  const stale = insights?.state === "stale";

  return (
    <WidgetFrame>
      {insights && insights.state !== "no_data" ? (
        <p className={`mb-2 ${NOTE} tabular-nums`}>
          Analysis window: {windowLine}, shop time. {searches(insights.unmetSearches)} in all.
          {insights.insight && !stale ? ` Notes written ${shopDateTime(insights.insight.writtenLocal)}.` : ""}
        </p>
      ) : null}
      {insights?.state === "no_data" ? (
        <p className={SECONDARY}>
          No missed search fits your shop from {windowLine}. There is nothing to explain yet, and nothing here estimates
          demand or revenue.
        </p>
      ) : (
        <DatasetState
          dataset="insights"
          label="search groups"
          rows={rows}
          failed={failed}
          empty={<p>No search group matches the filters on this page.</p>}
        >
          {insights ? (
            <InsightStatus insights={insights} writing={writing} failure={failure} onWrite={() => void write()} />
          ) : null}
          <ul>
            {(insights?.groups ?? [])
              .filter((group) => visible.has(group.groupId))
              .map((group) => {
                const item = insights?.insight?.items.find((entry) => entry.groupId === group.groupId);
                // A group asked for in one wording, the same as its label, has nothing more to show.
                const oneWording =
                  group.examples.length === 1 && group.examplesOmitted === 0 && group.examples[0].query === group.label;
                return (
                  <li key={group.groupId} className={`${RULE} grid gap-x-6 gap-y-1 py-3 @3xl:grid-cols-[18rem_minmax(0,1fr)]`}>
                    <p className="text-base leading-6 font-medium break-words text-ink">{group.label}</p>
                    <div className="min-w-0">
                      <p className="tabular-nums">
                        <span className="font-medium">Observed: </span>
                        {demandObservation(group)}
                      </p>
                      {oneWording ? null : (
                        <p className={`${NOTE} tabular-nums`}>
                          Worded as{" "}
                          {group.examples.map(({ query, searches: times }, index) => (
                            <span key={query}>
                              {index > 0 ? ", " : ""}
                              <span className="text-ink">{query}</span> ({times})
                            </span>
                          ))}
                          {group.examplesOmitted > 0 ? ` and ${count(group.examplesOmitted, "more wording")}` : ""}
                        </p>
                      )}
                      {group.degradedSearches > 0 ? (
                        <p className="mt-1 border-l-4 border-doubt pl-3 text-[13px] leading-5">
                          {searches(group.degradedSearches)} ran while some listings had no search terms, so this may be
                          a wording gap and not a gap in stock.
                        </p>
                      ) : null}
                      <details className={`mt-1 ${NOTE}`}>
                        <summary className="widget-summary inline-flex items-center gap-x-1 pr-2">
                          Source search events
                          <Chevron />
                        </summary>
                        <p className="break-words tabular-nums">
                          {group.eventRefs.map((ref) => ref.slice(0, 8).toUpperCase()).join(", ")}
                          {group.eventRefsOmitted > 0 ? `, and ${group.eventRefsOmitted} more` : ""}
                        </p>
                      </details>
                      {item ? <InsightSuggestion item={item} stale={stale} /> : null}
                    </div>
                  </li>
                );
              })}
          </ul>
        </DatasetState>
      )}
    </WidgetFrame>
  );
}
