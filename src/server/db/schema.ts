import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Conventions
// - Money is integer minor units (EUR cents). There is no float or numeric money column.
// - Instants are timestamptz, stored in UTC. A shop's IANA timezone is for display only.
// - Rows owned by a shop reference each other through (id, shop_id), so the database
//   itself rejects a row that mixes two shops.
// - Constraints drizzle cannot express (the booking overlap exclusion and the immutability
//   triggers) live in drizzle/0001_invariants.sql.

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const productKind = pgEnum("product_kind", ["product", "service"]);

export const productStatus = pgEnum("product_status", [
  "draft",
  "published",
  "unpublished",
]);

export const productAvailability = pgEnum("product_availability", [
  "available",
  "unavailable",
]);

export const orderKind = pgEnum("order_kind", ["purchase", "booking_deposit"]);

export const paymentStatus = pgEnum("payment_status", [
  "pending",
  "approved",
  "paid",
  "cancelled",
  "failed",
  "review_required",
]);

export const bookingStatus = pgEnum("booking_status", [
  "held",
  "confirmed",
  "expired",
  "cancelled",
  "review_required",
]);

export const importSourceKind = pgEnum("import_source_kind", ["photo", "csv"]);

export const importJobStatus = pgEnum("import_job_status", [
  "queued",
  "running",
  "needs_review",
  "failed",
  "completed",
]);

export const webhookReceiptStatus = pgEnum("webhook_receipt_status", [
  "received",
  "processed",
  "ignored",
  "failed",
]);

export const searchEventOrigin = pgEnum("search_event_origin", [
  "observed",
  "fixture",
]);

export const shops = pgTable(
  "shops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    location: text("location"),
    currency: text("currency").notNull(),
    timezone: text("timezone").notNull(),
    // Server-only. The name of a credential set held in environment variables,
    // never the credential itself. Must not appear in any public contract.
    paypalCredentialRef: text("paypal_credential_ref").notNull(),
    // Server-only. The `payee.merchant_id` for this shop's Orders v2 orders. Clients can
    // never supply it. A shop without one cannot take payment.
    paypalMerchantId: text("paypal_merchant_id").unique(),
    // Scrypt hash of the demo seller access code. Null means nobody can sign in.
    sellerAccessCodeHash: text("seller_access_code_hash"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("shops_slug_format", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("shops_currency_format", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      "shops_paypal_credential_ref_format",
      sql`${t.paypalCredentialRef} ~ '^[A-Z][A-Z0-9_]*$'`,
    ),
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "restrict" }),
    kind: productKind("kind").notNull(),
    status: productStatus("status").notNull().default("draft"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    // Null only on an unpublished row whose price is still unknown. Currency comes from the shop.
    priceMinor: integer("price_minor"),
    availability: productAvailability("availability")
      .notNull()
      .default("available"),
    serviceDurationMinutes: integer("service_duration_minutes"),
    depositMinor: integer("deposit_minor"),
    paypalProductId: text("paypal_product_id").unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("products_id_shop_id_unique").on(t.id, t.shopId),
    index("products_shop_id_status_idx").on(t.shopId, t.status),
    check("products_title_not_blank", sql`btrim(${t.title}) <> ''`),
    check(
      "products_price_positive",
      sql`${t.priceMinor} IS NULL OR ${t.priceMinor} > 0`,
    ),
    check(
      "products_published_requires_price",
      sql`${t.status} <> 'published' OR ${t.priceMinor} IS NOT NULL`,
    ),
    check(
      "products_service_fields_only_on_services",
      sql`${t.kind} = 'service' OR (${t.serviceDurationMinutes} IS NULL AND ${t.depositMinor} IS NULL)`,
    ),
    check(
      "products_published_service_requires_terms",
      sql`${t.kind} <> 'service' OR ${t.status} <> 'published' OR (${t.serviceDurationMinutes} IS NOT NULL AND ${t.depositMinor} IS NOT NULL)`,
    ),
    check(
      "products_service_duration_positive",
      sql`${t.serviceDurationMinutes} IS NULL OR ${t.serviceDurationMinutes} > 0`,
    ),
    check(
      "products_deposit_within_price",
      sql`${t.depositMinor} IS NULL OR (${t.depositMinor} > 0 AND ${t.depositMinor} <= ${t.priceMinor})`,
    ),
  ],
);

export const technicians = pgTable(
  "technicians",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("technicians_id_shop_id_unique").on(t.id, t.shopId),
    unique("technicians_shop_id_name_unique").on(t.shopId, t.name),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "restrict" }),
    kind: orderKind("kind").notNull(),
    // Payment state only. Booking state lives on `bookings`.
    paymentStatus: paymentStatus("payment_status").notNull().default("pending"),
    currency: text("currency").notNull(),
    totalMinor: integer("total_minor").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    // Hash of the normalized request, so a reused key with a different payload is refused.
    requestFingerprint: text("request_fingerprint").notNull(),
    // Snapshot of the recipient at creation time, compared with PayPal during reconciliation.
    payeeMerchantId: text("payee_merchant_id").notNull(),
    paypalOrderId: text("paypal_order_id").unique(),
    paypalCaptureId: text("paypal_capture_id").unique(),
    approvalUrl: text("approval_url"),
    // When the sweep last asked PayPal about this order, so it can back off. Not order state.
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("orders_id_shop_id_unique").on(t.id, t.shopId),
    unique("orders_id_paypal_capture_id_unique").on(t.id, t.paypalCaptureId),
    index("orders_shop_id_created_at_idx").on(t.shopId, t.createdAt),
    check("orders_currency_format", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("orders_total_positive", sql`${t.totalMinor} > 0`),
    check(
      "orders_paid_requires_capture",
      sql`${t.paymentStatus} <> 'paid' OR ${t.paypalCaptureId} IS NOT NULL`,
    ),
  ],
);

