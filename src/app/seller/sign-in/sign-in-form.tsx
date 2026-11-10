"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

const fieldClass =
  "h-11 w-full rounded-lg border border-zinc-300 bg-transparent px-3 text-base font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink dark:border-zinc-700";

function signInError(code: string | undefined, message: string | undefined): string {
  if (code === "UNAUTHORIZED") {
    return `${message ?? "This shop and access code do not match."} Check both and try again.`;
  }
  return code === "INVALID_INPUT"
    ? "Enter a shop name and an access code."
    : "Signing in did not work on our side. Try again in a moment.";
}

export function SignInForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/seller/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shopSlug: form.get("shop"),
          accessCode: form.get("code"),
        }),
      });
      if (response.ok) {
        router.replace("/seller/assistant");
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      setError(signInError(body?.error?.code, body?.error?.message));
    } catch {
      setError("The server did not answer. Check your connection and try again.");
    }
    // After a success the button stays busy until the next page has loaded.
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium">
        Shop name
        <input
          name="shop"
          required
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="demo-phone-workshop"
          className={fieldClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Access code
        <input
          name="code"
          type="password"
          required
          autoComplete="current-password"
          className={fieldClass}
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-blocked">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="h-11 rounded-lg bg-ink px-4 font-medium text-background transition-[background-color,transform] hover:bg-ink/90 active:scale-[0.98] disabled:opacity-60"
      >
        {busy ? "Signing in" : "Sign in"}
      </button>
    </form>
  );
}
