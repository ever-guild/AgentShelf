"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export function SellerHeader({ shopName }: { shopName: string }) {
  const router = useRouter();

  async function signOut() {
    await fetch("/api/seller/session", { method: "DELETE" });
    router.replace("/seller/sign-in");
    router.refresh();
  }

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800 sm:px-6">
      <Link href="/seller/imports" className="font-semibold tracking-tight">
        {shopName}
      </Link>
      <button
        type="button"
        onClick={signOut}
        className="text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
      >
        Sign out
      </button>
    </header>
  );
}
