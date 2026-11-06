"use client";

import type { AgWidgetField, AgWidgetParams } from "ag-studio";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { DashboardPaymentTotal, PaymentGroup } from "@/server/contracts/seller-dashboard";
import type { ScheduleStatus } from "@/server/contracts/seller-schedule";

import { depositText, effectiveStatus, statusLabel } from "../schedule/schedule-labels";
import {
  PAYMENT_GROUP_LABELS,
  attributionBasis,
  count,
  groupTotals,
  money,
  searches,
  shopDateTime,
} from "./dashboard-labels";
import { useDashboardState, type DatasetName } from "./dashboard-store";

// The three AgentShelf widgets inside AG Studio. They are plain React, and read their rows through
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

function WidgetFrame({ children }: { children: ReactNode }) {
  return <div className="h-full overflow-y-auto px-1.5 font-sans text-sm text-zinc-900 dark:text-zinc-100">{children}</div>;
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
      <p className="text-zinc-600 dark:text-zinc-400">Loading {label}</p>
    );
  }
  if (failed) {
    return (
      <p className="border-l-4 border-blocked pl-3">Could not read {label}. Reload the page to try again.</p>
    );
  }
  if (rows === null) {
    return <p className="text-zinc-600 dark:text-zinc-400">Loading {label}</p>;
  }
  return rows.length === 0 ? <div className="text-zinc-600 dark:text-zinc-400">{empty}</div> : <>{children}</>;
}

const GROUP_ORDER: PaymentGroup[] = ["paid", "awaiting", "review", "closed"];

const GROUP_NOTE: Record<PaymentGroup, string> = {
  paid: "Captures PayPal confirmed. This is your revenue for the period.",
  awaiting: "Buyers have a link or approved it. Not revenue until captured.",
  review: "Does not match PayPal. Check these before you act.",
  closed: "Cancelled, failed or never had a link.",
};

