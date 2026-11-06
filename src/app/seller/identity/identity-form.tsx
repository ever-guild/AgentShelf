"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

const fieldClass =
  "h-11 w-full rounded-lg border border-zinc-300 bg-background px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink dark:border-zinc-700";
const labelClass = "flex flex-col gap-1 text-sm font-medium";
const quiet = "text-zinc-600 dark:text-zinc-400";

type Mode = "register" | "sign-in";

function friendlyError(code?: string): string {
  if (code === "UNAUTHORIZED") return "That username and password do not match.";
  if (code === "CONFLICT") return "That username or shop address is already in use. Try another one.";
  if (code === "INVALID_INPUT") return "Check the fields and try again.";
  if (code === "RATE_LIMITED") return "There have been too many attempts. Wait a little and try again.";
  return "The request could not be completed. Try again in a moment.";
}

export function IdentityForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeShop, setIncludeShop] = useState(true);
  const idempotencyKey = useRef<string | null>(null);
  const registering = mode === "register";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setError(null);

    const body: Record<string, unknown> = {
      username: form.get("username"),
      password: form.get("password"),
    };
    if (registering) {
      idempotencyKey.current ??= crypto.randomUUID();
      body.idempotencyKey = idempotencyKey.current;
      if (includeShop) {
        body.shop = {
          name: form.get("shopName"),
          slug: form.get("slug"),
          location: form.get("location"),
          currency: "EUR",
          timezone: form.get("timezone"),
        };
      }
    }

    try {
      const response = await fetch(
        registering ? "/api/seller/identity/register" : "/api/seller/identity/sign-in",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (response.ok) {
        router.replace("/seller/shops");
        router.refresh();
        return;
      }
      const result = (await response.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      setError(friendlyError(result?.error?.code));
    } catch {
      setError("The server did not answer. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} onChange={() => { idempotencyKey.current = null; }} className="flex flex-col gap-5">
      <div className="flex flex-col gap-4">
        <label className={labelClass}>
          Username
          <input
            name="username"
            required
            minLength={3}
            maxLength={64}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            className={fieldClass}
          />
        </label>
        <label className={labelClass}>
          Password
          <input
            name="password"
            type="password"
            required
            minLength={registering ? 12 : 1}
            maxLength={128}
            autoComplete={registering ? "new-password" : "current-password"}
            className={fieldClass}
          />
          {registering ? <span className={`text-xs font-normal ${quiet}`}>Use at least 12 characters</span> : null}
        </label>
      </div>

      {registering ? (
        <fieldset className="flex flex-col gap-4 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
          <legend className="px-1 text-sm font-medium">First shop</legend>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={includeShop}
              onChange={(event) => setIncludeShop(event.currentTarget.checked)}
              className="mt-1 accent-ink"
            />
            <span>
              <span className="block font-medium">Create a shop with this account</span>
              <span className={`mt-1 block ${quiet}`}>
                Leave this off if you want to authorize your agent to create your first shop.
              </span>
            </span>
          </label>
          {includeShop ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className={`${labelClass} sm:col-span-2`}>
                Shop name
                <input name="shopName" required minLength={2} maxLength={120} className={fieldClass} />
              </label>
              <label className={`${labelClass} sm:col-span-2`}>
                Shop address
                <input
                  name="slug"
                  required
                  minLength={1}
                  maxLength={80}
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="liepaja-phone-repair"
                  className={fieldClass}
                />
                <span className={`text-xs font-normal ${quiet}`}>Lowercase letters, numbers and hyphens</span>
              </label>
              <label className={labelClass}>
                Location
                <input name="location" required minLength={2} maxLength={160} placeholder="Liepaja, Latvia" className={fieldClass} />
              </label>
              <label className={labelClass}>
                Time zone
                <input name="timezone" required maxLength={80} defaultValue="Europe/Riga" className={fieldClass} />
              </label>
              <p className={`text-xs sm:col-span-2 ${quiet}`}>Prices use EUR. PayPal remains unconfigured until you connect a sandbox seller account.</p>
            </div>
          ) : null}
        </fieldset>
      ) : null}

      {error ? <p role="alert" className="text-sm text-blocked">{error}</p> : null}
      <button
        type="submit"
        disabled={busy}
        className="h-11 rounded-lg bg-ink px-4 font-medium text-background transition-[background-color,transform] hover:bg-ink/90 active:scale-[0.98] disabled:opacity-60"
      >
        {busy ? (registering ? "Creating account" : "Signing in") : registering ? "Create owner account" : "Sign in"}
      </button>
    </form>
  );
}
