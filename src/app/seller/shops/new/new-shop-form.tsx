"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

const fieldClass = "h-11 w-full rounded-lg border border-zinc-300 bg-background px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink dark:border-zinc-700";
const labelClass = "flex flex-col gap-1 text-sm font-medium";

export function NewShopForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/seller/identity/shops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: idempotencyKey.current ?? (idempotencyKey.current = crypto.randomUUID()),
          shop: {
            name: form.get("name"), slug: form.get("slug"), location: form.get("location"),
            currency: "EUR", timezone: form.get("timezone"),
          },
        }),
      });
      if (response.ok) {
        router.replace("/seller/assistant");
        router.refresh();
        return;
      }
      if (response.status === 401) {
        router.replace("/seller/owner-sign-in");
        return;
      }
      const result = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      setError(result?.error?.code === "CONFLICT" ? "That shop address is already taken. Choose another." : "The shop could not be created. Check the fields and try again.");
    } catch {
      setError("The server did not answer. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} onChange={() => { idempotencyKey.current = null; }} className="flex flex-col gap-4">
      <label className={labelClass}>Shop name<input name="name" required minLength={2} maxLength={120} className={fieldClass} /></label>
      <label className={labelClass}>Shop address<input name="slug" required maxLength={80} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="liepaja-phone-repair" autoCapitalize="none" spellCheck={false} className={fieldClass} /><span className="text-xs font-normal text-zinc-600 dark:text-zinc-400">Lowercase letters, numbers and hyphens</span></label>
      <label className={labelClass}>Location<input name="location" required minLength={2} maxLength={160} placeholder="Liepaja, Latvia" className={fieldClass} /></label>
      <label className={labelClass}>Time zone<input name="timezone" required maxLength={80} defaultValue="Europe/Riga" className={fieldClass} /></label>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">Prices use EUR. PayPal starts unconfigured.</p>
      {error ? <p role="alert" className="text-sm text-blocked">{error}</p> : null}
      <button type="submit" disabled={busy} className="h-11 rounded-lg bg-ink px-4 font-medium text-background transition-[background-color,transform] hover:bg-ink/90 active:scale-[0.98] disabled:opacity-60">{busy ? "Creating shop" : "Create shop"}</button>
    </form>
  );
}
