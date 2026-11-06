import { sql } from "drizzle-orm";
import {
  check,
  customType,
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
//   triggers) live in drizzle/0001_invariants.sql and drizzle/0006_booking_invariants.sql.

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

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

// Where a product's PayPal Catalog record stands. It has no bearing on whether the product sells.
export const catalogSyncStatus = pgEnum("catalog_sync_status", [
  "pending",
  "synced",
  "failed",
  "not_configured",
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

// Why a booking needs a person: its deposit was captured after the hold had already ended.
export const bookingReviewReason = pgEnum("booking_review_reason", [
  "late_capture",
  "captured_after_cancel",
]);

export const importSourceKind = pgEnum("import_source_kind", ["photo", "csv"]);

export const importJobStatus = pgEnum("import_job_status", [
  "queued",
  "running",
  "needs_review",
  "failed",
  "completed",
]);

export const importRowStatus = pgEnum("import_row_status", [
  "pending",
  "accepted",
  "removed",
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
    // What search and assistants read: the English a seller chose, or the source's own words, in
    // whatever language those are. The next two are set only when a seller reviewed that language.
    description: text("description").notNull().default(""),
    descriptionEn: text("description_en"),
    descriptionLv: text("description_lv"),
    // Null only on an unpublished row whose price is still unknown. Currency comes from the shop.
    priceMinor: integer("price_minor"),
    availability: productAvailability("availability")
      .notNull()
      .default("available"),
    serviceDurationMinutes: integer("service_duration_minutes"),
    depositMinor: integer("deposit_minor"),
    paypalProductId: text("paypal_product_id").unique(),
    paypalSyncStatus: catalogSyncStatus("paypal_sync_status")
      .notNull()
      .default("pending"),
    // A stable code. The message shown to a seller comes from the service.
    paypalSyncError: text("paypal_sync_error"),
    paypalSyncedAt: timestamp("paypal_synced_at", { withTimezone: true }),
    // The draft this came from. A draft is deleted once published, so its job and position are what
    // stop a repeated publication from adding a second product.
    importJobId: uuid("import_job_id"),
    importPosition: integer("import_position"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("products_id_shop_id_unique").on(t.id, t.shopId),
    unique("products_import_job_id_position_unique").on(
      t.importJobId,
      t.importPosition,
    ),
    foreignKey({
      name: "products_import_job_shop_fk",
      columns: [t.importJobId, t.shopId],
      foreignColumns: [importJobs.id, importJobs.shopId],
    }).onDelete("restrict"),
    index("products_shop_id_status_idx").on(t.shopId, t.status),
    check(
      "products_import_source_complete",
      sql`(${t.importJobId} IS NULL) = (${t.importPosition} IS NULL)`,
    ),
    check(
      "products_synced_requires_record",
      sql`${t.paypalSyncStatus} <> 'synced' OR (${t.paypalProductId} IS NOT NULL AND ${t.paypalSyncedAt} IS NOT NULL)`,
    ),
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

// When a technician works, as a weekly pattern in the shop's own time, so 09:00 stays 09:00 across
// a clock change. UTC instants are derived per date in src/server/domain/shop-time.ts. Minutes are
// counted from local midnight, and 1440 means the end of that day. One technician's windows cannot
// overlap (see the exclusion constraint in 0006_booking_invariants.sql).
export const technicianWindows = pgTable(
  "technician_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id").notNull(),
    technicianId: uuid("technician_id").notNull(),
    // ISO weekday: 1 is Monday, 7 is Sunday.
    weekday: integer("weekday").notNull(),
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "technician_windows_technician_shop_fk",
      columns: [t.technicianId, t.shopId],
      foreignColumns: [technicians.id, technicians.shopId],
    }).onDelete("cascade"),
    index("technician_windows_shop_id_idx").on(t.shopId),
    check("technician_windows_weekday", sql`${t.weekday} BETWEEN 1 AND 7`),
    check(
      "technician_windows_within_day",
      sql`${t.startMinute} >= 0 AND ${t.endMinute} <= 1440 AND ${t.endMinute} > ${t.startMinute}`,
    ),
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
    // The service's price when this was booked. The deposit is the order's total, so together they
    // give the remaining balance, whatever happens to the price later.
    servicePriceMinor: integer("service_price_minor").notNull(),
    // Must equal the capture recorded on this booking's own order (composite key below).
    depositCaptureId: text("deposit_capture_id"),
    reviewReason: bookingReviewReason("review_reason"),
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
    index("bookings_held_expiry_idx")
      .on(t.holdExpiresAt)
      .where(sql`${t.status} = 'held'`),
    check("bookings_ends_after_start", sql`${t.endsAt} > ${t.startsAt}`),
    check("bookings_service_price_positive", sql`${t.servicePriceMinor} > 0`),
    check(
      "bookings_review_states_reason",
      sql`(${t.status} = 'review_required') = (${t.reviewReason} IS NOT NULL)`,
    ),
    // A booking only reaches review because money arrived, so the capture is always on record.
    check(
      "bookings_review_requires_capture",
      sql`${t.status} <> 'review_required' OR ${t.depositCaptureId} IS NOT NULL`,
    ),
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
    // The uploaded file's name, for the seller to recognise it. Never used as a path.
    sourceRef: text("source_ref"),
    workflowRunId: text("workflow_run_id").unique(),
    // Counts, token usage and the suggestion model. No extracted content: that lives in import_rows.
    result: jsonb("result"),
    // A stable code. The message shown to a seller comes from the service.
    error: text("error"),
    // How many times this job has been claimed since the seller last asked for a run.
    attempts: integer("attempts").notNull().default(0),
    // Fences a run: only the run holding the current token may finish the job, so one that lost
    // its lease cannot overwrite the run that took over.
    runToken: uuid("run_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    // What actually read the source. Null for a CSV, which no model touches.
    model: text("model"),
    promptVersion: text("prompt_version"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("import_jobs_id_shop_id_unique").on(t.id, t.shopId),
    index("import_jobs_shop_id_created_at_idx").on(t.shopId, t.createdAt),
    index("import_jobs_status_idx").on(t.status),
    check("import_jobs_attempts_not_negative", sql`${t.attempts} >= 0`),
    check(
      "import_jobs_running_holds_lease",
      sql`${t.status} <> 'running' OR (${t.runToken} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`,
    ),
  ],
);

// The uploaded photo, kept only until the review ends or expires_at passes. It is here rather than
// on a disk because the web service and a workflow run share no disk, and because a run's arguments
// are limited to 4 MB. A separate table keeps the bytes out of every read of a job.
export const importSources = pgTable(
  "import_sources",
  {
    jobId: uuid("job_id").primaryKey(),
    shopId: uuid("shop_id").notNull(),
    mediaType: text("media_type").notNull(),
    bytes: bytea("bytes").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "import_sources_job_shop_fk",
      columns: [t.jobId, t.shopId],
      foreignColumns: [importJobs.id, importJobs.shopId],
    }).onDelete("cascade"),
    index("import_sources_expires_at_idx").on(t.expiresAt),
    check(
      "import_sources_media_type",
      sql`${t.mediaType} IN ('image/jpeg', 'image/png', 'image/webp')`,
    ),
  ],
);

// A draft of one catalog row, as read from a source and then corrected by the seller. Anything the
// source did not state stays null. A row only becomes a product through publication, so nothing
// here is ever visible to a buyer. Accepted rows are held to the same rules as a published product.
export const importRows = pgTable(
  "import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").notNull(),
    shopId: uuid("shop_id").notNull(),
    // Order in the source. Unique per job, so a repeated completion cannot add rows.
    position: integer("position").notNull(),
    // Where this came from, in words a seller can follow: "Row 12", "Screens section, line 3".
    sourceRef: text("source_ref").notNull(),
    status: importRowStatus("status").notNull().default("pending"),
    title: text("title"),
    kind: productKind("kind"),
    // The price exactly as the source showed it, kept for comparison after the seller edits.
    priceText: text("price_text"),
    priceMinor: integer("price_minor"),
    currency: text("currency"),
    serviceDurationMinutes: integer("service_duration_minutes"),
    depositMinor: integer("deposit_minor"),
    // The description as the source gave it, in the source's language.
    description: text("description"),
    // Generated suggestions, editable, and only ever stored here until a seller accepts the row.
    descriptionEn: text("description_en"),
    descriptionLv: text("description_lv"),
    // Doubts recorded when the row was read, as stable codes. Editing a field clears its own.
    sourceWarnings: text("source_warnings")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "import_rows_job_shop_fk",
      columns: [t.jobId, t.shopId],
      foreignColumns: [importJobs.id, importJobs.shopId],
    }).onDelete("cascade"),
    unique("import_rows_job_id_position_unique").on(t.jobId, t.position),
    check("import_rows_position_not_negative", sql`${t.position} >= 0`),
    check(
      "import_rows_price_positive",
      sql`${t.priceMinor} IS NULL OR ${t.priceMinor} > 0`,
    ),
    check(
      "import_rows_currency_format",
      sql`${t.currency} IS NULL OR ${t.currency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      "import_rows_duration_positive",
      sql`${t.serviceDurationMinutes} IS NULL OR ${t.serviceDurationMinutes} > 0`,
    ),
    check(
      "import_rows_deposit_positive",
      sql`${t.depositMinor} IS NULL OR ${t.depositMinor} > 0`,
    ),
    // An accepted row must be publishable, whatever code wrote it. This is what makes a missing
    // price block publication: such a row can never reach `accepted`.
    check(
      "import_rows_accepted_is_complete",
      sql`${t.status} <> 'accepted' OR (
        ${t.title} IS NOT NULL AND btrim(${t.title}) <> ''
        AND ${t.kind} IS NOT NULL
        AND ${t.priceMinor} IS NOT NULL
        AND ${t.currency} IS NOT NULL
      )`,
    ),
    check(
      "import_rows_accepted_service_has_terms",
      sql`${t.status} <> 'accepted' OR ${t.kind} <> 'service' OR (
        ${t.serviceDurationMinutes} IS NOT NULL
        AND ${t.depositMinor} IS NOT NULL
        AND ${t.depositMinor} <= ${t.priceMinor}
      )`,
    ),
    check(
      "import_rows_accepted_product_has_no_service_terms",
      sql`${t.status} <> 'accepted' OR ${t.kind} <> 'product' OR (
        ${t.serviceDurationMinutes} IS NULL AND ${t.depositMinor} IS NULL
      )`,
    ),
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
