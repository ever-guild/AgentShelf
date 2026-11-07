import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { currentSellerOrSignIn } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { ServiceError } from "@/server/errors";
import { defaultImportDeps } from "@/server/services/import-start";
import { getImport } from "@/server/services/imports";

import { SellerHeader } from "../../seller-header";
import { ImportReview } from "./import-review";

export const metadata: Metadata = {
  title: "Check your price list | AgentShelf",
  robots: { index: false, follow: false },
};

async function Review({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const shop = await currentSellerOrSignIn();
  let view;
  try {
    view = await getImport(getDb(), shop, id);
  } catch (error) {
    if (error instanceof ServiceError && error.code === "IMPORT_NOT_FOUND") {
      notFound();
    }
    throw error;
  }
  return (
    <>
      <SellerHeader shopName={shop.name} />
      <ImportReview initial={view} canSuggest={Boolean(defaultImportDeps().ai)} />
    </>
  );
}

export default function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="flex flex-1 flex-col">
      <Suspense fallback={<p className="px-4 py-6 text-zinc-600 sm:px-6 dark:text-zinc-400">Loading your price list</p>}>
        <Review params={params} />
      </Suspense>
    </main>
  );
}
