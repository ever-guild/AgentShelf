import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";

import { AiFailure, type ImportAi, type SuggestionFacts } from "../src/server/ai/types";
import type { ExtractedItem } from "../src/server/contracts/imports";
import type { Db } from "../src/server/db/client";
import { importJobs, importRows, importSources } from "../src/server/db/schema";
import type { ImportDeps, ImportJobRef } from "../src/server/services/import-start";

export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake jpeg")]);
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fake png"),
]);

export const fixture = (name: string) => readFileSync(`test/fixtures/price-lists/${name}`);

export const readableCsv = (rows = "Tempered glass,9.90,EUR\nUSB-C cable,7.50,EUR\n") =>
  Buffer.from(`name,price,currency\n${rows}`);

export const extractedItem = (overrides: Partial<ExtractedItem> = {}): ExtractedItem => ({
  sourceLocation: "Line 1",
  name: "Tempered glass",
  description: null,
  kind: "product",
  priceText: "9,90 €",
  currency: null,
  durationMinutes: null,
  variants: [],
  uncertain: [],
  ...overrides,
});

type Reading = { items: ExtractedItem[] } | AiFailure | Error | (() => Promise<{ items: ExtractedItem[] }>);

// A model that does what a test says, and remembers what it was asked. It stands in at the seam the
// import code uses, and the real adapter has its own tests against an HTTP stand-in.
export function createFakeAi() {
  const readings: Reading[] = [];
  const images: Buffer[] = [];
  const suggestionRequests: SuggestionFacts[][] = [];
  let suggestion:
    | AiFailure
    | ((rows: readonly SuggestionFacts[]) => { position: number; english: string; latvian: string }[]) =
    (rows) =>
      rows.map((row) => ({
        position: row.position,
        english: `English for ${row.title}.`,
        latvian: `Latviski ${row.title}.`,
      }));

  const ai: ImportAi = {
    async readPriceList({ bytes }) {
      images.push(bytes);
      const next = readings.shift();
      if (!next) {
        throw new Error("The fake model has no reading queued");
      }
      if (next instanceof Error) {
        throw next;
      }
      const { items } = typeof next === "function" ? await next() : next;
      return {
        items,
        model: "fake-model",
        promptVersion: "fake-prompt-v1",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
    async suggestDescriptions(rows) {
      suggestionRequests.push([...rows]);
      if (suggestion instanceof Error) {
        throw suggestion;
      }
      return {
        suggestions: suggestion(rows),
        model: "fake-model",
        promptVersion: "fake-descriptions-v1",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };

  return {
    ai,
    images,
    suggestionRequests,
    queue(...next: Reading[]) {
      readings.push(...next);
    },
    setSuggestion(next: typeof suggestion) {
      suggestion = next;
    },
  };
}

// Records which jobs were started, without running them, so a test decides when a run happens.
export function createImportHarness() {
  const model = createFakeAi();
  const started: ImportJobRef[] = [];
  const deps: ImportDeps = {
    ai: model.ai,
    startRun: async (_db, job) => {
      started.push(job);
    },
  };
  return { model, started, deps };
}

export async function jobRow(db: Db, id: string) {
  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, id));
  return job;
}

export async function rowsOf(db: Db, jobId: string) {
  const rows = await db.select().from(importRows).where(eq(importRows.jobId, jobId));
  return rows.sort((a, b) => a.position - b.position);
}

export async function sourceOf(db: Db, jobId: string) {
  const [source] = await db.select().from(importSources).where(eq(importSources.jobId, jobId));
  return source;
}
