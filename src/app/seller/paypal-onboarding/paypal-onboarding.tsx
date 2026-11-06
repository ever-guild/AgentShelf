"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import type { OwnerShop } from "../identity/owner-session";
import { OwnerNav } from "../identity/owner-nav";

type PayPalOwnerSession = {
  owner: {
    id: string;
    username: string;
    paypalProfile: { displayName: string | null; email: string | null } | null;
  };
  shops: OwnerShop[];
  selectedShopId: string | null;
};

type CreatedShop = { shop?: { id?: string } };

const fieldClass = "h-11 w-full rounded-lg border border-zinc-300 bg-background px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink dark:border-zinc-700";
const labelClass = "flex flex-col gap-1 text-sm font-medium";
const quiet = "text-zinc-600 dark:text-zinc-400";

function makeSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

function friendlyShopError(code?: string): string {
  if (code === "CONFLICT") return "That shop address is already in use. Choose another.";
  if (code === "INVALID_INPUT") return "Check the shop details and try again.";
  if (code === "RATE_LIMITED") return "There have been too many attempts. Wait a little and try again.";
  return "The shop could not be created. Check the details and try again.";
}

export function PayPalOnboarding({ initialMessage }: { initialMessage: string | null }) {
  const router = useRouter();
  const [session, setSession] = useState<PayPalOwnerSession | null>(null);
  const [checked, setChecked] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shopName, setShopName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [location, setLocation] = useState("");
  const [timezone, setTimezone] = useState("Europe/Riga");
  const [busy, setBusy] = useState(false);
  const [shopError, setShopError] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const isFirstPayPalShop = Boolean(session?.owner.paypalProfile && !session.shops.length);

  useEffect(() => {
    let active = true;
    fetch("/api/seller/identity/me", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) return null;
        if (!response.ok) throw new Error("LOAD_FAILED");
        return (await response.json()) as PayPalOwnerSession;
      })
      .then((value) => {
        if (!active) return;
        setSession(value);
        if (value?.owner.paypalProfile?.displayName) {
          const displayName = value.owner.paypalProfile.displayName;
          setShopName(displayName.slice(0, 120));
          setSlug(makeSlug(displayName));
        }
        if (typeof Intl !== "undefined") {
          const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
          if (browserTimezone) setTimezone(browserTimezone);
        }
        setChecked(true);
      })
      .catch(() => {
        if (!active) return;
        setLoadError("Your account could not be checked. Refresh the page and try again.");
        setChecked(true);
      });
    return () => { active = false; };
  }, []);

  async function createFirstShop(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setShopError(null);
    try {
      const response = await fetch("/api/seller/identity/shops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: idempotencyKey.current ?? (idempotencyKey.current = crypto.randomUUID()),
          shop: { name: shopName, slug, location, currency: "EUR", timezone },
        }),
      });
      if (response.status === 401) {
        router.replace("/seller/owner-sign-in");
        return;
      }
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        setShopError(friendlyShopError(result?.error?.code));
        setBusy(false);
        return;
      }
      const result = (await response.json()) as CreatedShop;
      const createdShopId = result.shop?.id;
      if (!createdShopId) {
        setShopError("The shop was created, but its setup page could not be opened. Go to your shop list to continue.");
        setBusy(false);
        return;
      }
      router.replace(`/seller/paypal-connection?shopId=${encodeURIComponent(createdShopId)}`);
      router.refresh();
    } catch {
      setShopError("The server did not answer. Check your connection and try again.");
      setBusy(false);
    }
  }

  function clearIdempotencyKey() {
    idempotencyKey.current = null;
  }

  return (
    <>
      {session ? <OwnerNav /> : (
        <header className="px-4 pt-6 sm:px-8 lg:px-12">
          <Link href="/" className="font-medium">AgentShelf</Link>
        </header>
      )}
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-7 px-4 py-10 sm:px-8">
        <div className="flex flex-col gap-2">
          <p className={`text-sm ${quiet}`}>Seller access</p>
          <h1 className="text-3xl font-medium tracking-tight">{isFirstPayPalShop ? "Set up your shop" : session ? "Your seller account" : "Sign in with PayPal Sandbox"}</h1>
          <p className={`max-w-lg text-pretty ${quiet}`}>
            {isFirstPayPalShop
              ? "Confirm your shop details, then choose whether to connect it for PayPal Sandbox payments."
              : session
                ? "Your owner session is active. Open your shops to continue managing your seller account."
                : "Use your PayPal Sandbox account to sign in. Connecting your shop for payments is a separate step you approve on PayPal."}
          </p>
        </div>

        {initialMessage ? <p role="status" className="rounded-lg bg-zinc-100 p-4 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">{initialMessage}</p> : null}
        {loadError ? <p role="alert" className="text-sm text-blocked">{loadError}</p> : null}

        {!checked && !loadError ? <p className={`text-sm ${quiet}`}>Checking your AgentShelf account</p> : null}

        {checked && !session && !loadError ? (
          <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
            <a
              href="/api/seller/identity/paypal/start"
              className="inline-flex h-11 w-fit items-center rounded-lg bg-ink px-4 font-medium text-background transition-[background-color,transform] hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink active:scale-[0.98]"
            >
              Continue with PayPal Sandbox
            </a>
            <p className={`text-sm ${quiet}`}>
              AgentShelf never asks for your PayPal password.
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-zinc-200 pt-4 text-sm dark:border-zinc-800">
              <Link href="/seller/owner-sign-in" className="underline underline-offset-4">Use an AgentShelf owner password</Link>
              <Link href="/seller/sign-in" className="underline underline-offset-4">Use existing shop access</Link>
            </div>
          </section>
        ) : null}

        {checked && session?.shops.length ? (
          <section className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
            <h2 className="text-lg font-medium">Your existing shops are ready</h2>
            <p className={`text-sm ${quiet}`}>Continue to your shops or add another shop from your account.</p>
            <Link href="/seller/shops" className="inline-flex h-11 w-fit items-center rounded-lg bg-ink px-4 font-medium text-background">Open your shops</Link>
          </section>
        ) : null}

        {checked && session && !session.shops.length && session.owner.paypalProfile ? (
          <>
            <section className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
              <h2 className="font-medium">PayPal Sandbox identity</h2>
              <p className="text-sm">{session.owner.paypalProfile.displayName || "Signed in with PayPal Sandbox"}</p>
              {session.owner.paypalProfile.email ? <p className={`text-sm ${quiet}`}>{session.owner.paypalProfile.email}</p> : null}
              <p className={`text-sm ${quiet}`}>Review the suggested name before creating your shop.</p>
              {session.owner.paypalProfile.displayName && session.owner.paypalProfile.displayName.length > 120 ? <p className={`text-sm ${quiet}`}>The suggested shop name was shortened to fit. Review it before creating your shop.</p> : null}
            </section>

            <form onSubmit={createFirstShop} onChange={clearIdempotencyKey} className="flex flex-col gap-4 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
              <div className="flex flex-col gap-1">
                <h2 className="text-lg font-medium">Confirm your first shop</h2>
                <p className={`text-sm ${quiet}`}>Nothing is created until you submit these details.</p>
              </div>
              <label className={labelClass}>Shop name
                <input value={shopName} onChange={(event) => { const value = event.currentTarget.value; setShopName(value); if (!slugEdited) setSlug(makeSlug(value)); }} disabled={busy} required minLength={2} maxLength={120} className={fieldClass} />
              </label>
              <label className={labelClass}>Shop address
                <input value={slug} onChange={(event) => { setSlugEdited(true); setSlug(event.currentTarget.value); }} disabled={busy} required minLength={1} maxLength={80} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" autoCapitalize="none" spellCheck={false} placeholder="liepaja-phone-repair" className={fieldClass} />
                <span className={`text-xs font-normal ${quiet}`}>Lowercase letters, numbers and hyphens</span>
              </label>
              <label className={labelClass}>Shop location
                <input value={location} onChange={(event) => setLocation(event.currentTarget.value)} disabled={busy} required minLength={2} maxLength={160} placeholder="Liepaja, Latvia" className={fieldClass} />
              </label>
              <label className={labelClass}>Shop time zone
                <input value={timezone} onChange={(event) => setTimezone(event.currentTarget.value)} disabled={busy} required maxLength={80} placeholder="Europe/Riga" className={fieldClass} />
              </label>
              <p className={`text-sm ${quiet}`}>Prices use EUR. PayPal payments remain unavailable until you approve a separate Sandbox connection for this shop.</p>
              {shopError ? <p role="alert" className="text-sm text-blocked">{shopError}</p> : null}
              <button type="submit" disabled={busy} className="h-11 w-fit rounded-lg bg-ink px-4 font-medium text-background transition-[background-color,transform] hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink active:scale-[0.98] disabled:opacity-60">{busy ? "Creating shop" : "Create shop and continue"}</button>
            </form>
          </>
        ) : null}

        {checked && session && !session.shops.length && !session.owner.paypalProfile ? (
          <section className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
            <h2 className="text-lg font-medium">An owner account is already signed in</h2>
            <p className={`text-sm ${quiet}`}>Your AgentShelf account does not have a PayPal profile attached. Use its shop tools, or sign out before starting PayPal Sandbox sign-in.</p>
            <div className="flex flex-wrap gap-4">
              <Link href="/seller/shops" className="underline underline-offset-4">Open your shops</Link>
              <Link href="/seller/shops/new" className="underline underline-offset-4">Create a shop</Link>
            </div>
          </section>
        ) : null}
      </main>
    </>
  );
}
