"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export function OwnerNav() {
  const router = useRouter();

  async function signOut() {
    await fetch("/api/seller/identity/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    router.replace("/seller/owner-sign-in");
    router.refresh();
  }

  return (
    <header className="flex min-h-14 flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-2 text-sm sm:px-6 dark:border-zinc-800">
      <Link href="/seller/shops" className="mr-auto font-medium">AgentShelf</Link>
      <nav aria-label="Owner" className="flex flex-wrap items-center gap-1">
        <Link href="/seller/shops" className="rounded-lg px-3 py-2 text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-foreground dark:text-zinc-400 dark:hover:bg-zinc-800">Shops</Link>
        <Link href="/seller/agent-access" className="rounded-lg px-3 py-2 text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-foreground dark:text-zinc-400 dark:hover:bg-zinc-800">Agent access</Link>
        <Link href="/seller/paypal-connection" className="rounded-lg px-3 py-2 text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-foreground dark:text-zinc-400 dark:hover:bg-zinc-800">PayPal</Link>
      </nav>
      <button type="button" onClick={signOut} className="rounded-lg px-3 py-2 text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-foreground dark:text-zinc-400 dark:hover:bg-zinc-800">Sign out</button>
    </header>
  );
}
