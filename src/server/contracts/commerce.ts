import { z } from "zod";

import {
  bookingStatus,
  paymentStatus,
  productAvailability,
  productKind,
} from "../db/schema";
import { MAX_MINOR } from "../domain/money";

// The public contract shared by HTTP routes and MCP tools. Every input is a strict object,
// so a client that sends a total, a price or a merchant identifier is rejected rather than
// ignored. Those values are always resolved from stored data on the server.

const MAX_QUANTITY = 99;
const MAX_CHECKOUT_ITEMS = 50;
const MAX_SEARCH_RESULTS = 20;
const MAX_SLOT_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

const id = z.uuid();
const minorAmount = z.int().min(0).max(MAX_MINOR);
const currencyCode = z.string().regex(/^[A-Z]{3}$/, "Use an ISO 4217 code.");
const instant = z.iso.datetime({ offset: true });
const productKindValue = z.enum(productKind.enumValues);
const availabilityValue = z.enum(productAvailability.enumValues);

export const ianaTimezone = z.string().refine((value) => {
  if (value !== "UTC" && !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(value)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Use an IANA timezone such as Europe/Riga.");

// Long enough that a key cannot be guessed, because a repeated key returns the same order.
export const idempotencyKey = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "Use a random token such as a UUID.");

export const statusToken = z.string().min(20).max(128);

export const productSummary = z.strictObject({
  productId: id,
  shopId: id,
  shopName: z.string(),
  location: z.string().nullable(),
  kind: productKindValue,
  title: z.string(),
  description: z.string(),
  priceMinor: minorAmount,
  currency: currencyCode,
  availability: availabilityValue,
  serviceDurationMinutes: z.int().positive().nullable(),
  depositMinor: minorAmount.nullable(),
});
export type ProductSummary = z.infer<typeof productSummary>;

// search_products: read-only, searches every shop.
export const searchProductsInput = z.strictObject({
  query: z.string().trim().min(1).max(200),
  location: z.string().trim().min(1).max(100).optional(),
  maxPriceMinor: minorAmount.optional(),
  currency: currencyCode.optional(),
  limit: z.int().min(1).max(MAX_SEARCH_RESULTS).default(10),
});
export const searchProductsResult = z.strictObject({
  products: z.array(productSummary),
});

// get_slots: read-only. `slotId` is opaque to clients.
export const getSlotsInput = z
  .strictObject({ shopId: id, serviceId: id, from: instant, to: instant })
  .refine((range) => Date.parse(range.to) > Date.parse(range.from), {
    path: ["to"],
    message: "`to` must be after `from`.",
  })
  .refine(
    (range) => Date.parse(range.to) - Date.parse(range.from) <= MAX_SLOT_RANGE_MS,
    { path: ["to"], message: "The range cannot exceed 31 days." },
  );
export const getSlotsResult = z.strictObject({
  slots: z.array(
    z.strictObject({
      slotId: z.string().min(1).max(512),
      technicianId: id,
      startsAt: instant,
      endsAt: instant,
      timezone: ianaTimezone,
    }),
  ),
});

// book_slot: mutating. The booking stays pending until a verified capture of the deposit.
export const bookSlotInput = z.strictObject({
  slotId: z.string().min(1).max(512),
  serviceId: id,
  idempotencyKey,
});
export const bookSlotResult = z.strictObject({
  bookingId: id,
  orderId: id,
  expiresAt: instant,
  approvalUrl: z.url(),
  depositMinor: minorAmount,
  remainingMinor: minorAmount,
  currency: currencyCode,
  statusToken,
});

// create_checkout: mutating. One shop per order. Returning an approval link is not payment.
export const createCheckoutInput = z.strictObject({
  items: z
    .array(
      z.strictObject({
        productId: id,
        quantity: z.int().min(1).max(MAX_QUANTITY),
      }),
    )
    .min(1)
    .max(MAX_CHECKOUT_ITEMS)
    .refine(
      (items) =>
        new Set(items.map((item) => item.productId)).size === items.length,
      "List each product once and combine its quantity.",
    ),
  idempotencyKey,
});
export const createCheckoutResult = z.strictObject({
  orderId: id,
  totalMinor: minorAmount,
  currency: currencyCode,
  approvalUrl: z.url(),
  statusToken,
});

// What a shop page sends to buy one product. The shop comes from the URL and everything else from
// stored data, so a price, total, merchant or quantity in here is refused. The key comes from a
// browser, so it has to be a UUID, not just any token.
export const storefrontCheckoutInput = z.strictObject({
  productId: id,
  idempotencyKey: z.uuid(),
});
export const storefrontCheckoutResult = z.strictObject({
  paypalOrderId: z.string().min(1),
  totalMinor: minorAmount,
  currency: currencyCode,
  approvalUrl: z.url(),
  // Same-origin paths holding the order's status capability, where the buyer goes afterwards.
  returnPath: z.string().startsWith("/checkout/return?"),
  cancelPath: z.string().startsWith("/checkout/cancel?"),
});

// get_order_status: read-only, requires the capability returned when the order was created,
// so an order cannot be inspected by its identifier alone. Carries no payer data.
export const getOrderStatusInput = z.strictObject({
  orderId: id,
  statusToken,
});
export const getOrderStatusResult = z.strictObject({
  orderId: id,
  paymentStatus: z.enum(paymentStatus.enumValues),
  totalMinor: minorAmount,
  currency: currencyCode,
  booking: z
    .strictObject({
      bookingId: id,
      status: z.enum(bookingStatus.enumValues),
      startsAt: instant,
      endsAt: instant,
      expiresAt: instant,
      timezone: ianaTimezone,
    })
    .nullable(),
  updatedAt: instant,
});

export const getPublishedProductInput = z.strictObject({
  shopId: id,
  productId: id,
});
export const listPublishedProductsInput = z.strictObject({ shopId: id });
