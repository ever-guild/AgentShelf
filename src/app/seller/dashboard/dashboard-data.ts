import type { AgDataSourcesDefinition, AgFieldDefinition } from "ag-studio";

import { statusLabel } from "../schedule/schedule-labels";
import { ORDER_KIND_LABELS, PAYMENT_GROUP_LABELS, money, orderStatusLabel, shopDateTime } from "./dashboard-labels";
import type { Datasets } from "./dashboard-store";

// The server datasets as AG Studio tables. Amounts stay integer minor units in the engine, so
// a sum is exact, and only the formatter turns them into text.

type Spec = [id: string, name: string, format: "text" | "date" | "int" | "money" | "chart", hide?: boolean];

// Studio reads a date field as local midnight in the browser, so it is formatted in the browser's
// zone too, and a shop's calendar day comes out as written wherever the seller is.
const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

// Charts draw their axes from the raw number, so a chart's measure is in whole units rather than
// cents. It is derived for drawing only: every total on the page is summed from minor units.
const toChartAmount = (minor: number) => minor / 100;

function moneyField(currency: string, id: string, name: string): AgFieldDefinition {
  return {
    id,
    name,
    format: "currencyFormat",
    createValueFormatter: () => (value: number) => money(Math.round(value), currency),
  } as AgFieldDefinition;
}

function chartField(currency: string, id: string, name: string): AgFieldDefinition {
  return {
    id,
    name: `${name}, ${currency}`,
    format: "decimalFormat",
    createValueFormatter: () => (value: number) => money(Math.round(value * 100), currency),
  } as AgFieldDefinition;
}

function fieldsOf(currency: string, specs: Spec[]): AgFieldDefinition[] {
  return specs.map(([id, name, format, hide]) => {
    switch (format) {
      case "money":
        return moneyField(currency, id, name);
      case "chart":
        return chartField(currency, id, name);
      case "date":
        return { id, name, format: "dateFormat", formatOptions: { format: DAY_FORMAT } };
      default:
        return {
          id,
          name,
          format: format === "int" ? "integerFormat" : "textFormat",
          ...(hide ? { hide } : {}),
        };
    }
  });
}

const ORDER_FIELDS: Spec[] = [
  ["orderId", "Order ID", "text", true],
  ["reference", "Order", "text"],
  ["kindLabel", "Type", "text"],
  ["groupLabel", "Money", "text"],
  ["statusLabel", "Payment state", "text"],
  ["items", "Items", "text"],
  ["totalMinor", "Amount", "money"],
  ["currency", "Currency", "text"],
  ["createdDate", "Created", "date"],
  ["createdLabel", "Created at", "text"],
];

const LINE_FIELDS: Spec[] = [
  ["lineKey", "Line", "text", true],
  ["orderId", "Order ID", "text", true],
  ["title", "Item", "text"],
  ["quantity", "Quantity", "int"],
  ["lineTotalMinor", "Line total", "money"],
  ["paidAmount", "Paid", "chart"],
];

const CAPTURE_FIELDS: Spec[] = [
  ["captureId", "PayPal capture", "text"],
  ["reference", "Order", "text"],
  ["kindLabel", "Type", "text"],
  ["createdDate", "Order day", "date"],
  ["purchaseAmount", "Purchases", "chart"],
  ["depositAmount", "Booking deposits", "chart"],
  ["amountMinor", "Captured", "money"],
  ["currency", "Currency", "text"],
];

const TOTAL_FIELDS: Spec[] = [
  ["key", "Key", "text", true],
  ["group", "Group key", "text", true],
  ["groupLabel", "Money", "text"],
  ["kind", "Kind key", "text", true],
  ["kindLabel", "Type", "text"],
  ["currency", "Currency", "text"],
  ["amountMinor", "Amount", "money"],
  ["orderCount", "Orders", "int"],
];

