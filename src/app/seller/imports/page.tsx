import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { currentSellerOrSignIn } from "@/server/auth/current-seller";
import type { ImportStatus, ImportSummaryView } from "@/server/contracts/imports";
import { getDb } from "@/server/db";
import { listImports } from "@/server/services/imports";

import { HowItWorks } from "../import-steps";
import { SellerHeader } from "../seller-header";
import { UploadForm } from "./upload-form";

export const metadata: Metadata = {
  title: "Price lists | AgentShelf",
  robots: { index: false, follow: false },
};

const SECONDARY_TEXT = "text-zinc-600 dark:text-zinc-400";

const STATUS_TEXT: Record<ImportStatus, string> = {
  queued: "Waiting to be read",
  running: "Being read",
  needs_review: "Ready to check",
  failed: "Could not be read",
  completed: "Checked, not published yet",
};

// What an upload asks of the seller sets how loud its status is. The words always say it too.
const STATUS_TONE: Record<ImportStatus, string> = {
  queued: SECONDARY_TEXT,
  running: SECONDARY_TEXT,
  needs_review: "font-medium",
  failed: "text-blocked",
  completed: "font-medium",
};

function statusOf(entry: ImportSummaryView): { text: string; tone: string } {
  if (entry.publishedCount > 0) {
    return {
      text: `Published, ${entry.publishedCount} ${entry.publishedCount === 1 ? "product" : "products"}`,
      tone: "text-accepted",
    };
  }
  return { text: STATUS_TEXT[entry.status], tone: STATUS_TONE[entry.status] };
}

async function ImportList() {
  const shop = await currentSellerOrSignIn();
  const imports = await listImports(getDb(), shop);
  const formatDate = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: shop.timezone,
  });

  return (
    <>
      <SellerHeader shopName={shop.name} />
      <div className="mx-auto grid w-full max-w-[96rem] items-start gap-x-6 gap-y-10 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-medium text-balance">Add your price list</h1>
            <p className={`max-w-prose ${SECONDARY_TEXT}`}>
              Upload a photo of your price list, or a CSV file. You check every row before anything
              goes into your catalog.
            </p>
          </div>
          <UploadForm />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Your uploads</h2>
          {imports.length === 0 ? (
            <div className="flex flex-col gap-6">
              <p className={SECONDARY_TEXT}>Nothing yet. Your first upload appears here.</p>
              <div className="flex flex-col gap-5 rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
                <h3 className={`text-sm font-medium ${SECONDARY_TEXT}`}>How it works</h3>
                <HowItWorks />
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {imports.map((entry) => {
                const status = statusOf(entry);
                return (
                  <li key={entry.id}>
                    <Link
                      href={`/seller/imports/${entry.id}`}
                      className="-mx-3 flex flex-col gap-1 rounded-lg px-3 py-3 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-900"
                    >
                      <span className="flex flex-wrap items-baseline justify-between gap-x-4">
                        <span className="min-w-0 font-medium wrap-anywhere">{entry.sourceName}</span>
                        <span className={`text-sm ${status.tone}`}>{status.text}</span>
                      </span>
                      <span className={`text-xs tabular-nums ${SECONDARY_TEXT}`}>
                        {entry.rowCount > 0
                          ? `${entry.rowCount} ${entry.rowCount === 1 ? "row" : "rows"}, `
                          : ""}
                        {formatDate.format(new Date(entry.createdAt))}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

export default function ImportsPage() {
  return (
    <main className="flex flex-1 flex-col">
      <Suspense fallback={<p className={`px-4 py-8 sm:px-6 ${SECONDARY_TEXT}`}>Loading your price lists</p>}>
        <ImportList />
      </Suspense>
    </main>
  );
}
