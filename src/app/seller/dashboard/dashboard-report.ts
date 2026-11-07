import type { AgReportState, AgWidgetLayoutState } from "ag-studio";

import type { DemandChartMeasure } from "@/server/contracts/seller-insights";

// The dashboard a seller sees first, as AG Studio report state, and how a seller's own arrangement
// of it is kept. Field IDs are `table.field`, from dashboard-data.ts.

export const PAYMENT_STATUS_WIDGET = "agentshelf-payment-status";
export const UPCOMING_BOOKINGS_WIDGET = "agentshelf-upcoming-bookings";
export const UNMET_DEMAND_WIDGET = "agentshelf-unmet-demand";
export const DEMAND_INSIGHT_WIDGET = "agentshelf-demand-insight";

// Raise this when a widget, field or table changes, so nobody restores a report Studio would refuse.
const REPORT_VERSION = 3;
const PAGE_ID = "counter";

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({
  xTrack,
  yTrack,
  xSpan,
  ySpan,
});
const title = (text: string) => ({ title: { enabled: true, text } });
const fields = (table: string, ids: string[]) => ids.map((id) => ({ id: `${table}.${id}` }));
// A filter's label is its field's name, so it needs no title of its own.
const FILTER_FORMAT = { title: { enabled: false }, style: { selection: { type: "multiple" }, dimensions: { height: 32, minWidth: 48 } } };
// A hairline in the widget's own color keeps the two parts of a stacked column apart.
const STACKED_WITH_LEGEND = {
  style: {
    theme: { common: { legend: { enabled: true } } },
    custom: { seriesStroke: { enabled: true, strokeWidth: 1 } },
  },
};
const sum = (id: string) => ({ id, aggregation: "sum" as const });
// Tall enough for the ledger's two-row lines on a page narrower than a laptop's.
const PAYMENT_ROWS = 17;
const FILTER_ROWS = 6;

// A deliberate order for a counter: money first, then who is coming in and what people could not
// find, then the charts, and the full list of orders at the bottom.
export function defaultReport(): AgReportState {
  const report = {
    selectedPageId: PAGE_ID,
    panels: { filters: { collapsed: true } },
    pages: [
      {
        id: PAGE_ID,
        layout: { minWidth: 320, type: "widget" },
        widgets: {
          "payment-status": {
            type: PAYMENT_STATUS_WIDGET,
            dataMapping: {
              fields: fields("paymentTotals", ["key", "group", "kind", "currency", "amountMinor", "orderCount"]),
              orderGroup: [{ id: "orders.groupLabel" }],
            },
            format: title("Payment status"),
          },
          "booking-state": {
            type: "button-filter",
            dataMapping: { value: [{ id: "bookings.statusLabel" }] },
            format: FILTER_FORMAT,
          },
          "booking-technician": {
            type: "button-filter",
            dataMapping: { value: [{ id: "bookings.technicianName" }] },
            format: FILTER_FORMAT,
          },
          "demand-source": {
            type: "button-filter",
            dataMapping: { value: [{ id: "demand.originLabel" }] },
            format: FILTER_FORMAT,
          },
          "upcoming-bookings": {
            type: UPCOMING_BOOKINGS_WIDGET,
            dataMapping: {
              fields: fields("bookings", [
                "bookingId",
                "reference",
                "status",
                "reviewReason",
                "paymentStatus",
                "serviceTitle",
                "technicianName",
                "startsDate",
                "startsLocal",
                "endsLocal",
                "startsAt",
                "endsAt",
                "holdExpiresAt",
                "holdExpiresLocal",
                "priceMinor",
                "depositMinor",
                "remainingMinor",
                "currency",
                "captureId",
              ]),
            },
            format: title("Upcoming bookings"),
          },
          "unmet-demand": {
            type: UNMET_DEMAND_WIDGET,
            dataMapping: {
              fields: fields("demand", [
                "query",
                "originLabel",
                "searches",
                "sampleSearches",
                "degradedSearches",
                "lastSearchedLocal",
                "sharedWords",
                "listings",
                "askedFor",
              ]),
            },
            format: title("What people could not find"),
          },
          "demand-insight": {
            type: DEMAND_INSIGHT_WIDGET,
            dataMapping: {
              fields: fields("demandGroups", ["groupId", "label", "searches"]),
            },
            format: title("What these searches may mean"),
          },
          "captured-by-day": {
            type: "column-chart-stacked",
            dataMapping: {
              categoryKey: [{ id: "captures.createdDate" }],
              valueKey: [sum("captures.purchaseAmount"), sum("captures.depositAmount")],
            },
            format: { ...title("Captured by the day the order was made"), ...STACKED_WITH_LEGEND },
          },
          "paid-by-item": {
            type: "bar-chart-grouped",
            dataMapping: {
              categoryKey: [{ id: "orderLines.title" }],
              valueKey: [sum("orderLines.paidAmount")],
            },
            format: title("Paid by item"),
          },
          "order-kind": {
            type: "button-filter",
            dataMapping: { value: [{ id: "orders.kindLabel" }] },
            format: FILTER_FORMAT,
          },
          "order-state": {
            type: "button-filter",
            dataMapping: { value: [{ id: "orders.statusLabel" }] },
            format: FILTER_FORMAT,
          },
          orders: {
            type: "grid",
            dataMapping: {
              // The money columns come before the items, so a long list of items is what runs off the
              // edge of a narrow window, and never an amount.
              cols: fields("orders", [
                "reference",
                "createdLabel",
                "kindLabel",
                "statusLabel",
                "groupLabel",
                "totalMinor",
                "currency",
                "items",
              ]),
            },
            format: {
              ...title("Orders"),
              style: { columnAutoSize: true },
              subtitle: { enabled: true, text: "Open an order for its lines, capture and what the amount means" },
            },
          },
        },
        widgetLayout: {
          // Two columns under the money, each filter over the list it narrows: the bookings with
          // their state and technician, and the list of what people could not find, given more of
          // the page than the bookings beside it.
          "payment-status": at(0, 0, 24, PAYMENT_ROWS),
          "booking-state": at(0, 17, 9, FILTER_ROWS),
          "booking-technician": at(0, 23, 9, FILTER_ROWS),
          "demand-source": at(9, 17, 15, FILTER_ROWS),
          "upcoming-bookings": at(0, 29, 9, 24),
          "unmet-demand": at(9, 23, 15, 30),
          "demand-insight": at(0, 53, 24, 30),
          "captured-by-day": at(0, 83, 15, 20),
          "paid-by-item": at(15, 83, 9, 20),
          "order-kind": at(0, 103, 6, FILTER_ROWS),
          "order-state": at(6, 103, 18, FILTER_ROWS),
          orders: at(0, 109, 24, 32),
        },
      },
    ],
  };
  return report as unknown as AgReportState;
}