const BOOKING_FIELDS: Spec[] = [
  ["bookingId", "Booking ID", "text", true],
  ["reference", "Booking", "text"],
  ["status", "State key", "text", true],
  ["statusLabel", "Booking state", "text"],
  ["reviewReason", "Review reason", "text", true],
  ["paymentStatus", "Payment key", "text", true],
  ["serviceTitle", "Service", "text"],
  ["technicianName", "Technician", "text"],
  ["startsDate", "Day", "date"],
  ["startsLocal", "Starts", "text"],
  ["endsLocal", "Ends", "text"],
  ["startsAt", "Starts instant", "text", true],
  ["endsAt", "Ends instant", "text", true],
  ["holdExpiresAt", "Hold ends instant", "text", true],
  ["holdExpiresLocal", "Hold ends", "text"],
  ["priceMinor", "Service price", "money"],
  ["depositMinor", "Deposit", "money"],
  ["remainingMinor", "Due at the shop", "money"],
  ["currency", "Currency", "text"],
  ["captureId", "PayPal capture", "text"],
];

const DEMAND_FIELDS: Spec[] = [
  ["query", "Search", "text"],
  ["originLabel", "Search source", "text"],
  ["searches", "Searches", "int"],
  ["sampleSearches", "Demo samples", "int"],
  ["degradedSearches", "Possible wording gaps", "int"],
  ["lastSearchedLocal", "Last searched", "text"],
  ["sharedWords", "Shared words", "text"],
  ["listings", "Closest listings", "text"],
  ["askedFor", "Also asked for", "text"],
];

const DEMAND_GROUP_FIELDS: Spec[] = [
  ["groupId", "Group ID", "text", true],
  ["label", "Search group", "text"],
  ["searches", "All searches", "int"],
  ["recordedSearches", "Recorded searches", "int"],
  ["sampleSearches", "Demo samples", "int"],
  ["degradedSearches", "Possible wording gaps", "int"],
];

export function demandOriginLabel(row: { searches: number; sampleSearches: number }): string {
  if (row.sampleSearches === 0) {
    return "Recorded";
  }
  return row.sampleSearches === row.searches ? "Demo sample" : "Recorded and demo sample";
}

