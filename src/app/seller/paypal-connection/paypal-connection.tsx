"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { isUnauthorized, readOwnerSession, type OwnerSession } from "../identity/owner-session";
import {
  createShopRequestGuard,
  deriveConnectionControls,
  shouldKeepActionUrl,
  statusLabel,
  type ConnectionResponse,
} from "./connection-state";

export function PayPalConnection() {
  const router = useRouter();
  const [session, setSession] = useState<OwnerSession | null>(null);
  const [shopId, setShopId] = useState("");
  const [connection, setConnection] = useState<ConnectionResponse | null>(null);
  const [shareDataConsent, setShareDataConsent] = useState(false);
  const [actionUrl, setActionUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const requestGuard = useRef(createShopRequestGuard());

  const refreshConnection = useCallback(async (selectedShopId: string, recheckAtPayPal = false) => {
    const ticket = requestGuard.current.beginRefresh(selectedShopId);
    setLoading(true);
    setError(null);
    try {
      const response = recheckAtPayPal
        ? await fetch("/api/seller/paypal/connection/refresh", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ shopId: selectedShopId }),
          })
        : await fetch(`/api/seller/paypal/connection?shopId=${encodeURIComponent(selectedShopId)}`, { cache: "no-store" });
      if (!requestGuard.current.isCurrentRefresh(ticket)) return;
      if (response.status === 401) {
        router.replace("/seller/owner-sign-in");
        return;
      }
      if (response.status === 503) {
        setActionUrl(null);
        setConnection({ connection: { shopId: selectedShopId, status: "not_connected" }, configured: false });
        setLoading(false);
        return;
      }
      if (!response.ok) throw new Error("Connection status could not be loaded.");
      const result = (await response.json()) as { connection: ConnectionResponse["connection"]; configured?: boolean; webhookConfigured?: boolean };
      if (!requestGuard.current.isCurrentRefresh(ticket, result.connection?.shopId)) return;
      setConnection((current) => ({
        connection: result.connection,
        configured: result.configured ?? current?.configured ?? true,
        webhookConfigured: result.webhookConfigured ?? current?.webhookConfigured,
      }));
      if (!shouldKeepActionUrl(result.connection)) setActionUrl(null);
    } catch (reason) {
      if (!requestGuard.current.isCurrentRefresh(ticket)) return;
      setError(reason instanceof Error ? reason.message : "Connection status could not be loaded.");
    }
    if (requestGuard.current.isCurrentRefresh(ticket)) setLoading(false);
  }, [router]);

  useEffect(() => {
    let active = true;
    readOwnerSession().then(async (value) => {
      if (!active) return;
      setSession(value);
      const requestedShopId = new URLSearchParams(window.location.search).get("shopId");
      const callbackShopId = requestedShopId && value.shops.some(({ id }) => id === requestedShopId) ? requestedShopId : null;
      const initialShopId = callbackShopId ?? value.selectedShopId ?? value.shops[0]?.id ?? "";
      requestGuard.current.switchShop(initialShopId);
      setShopId(initialShopId);
      if (initialShopId) await refreshConnection(initialShopId);
      else setLoading(false);
    }).catch((reason: unknown) => {
      if (!active) return;
      if (isUnauthorized(reason)) router.replace("/seller/owner-sign-in");
      else {
        setError("Account details could not be loaded. Try again.");
        setLoading(false);
      }
    });
    return () => { active = false; };
  }, [refreshConnection, router]);

  async function chooseShop(nextShopId: string) {
    requestGuard.current.switchShop(nextShopId);
    setShopId(nextShopId);
    setConnection(null);
    setActionUrl(null);
    setNotice(null);
    setError(null);
    setBusy(false);
    setShareDataConsent(false);
    idempotencyKey.current = null;
    await refreshConnection(nextShopId);
  }

  async function startConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!shareDataConsent || !shopId) return;
    const targetShopId = shopId;
    const ticket = requestGuard.current.beginStart(targetShopId);
    setBusy(true);
    setError(null);
    setNotice(null);
    setActionUrl(null);
    try {
      const response = await fetch("/api/seller/paypal/connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shopId: targetShopId, idempotencyKey: idempotencyKey.current ?? (idempotencyKey.current = crypto.randomUUID()), shareDataConsent: true }),
      });
      if (!requestGuard.current.isCurrentStart(ticket)) return;
      if (response.status === 401) {
        router.replace("/seller/owner-sign-in");
        return;
      }
      if (response.status === 503) {
        setActionUrl(null);
        setConnection({ connection: { shopId: targetShopId, status: "not_connected" }, configured: false });
        setBusy(false);
        return;
      }
      if (!response.ok) {
        setError("The PayPal Sandbox connection could not be started. Refresh the status and try again.");
        setBusy(false);
        return;
      }
      const result = (await response.json()) as { connection: ConnectionResponse["connection"]; actionUrl?: string };
      if (!requestGuard.current.isCurrentStart(ticket, result.connection?.shopId)) return;
      setConnection((current) => current ? { ...current, connection: result.connection } : { connection: result.connection, configured: true });
      idempotencyKey.current = null;
      setShareDataConsent(false);
      if (result.actionUrl && shouldKeepActionUrl(result.connection)) {
        setActionUrl(result.actionUrl);
      } else {
        setActionUrl(null);
        setNotice(result.connection.status === "pending"
          ? "The connection must be resumed by the owner who started it. Contact the platform administrator if the link remains unavailable."
          : "A connection is already in progress. Refresh the status after approving it on PayPal.");
      }
    } catch {
      if (!requestGuard.current.isCurrentStart(ticket)) return;
      setError("The server did not answer. Check your connection and try again.");
    }
    if (requestGuard.current.isCurrentStart(ticket)) setBusy(false);
  }

  const shops = session?.shops ?? [];
  const {
    continueUrl,
    canStart,
    showConnectionForm,
    actionButtonLabel,
    busyButtonLabel,
    guidance,
  } = deriveConnectionControls({
    loading,
    shopId,
    shareDataConsent,
    connection,
    actionUrl,
  });

  return (
    <div className="flex flex-col gap-5">
      {error ? <p role="alert" className="text-sm text-blocked">{error}</p> : null}
      {notice ? <p role="status" className="text-sm text-accepted">{notice}</p> : null}
      {session && shops.length ? (
        <label className="flex max-w-xl flex-col gap-1 text-sm font-medium">Shop
          <select value={shopId} onChange={(event) => void chooseShop(event.currentTarget.value)} className="h-11 rounded-lg border border-zinc-300 bg-background px-3 dark:border-zinc-700">
            {shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name} · {shop.location}</option>)}
          </select>
        </label>
      ) : null}
      {session && !shops.length ? (
        <section className="flex max-w-xl flex-col gap-3 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
          <h2 className="text-lg font-medium">Create a shop first</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">PayPal Sandbox connects to a shop. Add a shop before starting the connection.</p>
          <a href="/seller/shops/new" className="inline-flex h-10 w-fit items-center rounded-lg bg-ink px-4 text-sm font-medium text-background">Add a shop</a>
        </section>
      ) : null}
      {shopId ? (
        <section aria-live="polite" className="flex max-w-2xl flex-col gap-4 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-medium">Sandbox connection status</h2>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{loading ? "Checking status" : connection ? statusLabel(connection.connection.status) : "Status unavailable"}</p>
            </div>
            <button type="button" disabled={loading} onClick={() => void refreshConnection(shopId, true)} className="h-9 rounded-lg border border-zinc-300 px-3 text-sm transition-colors hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800">Refresh status</button>
          </div>
          {!loading && connection && !connection.configured ? (
            <p role="status" className="rounded-lg bg-zinc-100 p-4 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">PayPal Sandbox connection is blocked until the platform sandbox setup is complete. No connection request was sent. Contact the platform administrator when setup is ready.</p>
          ) : null}
          {!loading && connection?.configured && connection.webhookConfigured === false ? (
            <p role="status" className="rounded-lg bg-zinc-100 p-4 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">The platform PayPal webhook is not configured. Payment completion cannot be verified until the platform administrator finishes webhook setup.</p>
          ) : null}
          {guidance ? (
            <p className="rounded-lg bg-zinc-100 p-4 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">{guidance}</p>
          ) : null}
          {continueUrl ? (
            <a href={continueUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 w-fit items-center rounded-lg bg-ink px-4 font-medium text-background transition-[background-color,transform] hover:bg-ink/90 active:scale-[0.98]">Continue to PayPal Sandbox</a>
          ) : null}
          {showConnectionForm ? (
            <form onSubmit={startConnection} className="flex flex-col gap-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" checked={shareDataConsent} onChange={(event) => setShareDataConsent(event.currentTarget.checked)} className="mt-1 accent-ink" />
                <span>I agree to share this shop&rsquo;s data with PayPal to start connecting its Sandbox account</span>
              </label>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">PayPal opens the consent and account steps. AgentShelf does not collect PayPal passwords or make live connections.</p>
              <button type="submit" disabled={busy || !canStart} className="h-11 w-fit rounded-lg bg-ink px-4 font-medium text-background transition-[background-color,transform] hover:bg-ink/90 active:scale-[0.98] disabled:opacity-60">{busy ? busyButtonLabel : actionButtonLabel}</button>
            </form>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
