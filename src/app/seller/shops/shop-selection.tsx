"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { isUnauthorized, readOwnerSession, type OwnerSession } from "../identity/owner-session";

export function ShopSelection() {
  const router = useRouter();
  const [session, setSession] = useState<OwnerSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyShop, setBusyShop] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    readOwnerSession().then((value) => {
      if (active) setSession(value);
    }).catch((reason: unknown) => {
      if (!active) return;
      if (isUnauthorized(reason)) {
        router.replace("/seller/owner-sign-in");
        return;
      }
      setError("Your shop list could not be loaded. Try again.");
    });
    return () => { active = false; };
  }, [router]);

  async function selectShop(shopId: string) {
    setBusyShop(shopId);
    setError(null);
    try {
      const response = await fetch("/api/seller/identity/shops/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shopId }),
      });
      if (response.ok) {
        router.replace("/seller/imports");
        router.refresh();
        return;
      }
      if (response.status === 401) {
        router.replace("/seller/owner-sign-in");
        return;
      }
      setError("That shop could not be selected. Refresh and try again.");
    } catch {
      setError("The server did not answer. Check your connection and try again.");
    }
    setBusyShop(null);
  }

  if (!session && !error) return <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading shops</p>;
  if (error && !session) return <p role="alert" className="text-sm text-blocked">{error}</p>;

  return (
    <div className="flex flex-col gap-4">
      {error ? <p role="alert" className="text-sm text-blocked">{error}</p> : null}
      {session?.shops.length ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {session.shops.map((shop) => {
            const selected = session.selectedShopId === shop.id;
            return (
              <li key={shop.id}>
                <button
                  type="button"
                  disabled={busyShop !== null}
                  onClick={() => selectShop(shop.id)}
                  className={`flex min-h-32 w-full flex-col items-start gap-3 rounded-xl border p-5 text-left transition-colors hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${selected ? "border-ink bg-zinc-50 dark:bg-zinc-900" : "border-zinc-200 dark:border-zinc-800"}`}
                >
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="font-medium">{shop.name}</span>
                    {selected ? <span className="text-xs text-accepted">Selected</span> : null}
                  </span>
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">{shop.location}</span>
                  <span className="text-sm text-ink">{busyShop === shop.id ? "Opening shop" : "Open shop"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <section className="flex max-w-2xl flex-col gap-3 rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
          <h2 className="text-lg font-medium">No shops yet</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Create one here, or grant an agent permission to create your first shop. You review the permission before its short-lived credential is issued.</p>
          <div className="flex flex-wrap gap-4 pt-1">
            <a href="/seller/shops/new" className="inline-flex h-10 items-center rounded-lg bg-ink px-4 text-sm font-medium text-background">Create shop</a>
            <a href="/seller/agent-access" className="inline-flex h-10 items-center rounded-lg underline underline-offset-4">Authorize an agent</a>
          </div>
        </section>
      )}
    </div>
  );
}
