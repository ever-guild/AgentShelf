"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CatalogProductPatch,
  CatalogProductView,
  CatalogSyncAnswer,
  CatalogView,
} from "@/server/contracts/seller-catalog";

import { RequestFailed, request } from "../imports/[id]/request";

const inputClass =
  "w-full min-w-0 rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-base focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink md:text-sm dark:border-zinc-700";
const quietButton =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900";

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

// The key follows the server's text, so a saved value that was rewritten, such as 12,5 to 12.50,
// replaces what was typed, and a refused one stays for correcting.
function AmountField({
  label,
  product,
  value,
  currency,
  disabled,
  onCommit,
}: {
  label: string;
  product: string;
  value: string | null;
  currency: string;
  disabled: boolean;
  onCommit: (text: string) => void;
}) {
  const current = value ?? "";
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
      {label} in {currency}
      <input
        key={current}
        aria-label={`${label} in ${currency}: ${product}`}
        defaultValue={current}
        inputMode="decimal"
        disabled={disabled}
        className={`${inputClass} text-foreground`}
        onBlur={(event) => {
          if (event.target.value.trim() !== current) {
            onCommit(event.target.value);
          }
        }}
      />
    </label>
  );
}

function SyncStatus({
  product,
  timezone,
  disabled,
  onRetry,
}: {
  product: CatalogProductView;
  timezone: string;
  disabled: boolean;
  onRetry: () => void;
}) {
  const { sync } = product;
  if (sync.status === "synced") {
    return (
      <p className="text-sm">
        <span className="text-accepted">In PayPal Catalog</span>
        {sync.syncedAt ? (
          <span className="text-zinc-600 dark:text-zinc-400">
            , sent{" "}
            {new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: timezone }).format(
              new Date(sync.syncedAt),
            )}
          </span>
        ) : null}
        <span className="mt-0.5 block break-all font-mono text-xs text-zinc-500">
          {sync.paypalProductId}
        </span>
      </p>
    );
  }
  if (product.status === "unpublished") {
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">Not sent to PayPal Catalog</p>;
  }
  if (sync.status === "pending") {
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">Waiting to go to PayPal Catalog</p>;
  }
  if (sync.status === "not_configured") {
    return <p className="text-sm text-doubt">PayPal Catalog is not connected</p>;
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <p className="text-sm text-blocked">Not in PayPal Catalog. {sync.problem}</p>
      <button
        type="button"
        disabled={disabled}
        aria-label={`Try again: ${product.title}`}
        onClick={onRetry}
        className={quietButton}
      >
        Try again
      </button>
    </div>
  );
}

