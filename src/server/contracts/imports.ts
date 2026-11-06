import { z } from "zod";

import {
  MAX_DESCRIPTION_LENGTH,
  MAX_DURATION_MINUTES,
  MAX_TITLE_LENGTH,
  type RowIssue,
} from "../imports/draft-rows";

// The shared contracts for catalog import. Everything a model returns or a seller sends is checked
// against these. A model's output is treated the same as any other untrusted input.

export const UNCERTAIN_FIELDS = [
  "name",
  "description",
  "kind",
  "price",
  "currency",
  "duration",
] as const;

// What a model must return for a price list. Unknown values are null, and every field is required,
// so "not stated" is an explicit answer rather than an omission. Prices are the text as printed:
// turning them into numbers is deterministic code's job, so a model never does money arithmetic.
// Numbers are plain `z.number()` because `.int()` adds bounds that a model's schema cannot carry.
// The code that uses them checks that they are whole.
export const priceListExtraction = z.strictObject({
  items: z.array(
    z.strictObject({
      sourceLocation: z.string(),
      name: z.string().nullable(),
      description: z.string().nullable(),
      kind: z.enum(["product", "service"]).nullable(),
      priceText: z.string().nullable(),
      currency: z.string().nullable(),
      durationMinutes: z.number().nullable(),
      variants: z.array(
        z.strictObject({
          label: z.string(),
          priceText: z.string().nullable(),
        }),
      ),
      uncertain: z.array(z.enum(UNCERTAIN_FIELDS)),
    }),
  ),
});

export type PriceListExtraction = z.infer<typeof priceListExtraction>;
export type ExtractedItem = PriceListExtraction["items"][number];

export const descriptionSuggestions = z.strictObject({
  rows: z.array(
    z.strictObject({
      position: z.number(),
      english: z.string(),
      latvian: z.string(),
    }),
  ),
});

const editableText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((text) => text.trim())
    .nullable();

// What a seller may change on a row. Strict, so a request naming a job, a shop or any other unknown
// field is refused rather than ignored. Prices are text and go through the same parser as a source.
export const importRowPatch = z
  .strictObject({
    title: editableText(MAX_TITLE_LENGTH),
    description: editableText(MAX_DESCRIPTION_LENGTH),
    descriptionEn: editableText(MAX_DESCRIPTION_LENGTH),
    descriptionLv: editableText(MAX_DESCRIPTION_LENGTH),
    kind: z.enum(["product", "service"]).nullable(),
    price: z.string().max(60).nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    serviceDurationMinutes: z.number().int().min(1).max(MAX_DURATION_MINUTES).nullable(),
    deposit: z.string().max(60).nullable(),
    status: z.enum(["pending", "accepted", "removed"]),
  })
  .partial();

export type ImportRowPatch = z.infer<typeof importRowPatch>;

export const importBulkAction = z.strictObject({
  action: z.enum(["set_missing_currency", "accept_clean"]),
});

export const importId = z.uuid();

export type ImportStatus = "queued" | "running" | "needs_review" | "failed" | "completed";

export type ImportRowView = {
  id: string;
  position: number;
  sourceRef: string;
  status: "pending" | "accepted" | "removed";
  title: string | null;
  kind: "product" | "service" | null;
  price: string | null;
  priceText: string | null;
  currency: string | null;
  serviceDurationMinutes: number | null;
  deposit: string | null;
  description: string | null;
  descriptionEn: string | null;
  descriptionLv: string | null;
  issues: RowIssue[];
};

export type ImportSummaryView = {
  id: string;
  sourceKind: "photo" | "csv";
  sourceName: string;
  status: ImportStatus;
  createdAt: string;
  rowCount: number;
  // Products made from this import. Their drafts are gone by then.
  publishedCount: number;
};

export type ImportView = Omit<ImportSummaryView, "rowCount"> & {
  shopCurrency: string;
  error: { code: string; message: string; retryable: boolean } | null;
  hasSource: boolean;
  // What read the source, for the seller and for the record. Null for a CSV.
  model: string | null;
  promptVersion: string | null;
  ignoredColumns: string[];
  rows: ImportRowView[];
  counts: { total: number; blocked: number; pending: number; accepted: number; removed: number };
};