const GROUP_ACCENT: Record<PaymentGroup, string> = {
  paid: "border-accepted",
  awaiting: "border-doubt",
  review: "border-blocked",
  closed: "border-zinc-300 dark:border-zinc-700",
};

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
            <Link className="underline underline-offset-4" href="/seller/catalog">
              catalog
            </Link>{" "}
            is published.
          </p>
        }
      >
        {shown.map((currency) => (
          <div key={currency}>
            <ul className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
              {GROUP_ORDER.map((group) => {
                const total = totals.find((entry) => entry.group === group && entry.currency === currency);
                const label = PAYMENT_GROUP_LABELS[group];
                const pressed = selected.includes(JSON.stringify(label));
                return (
                  <li key={group}>
                    <button
                      type="button"
                      aria-pressed={pressed}
                      disabled={!orderGroupField}
                      onClick={() =>
                        orderGroupField &&
                        params.widgetApi.toggleCrossFilter({
                          type: "value",
                          group: 0,
                          field: orderGroupField,
                          value: label,
                        })
                      }
                      className={`h-full w-full rounded-md border-l-4 ${GROUP_ACCENT[group]} px-3 py-1 text-left hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink dark:hover:bg-zinc-800 ${pressed ? "bg-zinc-100 dark:bg-zinc-800" : ""}`}
                    >
                      <span className="flex h-full flex-col justify-start">
                      <span className="block font-medium">{label}</span>
                      <span className="block text-xl font-semibold tabular-nums">
                        {money(total?.amountMinor ?? 0, currency)}
                      </span>
                      <span className="block text-xs text-zinc-600 tabular-nums dark:text-zinc-400">
                        {count(total?.orderCount ?? 0, "order")}
                        {group === "paid" && total?.depositsMinor
                          ? `, of which ${money(total.depositsMinor, currency)} is deposits`
                          : ""}
                      </span>
                      <span className="mt-0.5 block text-xs text-zinc-600 dark:text-zinc-400">{GROUP_NOTE[group]}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          Orders made in the last {period} days, in {shown.join(", ")}. A deposit is part of a service&apos;s price: the
          rest is paid at the shop and is not in these totals. Select a box to filter the orders below.
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
            No bookings to show. When a buyer pays a deposit, the appointment appears here and on the{" "}
            <Link className="underline underline-offset-4" href="/seller/schedule">
              schedule
            </Link>
            .
          </p>
        }
      >
        {upcoming.length === 0 ? (
          <p className="text-zinc-600 dark:text-zinc-400">Nothing coming up.</p>
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
                    <summary className="widget-summary rounded-sm">
                      <span className="font-medium tabular-nums">{shopDateTime(String(row.startsLocal))}</span>
                      <span> {String(row.serviceTitle)}</span>
                      <span className="block text-xs text-zinc-600 dark:text-zinc-400">
                        {statusLabel(status, paymentStatus)}, with {String(row.technicianName)}
                      </span>
                    </summary>
                    <div className="mt-1 space-y-1 text-xs">
                      <p>{text}</p>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 tabular-nums">
                        <dt className="text-zinc-600 dark:text-zinc-400">Service price</dt>
                        <dd>{money(Number(row.priceMinor), currency)}</dd>
                        <dt className="text-zinc-600 dark:text-zinc-400">Deposit</dt>
                        <dd>{money(Number(row.depositMinor), currency)}</dd>
                        <dt className="text-zinc-600 dark:text-zinc-400">Due at the shop</dt>
                        <dd>{money(Number(row.remainingMinor), currency)}</dd>
                        <dt className="text-zinc-600 dark:text-zinc-400">Booking</dt>
                        <dd>{String(row.reference)}</dd>
                        {row.captureId ? (
                          <>
                            <dt className="text-zinc-600 dark:text-zinc-400">PayPal capture</dt>
                            <dd className="break-all">{String(row.captureId)}</dd>
                          </>
                        ) : null}
                      </dl>
                      <Link
                        className="underline underline-offset-4"
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
          <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
            {count(hidden, "other booking")} in this period ended, expired or was cancelled.
          </p>
        ) : null}
        {data.bookings ? (
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            Times are in shop time ({data.bookings.timezone}).
          </p>
        ) : null}
      </DatasetState>
    </WidgetFrame>
  );
}

export function UnmetDemandWidget(params: WidgetParams) {
  const { rows, failed } = useWidgetRows(params);
  const { data } = useDashboardState();
  const demand = data.demand;

  return (
    <WidgetFrame>
      {demand ? (
        <p className="mb-2 text-xs text-zinc-600 tabular-nums dark:text-zinc-400">
          In the last {demand.periodDays} days, {searches(demand.unmetSearches)}{" "}
          found nothing but matched your shop, and{" "}
          {searches(demand.servedSearches)} returned your listings.
        </p>
      ) : null}
      <DatasetState
        dataset="demand"
        label="search demand"
        rows={rows}
        failed={failed}
        empty={<p>No searches found nothing and matched your shop in this period.</p>}
      >
        <ul className="space-y-2">
          {(rows ?? []).map((row) => (
            <li key={String(row.query)}>
              <details>
                <summary className="widget-summary rounded-sm">
                  <span className="font-medium text-ink">{String(row.query)}</span>
                  <span className="text-zinc-600 tabular-nums dark:text-zinc-400">
                    {" "}
                    {searches(Number(row.searches))}
                  </span>
                  <span className="block text-xs text-zinc-600 dark:text-zinc-400">
                    {attributionBasis(String(row.sharedWords ?? ""), String(row.listings ?? ""))}
                  </span>
                </summary>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs">
                  <dt className="text-zinc-600 dark:text-zinc-400">Source</dt>
                  <dd>{String(row.originLabel)}</dd>
                  <dt className="text-zinc-600 dark:text-zinc-400">Last searched</dt>
                  <dd className="tabular-nums">{shopDateTime(String(row.lastSearchedLocal))}</dd>
                  {row.askedFor ? (
                    <>
                      <dt className="text-zinc-600 dark:text-zinc-400">Also asked for</dt>
                      <dd>{String(row.askedFor)}</dd>
                    </>
                  ) : null}
                </dl>
                {Number(row.degradedSearches) > 0 ? (
                  <p className="mt-1 text-xs text-doubt">
                    {searches(Number(row.degradedSearches))} ran while some
                    listings had no search terms, so this may be a wording gap and not a gap in stock.
                  </p>
                ) : null}
              </details>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          Attribution basis: a search counts for your shop when it found nothing and your listings share at least half
          of its words about the item, within the place, currency and type asked for. Who searched is never recorded.
        </p>
      </DatasetState>
    </WidgetFrame>
  );
}
