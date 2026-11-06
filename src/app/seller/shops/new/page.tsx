import type { Metadata } from "next";
import Link from "next/link";

import { OwnerNav } from "../../identity/owner-nav";
import { NewShopForm } from "./new-shop-form";

export const metadata: Metadata = {
  title: "Add a shop | AgentShelf",
  robots: { index: false, follow: false },
};

export default function NewShopPage() {
  return (
    <>
      <OwnerNav />
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-10 sm:px-8">
        <Link href="/seller/shops" className="w-fit text-sm text-zinc-600 underline underline-offset-4 dark:text-zinc-400">Back to shops</Link>
        <div className="flex flex-col gap-2">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Owner account</p>
          <h1 className="text-3xl font-medium tracking-tight">Add a shop</h1>
          <p className="text-pretty text-zinc-600 dark:text-zinc-400">The new shop starts with PayPal unconfigured. Connect a sandbox seller account after it is created.</p>
        </div>
        <NewShopForm />
      </main>
    </>
  );
}