// What a widget needs in a phone's one narrow column. A filter's buttons wrap and the payment lines
// stack, so those two grow to a fixed height. Anything else wraps more the wider it was, so it grows
// with its width, up to about one screen of a phone.
function phoneRows(ySpan: number, xSpan: number): number {
  if (ySpan <= FILTER_ROWS) {
    return 12;
  }
  if (ySpan <= PAYMENT_ROWS) {
    return 36;
  }
  return Math.min(Math.ceil(ySpan * (1 + xSpan / 40)), 44);
}

type Placed = { layout: AgWidgetLayoutState; index: number };

// A phone gets one column. Widgets stacked in one column of the page, like a filter over the list it
// narrows, stay together, and each stack comes in the order it starts on the page. Returns the new
// places in the order the widgets were given.
export function phoneLayout(layouts: AgWidgetLayoutState[], columns: number): AgWidgetLayoutState[] {
  const sorted = layouts
    .map((layout, index) => ({ layout, index }))
    .sort((a, b) => a.layout.yTrack - b.layout.yTrack || a.layout.xTrack - b.layout.xTrack);
  const stacks: Placed[][] = [];
  for (const item of sorted) {
    const stack = stacks.find((candidate) => {
      const last = candidate[candidate.length - 1].layout;
      return (
        last.xTrack === item.layout.xTrack &&
        last.xSpan === item.layout.xSpan &&
        last.yTrack + last.ySpan === item.layout.yTrack
      );
    });
    if (stack) {
      stack.push(item);
    } else {
      stacks.push([item]);
    }
  }
  const placed = new Array<AgWidgetLayoutState>(layouts.length);
  let yTrack = 0;
  for (const { layout, index } of stacks.flat()) {
    const ySpan = phoneRows(layout.ySpan, layout.xSpan);
    placed[index] = { xTrack: 0, yTrack, xSpan: columns, ySpan };
    yTrack += ySpan;
  }
  return placed;
}

export const DEMAND_CHART_ID = "demand-chart";