// Immutable once written, enforced by a trigger. A later price or title change must not
// alter an existing order.
export const orderLines = pgTable(
  "order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").notNull(),
    shopId: uuid("shop_id").notNull(),
    productId: uuid("product_id").notNull(),
    title: text("title").notNull(),
    unitPriceMinor: integer("unit_price_minor").notNull(),
    quantity: integer("quantity").notNull(),
    lineTotalMinor: integer("line_total_minor").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "order_lines_order_shop_fk",
      columns: [t.orderId, t.shopId],
      foreignColumns: [orders.id, orders.shopId],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_lines_product_shop_fk",
      columns: [t.productId, t.shopId],
      foreignColumns: [products.id, products.shopId],
    }).onDelete("restrict"),
    unique("order_lines_order_id_product_id_unique").on(t.orderId, t.productId),
    check("order_lines_unit_price_positive", sql`${t.unitPriceMinor} > 0`),
    check("order_lines_quantity_positive", sql`${t.quantity} > 0`),
    check(
      "order_lines_total_matches",
      sql`${t.lineTotalMinor} = ${t.unitPriceMinor} * ${t.quantity}`,
    ),
  ],
);

// A claim on a technician's time, starting as an expiring hold. Held and confirmed rows
// cannot overlap for one technician (see the exclusion constraint in 0001_invariants.sql).
export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id").notNull(),
    serviceId: uuid("service_id").notNull(),
    technicianId: uuid("technician_id").notNull(),
    orderId: uuid("order_id").notNull().unique(),
    status: bookingStatus("status").notNull().default("held"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    holdExpiresAt: timestamp("hold_expires_at", {
      withTimezone: true,
    }).notNull(),
    // Must equal the capture recorded on this booking's own order (composite key below).
    depositCaptureId: text("deposit_capture_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "bookings_service_shop_fk",
      columns: [t.serviceId, t.shopId],
      foreignColumns: [products.id, products.shopId],
    }).onDelete("restrict"),
    foreignKey({
      name: "bookings_technician_shop_fk",
      columns: [t.technicianId, t.shopId],
      foreignColumns: [technicians.id, technicians.shopId],
    }).onDelete("restrict"),
    foreignKey({
      name: "bookings_order_shop_fk",
      columns: [t.orderId, t.shopId],
      foreignColumns: [orders.id, orders.shopId],
    }).onDelete("restrict"),
    foreignKey({
      name: "bookings_order_capture_fk",
      columns: [t.orderId, t.depositCaptureId],
      foreignColumns: [orders.id, orders.paypalCaptureId],
    }).onDelete("restrict"),
    index("bookings_shop_id_starts_at_idx").on(t.shopId, t.startsAt),
    check("bookings_ends_after_start", sql`${t.endsAt} > ${t.startsAt}`),
    check(
      "bookings_confirmed_requires_capture",
      sql`${t.status} <> 'confirmed' OR ${t.depositCaptureId} IS NOT NULL`,
    ),
  ],
);

// Only verified events belong here. The payload keeps identifiers and statuses, never payer data.
export const webhookReceipts = pgTable(
  "webhook_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerEventId: text("provider_event_id").notNull().unique(),
    eventType: text("event_type").notNull(),
    resourceId: text("resource_id"),
    shopId: uuid("shop_id").references(() => shops.id, {
      onDelete: "restrict",
    }),
    orderId: uuid("order_id"),
    status: webhookReceiptStatus("status").notNull().default("received"),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "webhook_receipts_order_shop_fk",
      columns: [t.orderId, t.shopId],
      foreignColumns: [orders.id, orders.shopId],
    }).onDelete("restrict"),
    check(
      "webhook_receipts_order_requires_shop",
      sql`${t.orderId} IS NULL OR ${t.shopId} IS NOT NULL`,
    ),
  ],
);

export const importJobs = pgTable(
  "import_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "restrict" }),
    sourceKind: importSourceKind("source_kind").notNull(),
    status: importJobStatus("status").notNull().default("queued"),
    sourceRef: text("source_ref"),
    workflowRunId: text("workflow_run_id").unique(),
    result: jsonb("result"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("import_jobs_id_shop_id_unique").on(t.id, t.shopId),
    index("import_jobs_shop_id_created_at_idx").on(t.shopId, t.createdAt),
  ],
);

// No personal data: only the normalized query and its filters. `origin` keeps labeled demo
// fixtures apart from demand that was actually observed.
export const searchEvents = pgTable(
  "search_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    queryNormalized: text("query_normalized").notNull(),
    location: text("location"),
    maxPriceMinor: integer("max_price_minor"),
    currency: text("currency"),
    resultCount: integer("result_count").notNull(),
    matchedProductIds: uuid("matched_product_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    attributedShopId: uuid("attributed_shop_id").references(() => shops.id, {
      onDelete: "restrict",
    }),
    origin: searchEventOrigin("origin").notNull().default("observed"),
    createdAt: createdAt(),
  },
  (t) => [
    index("search_events_created_at_idx").on(t.createdAt),
    index("search_events_attributed_shop_id_created_at_idx").on(
      t.attributedShopId,
      t.createdAt,
    ),
    check(
      "search_events_query_length",
      sql`char_length(${t.queryNormalized}) BETWEEN 1 AND 200`,
    ),
    check("search_events_result_count", sql`${t.resultCount} >= 0`),
    check(
      "search_events_max_price",
      sql`${t.maxPriceMinor} IS NULL OR ${t.maxPriceMinor} >= 0`,
    ),
  ],
);
