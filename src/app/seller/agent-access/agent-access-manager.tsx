"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { isUnauthorized, readOwnerSession, type OwnerSession } from "../identity/owner-session";

const SCOPES = [
  { id: "read_shop", label: "Read shop details", detail: "Read the selected shop's public profile and payment setup status." },
  { id: "manage_catalog", label: "Manage the catalog", detail: "Add, edit and publish products for the selected shop." },
  { id: "manage_inventory", label: "Manage inventory", detail: "Update quantities and stock policy for the selected shop." },
  { id: "connect_paypal", label: "Connect a sandbox seller account", detail: "Start the selected shop's PayPal sandbox connection flow." },
] as const;

type Grant = { grantToken: string; shopId: string | null; scopes: string[]; expiresAt: string };

export function AgentAccessManager() {
  const router = useRouter();
  const [session, setSession] = useState<OwnerSession | null>(null);
  const [shopId, setShopId] = useState("");
  const [createShop, setCreateShop] = useState(false);
  const [scopes, setScopes] = useState<string[]>([]);
  const [shareDataConsentShopId, setShareDataConsentShopId] = useState<string | null>(null);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [revokeToken, setRevokeToken] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    readOwnerSession().then((value) => {
      if (!active) return;
      setSession(value);
      setShopId(value.selectedShopId ?? value.shops[0]?.id ?? "");
    }).catch((reason: unknown) => {
      if (!active) return;
      if (isUnauthorized(reason)) router.replace("/seller/owner-sign-in");
      else setError("Account details could not be loaded. Try again.");
    });
    return () => { active = false; };
  }, [router]);

  function toggleScope(scope: string) {
    setScopes((current) => {
      const next = current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope];
      if (!next.includes("connect_paypal")) setShareDataConsentShopId(null);
      return next;
    });
  }

  async function issueGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    const selectedScopes = createShop ? ["create_shop"] : scopes;
    try {
      const response = await fetch("/api/seller/identity/agent-grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shopId: createShop ? null : shopId,
          scopes: selectedScopes,
          ...(selectedScopes.includes("connect_paypal") && shareDataConsentShopId === shopId ? { shareDataConsent: true } : {}),
        }),
      });
      if (response.ok) {
        const result = (await response.json()) as Grant;
        setGrant(result);
        setRevokeToken(result.grantToken);
        setScopes([]);
        setShareDataConsentShopId(null);
        setMessage("Credential issued. Copy it now; it will not be shown again after you leave this page.");
      } else if (response.status === 401) {
        router.replace("/seller/owner-sign-in");
        return;
      } else {
        setError("Permission was not issued. Review the selection and try again.");
      }
    } catch {
      setError("The server did not answer. Check your connection and try again.");
    }
    setBusy(false);
  }

  async function revokeGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/seller/identity/agent-grants/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grantToken: revokeToken }),
      });
      if (response.ok) {
        setGrant(null);
        setRevokeToken("");
        setMessage("Permission revoked.");
      } else if (response.status === 401) {
        router.replace("/seller/owner-sign-in");
        return;
      } else {
        setError("Permission could not be revoked. Check the credential and try again.");
      }
    } catch {
      setError("The server did not answer. Check your connection and try again.");
    }
    setBusy(false);
  }

  const canIssue = createShop || (Boolean(shopId) && scopes.length > 0 && (!scopes.includes("connect_paypal") || shareDataConsentShopId === shopId));
  const shopChoices = session?.shops ?? [];

  return (
    <div className="flex flex-col gap-8">
      {error ? <p role="alert" className="text-sm text-blocked">{error}</p> : null}
      {message ? <p role="status" className="text-sm text-accepted">{message}</p> : null}
      {!session ? <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading account</p> : null}
      {session ? (
        <>
          <form onSubmit={issueGrant} className="flex flex-col gap-5 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
            <div className="flex flex-col gap-2">
              <h2 className="text-lg font-medium">Give an agent permission</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">Choose one shop and only the actions the agent needs. Each credential expires in 15 minutes.</p>
            </div>
            <label className="flex items-start gap-3 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
              <input type="checkbox" checked={createShop} onChange={(event) => { setCreateShop(event.currentTarget.checked); setScopes([]); setShareDataConsentShopId(null); }} className="mt-1 accent-ink" />
              <span><span className="block font-medium">Let the agent create one shop</span><span className="mt-1 block text-zinc-600 dark:text-zinc-400">This permission is limited to creating a shop and can be used once.</span></span>
            </label>
            {createShop ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">The agent can submit one shop name, address and location. It cannot configure PayPal or manage other shops with this permission.</p>
            ) : (
              <>
                {shopChoices.length ? (
                  <label className="flex flex-col gap-1 text-sm font-medium">Shop
                    <select value={shopId} onChange={(event) => { setShopId(event.currentTarget.value); setShareDataConsentShopId(null); }} required className="h-11 rounded-lg border border-zinc-300 bg-background px-3 dark:border-zinc-700">
                      {shopChoices.map((shop) => <option key={shop.id} value={shop.id}>{shop.name} · {shop.location}</option>)}
                    </select>
                  </label>
                ) : (
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">Create a shop first or authorize the agent to create your first shop.</p>
                )}
                <fieldset className="flex flex-col gap-3">
                  <legend className="mb-2 text-sm font-medium">Permissions for this shop</legend>
                  {SCOPES.map((scope) => (
                    <label key={scope.id} className="flex items-start gap-3 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
                      <input type="checkbox" checked={scopes.includes(scope.id)} onChange={() => toggleScope(scope.id)} disabled={!shopId} className="mt-1 accent-ink" />
                      <span><span className="block font-medium">{scope.label}</span><span className="mt-1 block text-zinc-600 dark:text-zinc-400">{scope.detail}</span></span>
                    </label>
                  ))}
                </fieldset>
                {scopes.includes("connect_paypal") ? (
                  <label className="flex items-start gap-3 rounded-lg border border-zinc-300 p-4 text-sm dark:border-zinc-700">
                    <input
                      type="checkbox"
                      checked={shareDataConsentShopId === shopId}
                      onChange={(event) => setShareDataConsentShopId(event.currentTarget.checked ? shopId : null)}
                      className="mt-1 accent-ink"
                    />
                    <span>
                      I agree to share this shop&rsquo;s data with PayPal to start connecting its Sandbox account
                      <span className="mt-1 block text-zinc-600 dark:text-zinc-400">This consent is required for the agent to start the PayPal connection. The buyer or seller still completes any required PayPal steps.</span>
                    </span>
                  </label>
                ) : null}
              </>
            )}
            <p className="text-sm text-zinc-600 dark:text-zinc-400">The credential is a bearer secret. Share it only with the agent you intend to authorize. The agent cannot approve or expand its own access.</p>
            <button type="submit" disabled={busy || !canIssue} className="h-11 rounded-lg bg-ink px-4 font-medium text-background transition-[background-color,transform] hover:bg-ink/90 active:scale-[0.98] disabled:opacity-60">{busy ? "Issuing permission" : "Review and issue credential"}</button>
          </form>

          {grant ? (
            <section aria-labelledby="issued-title" className="flex flex-col gap-3 rounded-xl border border-ink p-5">
              <h2 id="issued-title" className="text-lg font-medium">Credential issued</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">Expires {new Date(grant.expiresAt).toLocaleString()}. This credential is shown once; keep it in the agent&rsquo;s secure settings.</p>
              <label className="flex flex-col gap-1 text-sm font-medium">Agent credential
                <input readOnly value={grant.grantToken} autoComplete="off" spellCheck={false} className="h-11 w-full rounded-lg border border-zinc-300 bg-background px-3 font-mono text-sm dark:border-zinc-700" />
              </label>
              <button type="button" onClick={() => navigator.clipboard.writeText(grant.grantToken)} className="h-10 w-fit rounded-lg border border-zinc-300 px-4 text-sm font-medium transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">Copy credential</button>
              <div className="flex flex-col gap-1 text-sm">
                <p className="font-medium">Connect the assistant to this address</p>
                <code className="rounded-lg bg-zinc-100 px-3 py-2 font-mono break-all select-all dark:bg-zinc-800">{window.location.origin}{grant.shopId ? `/mcp/seller/shop/${grant.shopId}` : "/mcp/seller/onboarding"}</code>
                <p className="text-zinc-600 dark:text-zinc-400">Send the credential as a Bearer header. <a href="https://github.com/ever-guild/AgentShelf/blob/main/docs/seller-agent-mcp.md#connect-claude-code" className="underline underline-offset-4 transition-colors hover:text-ink">Read the connection guide</a></p>
              </div>
            </section>
          ) : null}

          <form onSubmit={revokeGrant} className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
            <h2 className="text-lg font-medium">Revoke a credential</h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Credentials are not stored in a list. Paste the credential you want to revoke; the matching grant will stop working immediately.</p>
            <label className="flex flex-col gap-1 text-sm font-medium">Credential to revoke
              <input required value={revokeToken} onChange={(event) => setRevokeToken(event.currentTarget.value)} autoComplete="off" spellCheck={false} className="h-11 w-full rounded-lg border border-zinc-300 bg-background px-3 font-mono text-sm dark:border-zinc-700" />
            </label>
            <button type="submit" disabled={busy || !revokeToken.trim()} className="h-10 w-fit rounded-lg border border-zinc-300 px-4 text-sm font-medium transition-colors hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800">Revoke credential</button>
          </form>
        </>
      ) : null}
    </div>
  );
}