const CHART_FIELDS: Record<DemandChartMeasure, { field: string; title: string }> = {
  all: { field: "searches", title: "Searches that found nothing, by group" },
  recorded: { field: "recordedSearches", title: "Recorded searches that found nothing, by group" },
  demo_sample: { field: "sampleSearches", title: "Demo samples that found nothing, by group" },
};

const CHART_HEIGHT = 16;

type ReportPage = {
  id: string;
  widgets: Record<string, unknown>;
  widgetLayout: Record<string, AgWidgetLayoutState>;
};

// The one widget the assistant may create or change, as new state. It touches this widget and, the
// first time, moves what sits below the insight down to make room. Nothing else on the page changes.
export function withDemandChart(state: AgReportState, measure: DemandChartMeasure): AgReportState {
  const { field, title: text } = CHART_FIELDS[measure];
  const widget = {
    type: "bar-chart-grouped",
    dataMapping: {
      categoryKey: [{ id: "demandGroups.label" }],
      valueKey: [sum(`demandGroups.${field}`)],
    },
    format: title(text),
  };
  const pages = (state.pages as unknown as ReportPage[]).map((page) => {
    if (page.id !== state.selectedPageId) {
      return page;
    }
    if (page.widgetLayout[DEMAND_CHART_ID]) {
      return { ...page, widgets: { ...page.widgets, [DEMAND_CHART_ID]: widget } };
    }
    const layouts = Object.values(page.widgetLayout);
    const insight = page.widgetLayout["demand-insight"];
    const row = insight
      ? insight.yTrack + insight.ySpan
      : Math.max(0, ...layouts.map(({ yTrack, ySpan }) => yTrack + ySpan));
    const moved = Object.fromEntries(
      Object.entries(page.widgetLayout).map(([id, layout]) => [
        id,
        layout.yTrack >= row ? { ...layout, yTrack: layout.yTrack + CHART_HEIGHT } : layout,
      ]),
    );
    return {
      ...page,
      widgets: { ...page.widgets, [DEMAND_CHART_ID]: widget },
      widgetLayout: { ...moved, [DEMAND_CHART_ID]: at(0, row, 24, CHART_HEIGHT) },
    };
  });
  return { ...state, pages } as unknown as AgReportState;
}

export function layoutStorageKey(shopId: string): string {
  return `agentshelf.dashboard.layout.v${REPORT_VERSION}.${shopId}`;
}

type SavedPage = { id?: unknown; widgets?: unknown; widgetLayout?: unknown; layout?: unknown };

// What is worth keeping between visits: which widgets there are and where. A saved report carries
// no filter or cross filter, because a selected value can name a buyer's search or an order.
export function layoutOnly(state: AgReportState): AgReportState {
  return {
    selectedPageId: state.selectedPageId,
    panels: state.panels,
    pages: state.pages.map(({ id, widgets, widgetLayout, layout }) => ({ id, widgets, widgetLayout, layout })),
  } as AgReportState;
}

// A stored value is only a hint: anything unexpected falls back to the default dashboard.
export function parseSavedLayout(stored: string | null): AgReportState | null {
  if (!stored) {
    return null;
  }
  try {
    const parsed = JSON.parse(stored) as { selectedPageId?: unknown; pages?: unknown };
    const pages = parsed?.pages;
    const valid =
      typeof parsed?.selectedPageId === "string" &&
      Array.isArray(pages) &&
      pages.length > 0 &&
      pages.every(
        (page: SavedPage) =>
          typeof page?.id === "string" &&
          typeof page.widgets === "object" &&
          page.widgets !== null &&
          typeof page.widgetLayout === "object" &&
          page.widgetLayout !== null,
      ) &&
      pages.some((page: SavedPage) => page.id === parsed.selectedPageId);
    return valid ? layoutOnly(parsed as unknown as AgReportState) : null;
  } catch {
    return null;
  }
}

export function loadSavedLayout(shopId: string): AgReportState | null {
  try {
    return parseSavedLayout(window.localStorage.getItem(layoutStorageKey(shopId)));
  } catch {
    return null;
  }
}

export function saveLayout(shopId: string, state: AgReportState) {
  try {
    window.localStorage.setItem(layoutStorageKey(shopId), JSON.stringify(layoutOnly(state)));
  } catch {
    // A browser that keeps nothing still shows the default dashboard next time.
  }
}

export function clearSavedLayout(shopId: string) {
  try {
    window.localStorage.removeItem(layoutStorageKey(shopId));
  } catch {
    // Nothing was kept, so there is nothing to clear.
  }
}