function ProductRow({
  product,
  currency,
  timezone,
  busy,
  onSave,
  onRetry,
}: {
  product: CatalogProductView;
  currency: string;
  timezone: string;
  busy: boolean;
  onSave: (patch: CatalogProductPatch) => Promise<void>;
  onRetry: () => void;
}) {
  const [refused, setRefused] = useState<string | null>(null);
  const onSale = product.status === "published";

  async function save(patch: CatalogProductPatch) {
    setRefused(null);
    try {
      await onSave(patch);
    } catch (error) {
      setRefused(error instanceof Error ? error.message : "That change did not save. Try again.");
    }
  }

  return (
    <li
      className={`grid gap-3 border-b border-l-4 border-b-zinc-200 py-3 pl-3 pr-1 md:grid-cols-[minmax(0,2fr)_minmax(9rem,1fr)_minmax(0,2fr)_auto] dark:border-b-zinc-800 ${
        onSale ? "border-l-accepted" : "border-l-zinc-300 dark:border-l-zinc-700"
      }`}
    >
      <div className="min-w-0">
        <p className="break-words font-medium">{product.title}</p>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {product.kind === "service"
            ? `Service, ${product.serviceDurationMinutes ?? "?"} minutes`
            : "Product"}
          {onSale ? "" : ", not on sale"}
        </p>
        {product.description ? (
          <p className="mt-1 break-words text-sm text-zinc-600 dark:text-zinc-400">{product.description}</p>
        ) : null}
        {product.descriptionLv ? (
          <p lang="lv" className="mt-1 break-words text-sm text-zinc-600 dark:text-zinc-400">
            {product.descriptionLv}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <AmountField
          label="Price"
          product={product.title}
          value={product.price}
          currency={currency}
          disabled={busy}
          onCommit={(text) => save({ price: text })}
        />
        {product.kind === "service" ? (
          <AmountField
            label="Deposit"
            product={product.title}
            value={product.deposit}
            currency={currency}
            disabled={busy}
            onCommit={(text) => save({ deposit: text })}
          />
        ) : null}
        {refused ? (
          <p role="alert" className="text-xs text-blocked">
            {refused}
          </p>
        ) : null}
      </div>
      <SyncStatus product={product} timezone={timezone} disabled={busy} onRetry={onRetry} />
      <div>
        <button
          type="button"
          disabled={busy}
          aria-label={`${onSale ? "Unpublish" : "Publish again"}: ${product.title}`}
          onClick={() => save({ status: onSale ? "unpublished" : "published" })}
          className={quietButton}
        >
          {onSale ? "Unpublish" : "Publish again"}
        </button>
      </div>
    </li>
  );
}

export function CatalogManager({ initial, timezone }: { initial: CatalogView; timezone: string }) {
  const [view, setView] = useState(initial);
  const [sending, setSending] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const latest = useRef(0);
  const started = useRef(false);
  const router = useRouter();

  // A session that ended goes back to signing in, wherever it was noticed.
  const call = useCallback(
    async <T,>(url: string, init: RequestInit): Promise<T> => {
      try {
        return await request<T>(url, {
          ...init,
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        if (error instanceof RequestFailed && error.failure.code === "UNAUTHORIZED") {
          router.replace("/seller/sign-in");
        }
        throw error;
      }
    },
    [router],
  );

  // An older answer arriving after a newer one must not put old values back on the screen.
  const show = useCallback((next: CatalogView, id: number) => {
    if (id === latest.current) {
      setView(next);
    }
  }, []);

  const saveProduct = useCallback(
    async (productId: string, patch: CatalogProductPatch) => {
      latest.current += 1;
      const id = latest.current;
      show(
        await call<CatalogView>(`/api/seller/catalog/${productId}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
        id,
      );
    },
    [call, show],
  );

  // One batch at a time, so progress shows and a closed tab loses nothing. A batch that leaves the
  // count where it was has nothing more to offer.
  const send = useCallback(
    async (first: { productId?: string; retryFailed?: true } = {}) => {
      setSending(first.productId ?? "all");
      setProblem(null);
      const sync = async (body: object) => {
        latest.current += 1;
        const id = latest.current;
        const answer = await call<CatalogSyncAnswer>("/api/seller/catalog/sync", {
          method: "POST",
          body: JSON.stringify(body),
        });
        show(answer.view, id);
        return answer;
      };
      try {
        let answer = await sync(first);
        let previous = Number.POSITIVE_INFINITY;
        while (!first.productId && !answer.stopped && answer.remaining > 0 && answer.remaining < previous) {
          previous = answer.remaining;
          answer = await sync({});
        }
        if (answer.stopped) {
          setProblem(
            "PayPal is not answering, so the rest are still waiting. Your products stay on sale. Try again in a few minutes.",
          );
        }
      } catch (error) {
        setProblem(error instanceof Error ? error.message : "Something went wrong. Try again.");
      } finally {
        setSending(null);
      }
    },
    [call, show],
  );

  // Whatever is waiting goes now, including what a closed tab left behind.
  const waitingAtStart = initial.counts.waiting > 0;
  useEffect(() => {
    if (waitingAtStart && !started.current) {
      started.current = true;
      void send();
    }
  }, [waitingAtStart, send]);

  const { published, unpublished, waiting, unsent } = view.counts;
  const working = sending !== null;
  const notConnected = view.products.find(
    (product) => product.status === "published" && product.sync.status === "not_configured",
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Your catalog</h1>
        <p aria-live="polite" className="text-zinc-600 dark:text-zinc-400">
          {plural(published, "product")} on sale
          {unpublished > 0 ? `, ${unpublished} unpublished` : ""}
          {sending === "all" && waiting > 0 ? `. Sending to PayPal Catalog, ${waiting} left` : ""}
        </p>
        <p className="max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
          Prices and what is on sale are kept here, and buyers&apos; assistants read them from here. A
          PayPal Catalog record is only a reference: it holds a name and a description, and it does not
          list your product in PayPal Store Sync, Agent Ready or any other shopping search. PayPal
          cannot delete a record, so unpublishing stops sales here and leaves the record where it is.
        </p>
      </header>

      {notConnected ? (
        <p className="max-w-prose border-l-4 border-doubt pl-4">{notConnected.sync.problem}</p>
      ) : null}

      {unsent > 0 && !working ? (
        <div>
          <button type="button" onClick={() => send({ retryFailed: true })} className={quietButton}>
            Send {plural(unsent, "product")} to PayPal Catalog
          </button>
        </div>
      ) : null}

      {problem ? (
        <p role="alert" className="max-w-prose text-sm text-blocked">
          {problem}
        </p>
      ) : null}

      {view.products.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          Nothing here yet.{" "}
          <Link href="/seller/imports" className="underline underline-offset-4">
            Upload a price list
          </Link>{" "}
          to fill your catalog.
        </p>
      ) : (
        <ul className="flex flex-col border-t border-zinc-200 dark:border-zinc-800">
          {view.products.map((product) => (
            <ProductRow
              key={product.id}
              product={product}
              currency={view.shopCurrency}
              timezone={timezone}
              busy={working}
              onSave={(patch) => saveProduct(product.id, patch)}
              onRetry={() => void send({ productId: product.id })}
            />
          ))}
        </ul>
      )}

      {view.truncated ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Showing the first {view.products.length} products by name.
        </p>
      ) : null}
    </div>
  );
}
