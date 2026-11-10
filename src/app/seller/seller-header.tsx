"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const LINKS = [
  { href: "/seller/assistant", label: "Assistant" },
  { href: "/seller/imports", label: "Price lists" },
  { href: "/seller/catalog", label: "Catalog" },
  { href: "/seller/schedule", label: "Schedule" },
  { href: "/seller/dashboard", label: "Dashboard" },
];

const ITEM =
  "inline-flex h-9 items-center rounded-lg px-1 whitespace-nowrap transition-colors hover:bg-zinc-100 hover:text-foreground sm:px-2 dark:hover:bg-zinc-800";
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
    // Until the screen is wide enough for one line, the links fill their own row, with the shop name
    // and sign out above them, so nothing in the header wraps inside itself.
    <header className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-zinc-200 px-4 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:px-6 lg:flex dark:border-zinc-800">
      <p className="flex min-w-0 items-baseline gap-2 lg:mr-auto">
        <Link
          href="/"
          className={`flex-none transition-colors hover:text-foreground ${SECONDARY_TEXT}`}
        >
          AgentShelf
        </Link>
        <span aria-hidden="true" className="text-zinc-400 dark:text-zinc-600">
          /
        </span>
        <Link href="/seller/assistant" className="min-w-0 truncate font-medium">
          {shopName}
        </Link>
      </p>
      <nav aria-label="Seller" className="col-span-2 row-start-2 -mx-1 flex flex-wrap sm:col-span-3 sm:-mx-2 lg:mx-0 lg:flex-none">
        {LINKS.map(({ href, label }) => {
          const current = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={current ? "page" : undefined}
              className={`${ITEM} ${
                // The page you are on is the one word in the header underlined in ink.
                current
                  ? "font-medium text-foreground underline decoration-ink decoration-2 underline-offset-8"
                  : SECONDARY_TEXT
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>
      {/* Every payment here is a PayPal Sandbox one, and the header says so on every screen. */}
      <span className={`hidden text-xs whitespace-nowrap sm:col-start-2 sm:row-start-1 sm:inline ${SECONDARY_TEXT}`}>
        PayPal Sandbox
      </span>
      <button
        type="button"
        onClick={signOut}
        className={`${ITEM} ${SECONDARY_TEXT} col-start-2 row-start-1 -mr-1 sm:col-start-3 sm:-mr-2 lg:mr-0`}
      >
        Sign out
      </button>
    </header>
  );
}