export function buildStudioData(data: Datasets, shopCurrency: string): AgDataSourcesDefinition {
  const orders = data.orders?.orders ?? [];
  const totals = data.payments?.totals ?? [];
  const captures = data.payments?.captures ?? [];
  const bookings = data.bookings?.bookings ?? [];
  const demand = data.demand?.demand ?? [];
  const demandGroups = data.insights?.groups ?? [];

  return {
    description:
      "One shop's orders, captured payments, bookings and the searches attributed to it, for the selected period. Amounts are integer minor units, so filter by currency before adding money.",
    sources: [
      {
        id: "paymentTotals",
        name: "Payment totals",
        primaryKeyField: "key",
        description: "Sums by the database over every order in the period, by money group and type.",
        fields: fieldsOf(shopCurrency, TOTAL_FIELDS),
        data: totals.map((total) => ({
          key: `${total.group}|${total.kind}|${total.currency}`,
          group: total.group,
          groupLabel: PAYMENT_GROUP_LABELS[total.group],
          kind: total.kind,
          kindLabel: ORDER_KIND_LABELS[total.kind],
          currency: total.currency,
          amountMinor: total.amountMinor,
          orderCount: total.orderCount,
        })),
      },
      {
        id: "orders",
        name: "Orders",
        primaryKeyField: "orderId",
        description: "One row per order created in the period, newest first.",
        fields: fieldsOf(shopCurrency, ORDER_FIELDS),
        data: orders.map((order) => ({
          orderId: order.orderId,
          reference: order.reference,
          kindLabel: ORDER_KIND_LABELS[order.kind],
          groupLabel: PAYMENT_GROUP_LABELS[order.paymentGroup],
          statusLabel: orderStatusLabel(order),
          items: order.items,
          totalMinor: order.totalMinor,
          currency: order.currency,
          createdDate: order.createdDate,
          createdLabel: shopDateTime(order.createdLocal),
        })),
      },
      {
        id: "orderLines",
        name: "Order lines",
        primaryKeyField: "lineKey",
        description: "What each order was for, as it was sold. `paidAmount` is the line total on paid orders only, in whole units.",
        fields: fieldsOf(shopCurrency, LINE_FIELDS),
        data: orders.flatMap((order) =>
          order.lines.map((line) => ({
            lineKey: `${order.orderId}|${line.productId}`,
            orderId: order.orderId,
            title: line.title,
            quantity: line.quantity,
            lineTotalMinor: line.lineTotalMinor,
            paidAmount: toChartAmount(order.paymentGroup === "paid" ? line.lineTotalMinor : 0),
          })),
        ),
      },
      {
        id: "captures",
        name: "Captured payments",
        primaryKeyField: "captureId",
        description: "One row per order reconciliation marked paid, with its PayPal capture.",
        fields: fieldsOf(shopCurrency, CAPTURE_FIELDS),
        data: captures.map((capture) => ({
          captureId: capture.captureId,
          reference: capture.reference,
          kindLabel: ORDER_KIND_LABELS[capture.kind],
          createdDate: capture.createdDate,
          purchaseAmount: toChartAmount(capture.kind === "purchase" ? capture.amountMinor : 0),
          depositAmount: toChartAmount(capture.kind === "booking_deposit" ? capture.amountMinor : 0),
          amountMinor: capture.amountMinor,
          currency: capture.currency,
        })),
      },
      {
        id: "bookings",
        name: "Bookings",
        primaryKeyField: "bookingId",
        description: "Every booking from the start of the period to 31 days ahead, in every state.",
        fields: fieldsOf(shopCurrency, BOOKING_FIELDS),
        data: bookings.map((booking) => ({
          bookingId: booking.bookingId,
          reference: booking.reference,
          status: booking.status,
          statusLabel: statusLabel(booking.status, booking.paymentStatus),
          reviewReason: booking.reviewReason ?? "",
          paymentStatus: booking.paymentStatus,
          serviceTitle: booking.serviceTitle,
          technicianName: booking.technicianName,
          startsDate: booking.startsDate,
          startsLocal: booking.startsLocal,
          endsLocal: booking.endsLocal,
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
          holdExpiresAt: booking.holdExpiresAt,
          holdExpiresLocal: booking.holdExpiresLocal,
          priceMinor: booking.priceMinor,
          depositMinor: booking.depositMinor,
          remainingMinor: booking.remainingMinor,
          currency: booking.currency,
          captureId: booking.captureId ?? "",
        })),
      },
      {
        id: "demand",
        name: "Search demand",
        primaryKeyField: "query",
        description:
          "Searches in the period that found nothing and are attributed to this shop, with the attribution basis. Fixtures are labeled.",
        fields: fieldsOf(shopCurrency, DEMAND_FIELDS),
        data: demand.map((row) => ({
          query: row.query,
          originLabel: demandOriginLabel(row),
          searches: row.searches,
          sampleSearches: row.sampleSearches,
          degradedSearches: row.degradedSearches,
          lastSearchedLocal: row.lastSearchedLocal,
          sharedWords: row.sharedWords.join(", "),
          listings: row.listings.join(", "),
          askedFor: askedFor(row),
        })),
      },
      {
        id: "demandGroups",
        name: "Search groups",
        primaryKeyField: "groupId",
        description:
          "The same attributed searches, with queries that hold the same words grouped together. Counted by the database.",
        fields: fieldsOf(shopCurrency, DEMAND_GROUP_FIELDS),
        data: demandGroups.map((group) => ({
          groupId: group.groupId,
          label: group.label,
          searches: group.searches,
          recordedSearches: group.recordedSearches,
          sampleSearches: group.sampleSearches,
          degradedSearches: group.degradedSearches,
        })),
      },
    ],
    relationships: [
      {
        id: "order-lines-to-orders",
        type: "many-to-one",
        source: { tableId: "orderLines", fieldId: "orderId" },
        target: { tableId: "orders", fieldId: "orderId" },
      },
    ],
  };
}

function askedFor(row: {
  location: string | null;
  maxPriceMinor: number | null;
  currency: string | null;
  kind: "product" | "service" | null;
}): string {
  return [
    row.location ? `in ${row.location}` : null,
    row.maxPriceMinor !== null && row.currency ? `up to ${money(row.maxPriceMinor, row.currency)}` : null,
    row.kind === "service" ? "a service" : row.kind === "product" ? "a product" : null,
  ]
    .filter(Boolean)
    .join(", ");
}
