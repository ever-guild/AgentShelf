import type { Metadata } from "next";

import { OwnerNav } from "../identity/owner-nav";
import { ShopSelection } from "./shop-selection";

export const metadata: Metadata = {
  title: "Your shops | AgentShelf",
  robots: { index: false, follow: false },
};

export default function ShopsPage() {
  return (
    <>
      <OwnerNav />
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-10 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Owner account</p>
            <h1 className="text-3xl font-medium tracking-tight">Your shops</h1>
            <p className="max-w-xl text-pretty text-zinc-600 dark:text-zinc-400">Choose a shop to manage its price lists and catalog, or add another shop.</p>
          </div>
          <a href="/seller/shops/new" className="inline-flex h-11 items-center rounded-lg bg-ink px-4 font-medium text-background transition-[background-color,transform] hover:bg-ink/90 active:scale-[0.98]">Add a shop</a>
        </div>
        <ShopSelection />
      </main>
    </>
  );
}
