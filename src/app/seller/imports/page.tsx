import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { currentSellerOrSignIn } from "@/server/auth/current-seller";
import type { ImportStatus } from "@/server/contracts/imports";
import { getDb } from "@/server/db";
import { listImports } from "@/server/services/imports";

import { SellerHeader } from "../seller-header";
import { UploadForm } from "./upload-form";

export const metadata: Metadata = {
  title: "Price lists | AgentShelf",
  robots: { index: false, follow: false },
};

const STATUS_TEXT: Record<ImportStatus, string> = {
  queued: "Waiting to be read",
  running: "Being read",
  needs_review: "Ready to check",
  failed: "Could not be read",
  completed: "Checked, not published yet",
};

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
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-8 sm:px-6">
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-semibold tracking-tight">Add your price list</h1>
            <p className="max-w-prose text-zinc-600 dark:text-zinc-400">
              Upload a photo of your price list, or a CSV file. You check every row before
              anything goes into your catalog.
            </p>
          </div>
          <UploadForm />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Your uploads</h2>
          {imports.length === 0 ? (
            <p className="text-zinc-600 dark:text-zinc-400">
              Nothing yet. Your first upload appears here.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {imports.map((entry) => (
                <li key={entry.id}>
                  <Link
                    href={`/seller/imports/${entry.id}`}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-ink dark:hover:bg-zinc-900"
                  >
                    <span className="min-w-0 break-words font-medium">{entry.sourceName}</span>
                    <span className="text-sm text-zinc-600 dark:text-zinc-400">
                      {entry.publishedCount > 0
                        ? `Published, ${entry.publishedCount} ${entry.publishedCount === 1 ? "product" : "products"}`
                        : STATUS_TEXT[entry.status]}
                      {entry.rowCount > 0
                        ? `, ${entry.rowCount} ${entry.rowCount === 1 ? "row" : "rows"}`
                        : ""}
                      , {formatDate.format(new Date(entry.createdAt))}
                    </span>
                  </Link>
                </li>
              ))}
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
      <Suspense fallback={<p className="px-6 py-8 text-zinc-600 dark:text-zinc-400">Loading your price lists</p>}>
        <ImportList />
      </Suspense>
    </main>
  );
}
