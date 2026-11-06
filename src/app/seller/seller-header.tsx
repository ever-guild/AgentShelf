"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const LINKS = [
  { href: "/seller/imports", label: "Price lists" },
  { href: "/seller/catalog", label: "Catalog" },
  { href: "/seller/schedule", label: "Schedule" },
  { href: "/seller/dashboard", label: "Dashboard" },
];

const ITEM =
  "inline-flex h-9 items-center rounded-lg px-2 transition-colors hover:bg-zinc-100 hover:text-foreground dark:hover:bg-zinc-800";
const SECONDARY_TEXT = "text-zinc-600 dark:text-zinc-400";

export function SellerHeader({ shopName }: { shopName: string }) {
  const router = useRouter();
  const pathname = usePathname();

  async function signOut() {
    await fetch("/api/seller/session", { method: "DELETE" });
    router.replace("/seller/sign-in");
    router.refresh();
  }

  return (
    // On a phone the links fill their own row, with the shop name and sign out above them.
    <header className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-zinc-200 px-4 py-2 text-sm sm:flex sm:px-6 dark:border-zinc-800">
      <Link href="/seller/imports" className="min-w-0 font-medium break-words sm:mr-auto">
        {shopName}
      </Link>
      <nav aria-label="Seller" className="col-span-2 row-start-2 -mx-2 flex flex-wrap sm:mx-0">
        {LINKS.map(({ href, label }) => {
          const current = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={current ? "page" : undefined}
              className={`${ITEM} ${current ? "bg-zinc-100 font-medium text-foreground dark:bg-zinc-800" : SECONDARY_TEXT}`}
            >
              {label}
            </Link>
          );
        })}
      </nav>
      <button
        type="button"
        onClick={signOut}
        className={`${ITEM} ${SECONDARY_TEXT} col-start-2 row-start-1 -mr-2 sm:mr-0`}
      >
        Sign out
      </button>
    </header>
  );
}
