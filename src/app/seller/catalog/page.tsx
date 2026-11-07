import type { Metadata } from "next";
import { Suspense } from "react";

import { currentSellerOrSignIn } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { getSellerCatalog } from "@/server/services/seller-catalog";

import { SellerHeader } from "../seller-header";
import { CatalogManager } from "./catalog-manager";

export const metadata: Metadata = {
  title: "Your catalog | AgentShelf",
  robots: { index: false, follow: false },
};

async function Catalog() {
  const shop = await currentSellerOrSignIn();
  const view = await getSellerCatalog(getDb(), shop);
  return (
    <>
      <SellerHeader shopName={shop.name} />
      <CatalogManager initial={view} timezone={shop.timezone} />
    </>
  );
}

export default function CatalogPage() {
  return (
    <main className="flex flex-1 flex-col">
      <Suspense
        fallback={
          <p className="mx-auto w-full max-w-7xl px-4 py-8 text-zinc-600 sm:px-6 dark:text-zinc-400">
            Loading your catalog
          </p>
        }
      >
        <Catalog />
      </Suspense>
    </main>
  );
}
