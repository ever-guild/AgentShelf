"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import type {
  CatalogProductPatch,
  CatalogProductView,
  CatalogSyncAnswer,
  CatalogView,
} from "@/server/contracts/seller-catalog";

import { AMOUNT_HINT } from "../amount-hint";
import { RequestFailed, request } from "../imports/[id]/request";
import { ProductStockControl } from "./product-stock-control";
import {
  type StockControlViewState,
  formatSellerProductStockSummary,
} from "./stock-control-state";

const inputClass =
  "h-10 w-full min-w-0 rounded-lg border border-zinc-300 bg-transparent px-2 text-right text-base text-foreground tabular-nums transition-colors disabled:opacity-60 aria-invalid:border-blocked md:h-9 md:text-sm dark:border-zinc-700 dark:aria-invalid:border-blocked";
const quietButton =
  "inline-flex h-10 items-center rounded-lg border border-zinc-300 px-3 text-sm font-medium whitespace-nowrap transition-[background-color,transform] enabled:hover:bg-zinc-100 enabled:active:scale-[0.98] disabled:opacity-60 md:h-9 dark:border-zinc-700 dark:enabled:hover:bg-zinc-800";
// The page's one main action, the same size as Publish on a price list and the upload button.
const mainButton =
  "inline-flex min-h-11 items-center rounded-lg bg-ink px-4 py-2 font-medium text-background transition-[background-color,transform] enabled:hover:bg-ink/90 enabled:active:scale-[0.98] disabled:opacity-60";
const SECONDARY_TEXT = "text-zinc-600 dark:text-zinc-400";

// One set of columns for the heading and every row, so amounts stay in one line down the page. The
// last one holds "Publish again" on one line. A shop with no services has no deposit column, rather
// than an empty one, and its price column is wide enough for a refusal to read under the field.
const COLUMNS = {
  withDeposit: "md:grid-cols-[minmax(0,3fr)_6rem_6rem_minmax(0,2fr)_8rem] md:gap-x-4",
  priceOnly: "md:grid-cols-[minmax(0,3fr)_8rem_minmax(0,2fr)_8rem] md:gap-x-4",
};

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

type SendRequest = { productId?: string; retryFailed?: true };

// A retry sets what it covers waiting again and sending asks the rule afresh, so one of those left
// not connected afterwards means the connection went after the page loaded.
function connectionLost(view: CatalogView, request: SendRequest): boolean {
  if (!request.productId && !request.retryFailed) {
    return false;
  }
  return view.products.some(
    (product) =>
      (!request.productId || product.id === request.productId) &&
      product.status === "published" &&
      product.sync.status === "not_configured",
  );
}

// The key follows the server's text, so a saved value that was rewritten, such as 12,5 to 12.50,
// replaces what was typed, and a refused one stays for correcting.
function AmountField({
  label,
  product,
  value,
  currency,
  disabled,
  invalid,
  onCommit,
}: {
  label: string;
  product: string;
  value: string | null;
  currency: string;
  disabled: boolean;
  invalid: boolean;
  onCommit: (text: string) => void;
}) {
  const current = value ?? "";
  const hintId = useId();
  // Every product here was published with its amounts, so this is only for one that has lost one.
  const hint = value === null ? hintId : undefined;
  return (
    <label className={`flex min-w-0 flex-col gap-1 text-xs ${SECONDARY_TEXT}`}>
      {/* From tablet width up, the heading above the rows says this. */}
      <span className="md:hidden">
        {label} in {currency}
      </span>
      <input
        key={current}
        aria-label={`${label} in ${currency}: ${product}`}
        aria-describedby={hint}
        aria-invalid={invalid || undefined}
        defaultValue={current}
        inputMode="decimal"
        disabled={disabled}
        className={inputClass}
        onBlur={(event) => {
          if (event.target.value.trim() !== current) {
            onCommit(event.target.value);
          }
        }}
      />
      {hint ? (
        <span id={hint} className="text-zinc-500 tabular-nums md:text-right dark:text-zinc-400">
          {AMOUNT_HINT}
        </span>
      ) : null}
    </label>
  );
}

function SyncStatus({
  product,
  timezone,
  disabled,
  canSend,
  onRetry,
}: {
  product: CatalogProductView;
  timezone: string;
  disabled: boolean;
  canSend: boolean;
  onRetry: () => void;
}) {
  const { sync } = product;
  if (sync.status === "synced") {
    return (
      <p className="text-sm">
        <span className="text-accepted">In PayPal Catalog</span>
        {sync.syncedAt ? (
          <span className={SECONDARY_TEXT}>
            , sent{" "}
            {new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: timezone }).format(
              new Date(sync.syncedAt),
            )}
          </span>
        ) : null}
        <span className={`mt-0.5 block break-all text-xs tabular-nums ${SECONDARY_TEXT}`}>
          {sync.paypalProductId}
        </span>
      </p>
    );
  }
  if (product.status === "unpublished") {
    return <p className={`text-sm ${SECONDARY_TEXT}`}>Not sent to PayPal Catalog</p>;
  }
  if (sync.status === "pending") {
    return <p className={`text-sm ${SECONDARY_TEXT}`}>Waiting to go to PayPal Catalog</p>;
  }
  if (sync.status === "not_configured") {
    return <p className="text-sm text-doubt">PayPal Catalog is not connected</p>;
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm">
        <span className="text-blocked">Not in PayPal Catalog.</span>{" "}
        <span className={SECONDARY_TEXT}>
          {canSend ? sync.problem : "It can be sent once the shop is connected to PayPal."}
        </span>
      </p>
      {/* Without a connection a retry could only end as not connected, so the note above the
          list says what to do instead. */}
      {canSend ? (
        <button
          type="button"
          disabled={disabled}
          aria-label={`Try again: ${product.title}`}
          onClick={onRetry}
          className={quietButton}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

function ProductRow({
  product,
  currency,
  timezone,
  withDeposit,
  busy,
  canSend,
  onSave,
  onRetry,
}: {
  product: CatalogProductView;
  currency: string;
  timezone: string;
  withDeposit: boolean;
  busy: boolean;
  canSend: boolean;
  onSave: (patch: CatalogProductPatch) => Promise<void>;
  onRetry: () => void;
}) {
  const [refused, setRefused] = useState<{ patch: CatalogProductPatch; message: string } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [stockState, setStockState] = useState<StockControlViewState>({
    status: "loading",
  });
  const onSale = product.status === "published";
  const length =
    product.serviceDurationMinutes === null
      ? "length not set"
      : `${product.serviceDurationMinutes} minutes`;
  const productSubtitle =
    product.kind === "service"
      ? `Service, ${length}${onSale ? ", on sale" : ", not on sale"}`
      : onSale
        ? `Product · ${formatSellerProductStockSummary("available", stockState)}`
        : "Product, not on sale";

  async function save(patch: CatalogProductPatch, savedWords: string | null = null) {
    setRefused(null);
    setSaved(null);
    try {
      await onSave(patch);
      setSaved(savedWords);
    } catch (error) {
      setRefused({
        patch,
        message: error instanceof Error ? error.message : "That change did not save. Try again.",
      });
    }
  }

  return (
    <li
      className={`grid gap-3 border-b border-zinc-200 py-4 md:py-3 dark:border-zinc-800 ${
        withDeposit ? COLUMNS.withDeposit : COLUMNS.priceOnly
      }`}
    >
      <div className="min-w-0 md:pt-1.5">
        <p className={`break-words ${onSale ? "font-medium" : SECONDARY_TEXT}`}>{product.title}</p>
        <p className={`text-sm ${SECONDARY_TEXT}`}>{productSubtitle}</p>
        {product.description ? (
          <p className={`mt-1 break-words text-sm ${SECONDARY_TEXT}`}>{product.description}</p>
        ) : null}
        {product.descriptionLv ? (
          <p lang="lv" className={`mt-1 break-words text-sm ${SECONDARY_TEXT}`}>
            {product.descriptionLv}
          </p>
        ) : null}
      </div>
      {/* What happened to a typed amount sits right under the fields, not under the tallest cell. */}
      <div
        className={`grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-subgrid ${
          withDeposit ? "md:col-span-2" : "md:col-span-1"
        }`}
      >
        <AmountField
          label="Price"
          product={product.title}
          value={product.price}
          currency={currency}
          disabled={busy}
          invalid={refused?.patch.price !== undefined}
          onCommit={(text) => save({ price: text }, "Price saved")}
        />
        {product.kind === "service" ? (
          <AmountField
            label="Deposit"
            product={product.title}
            value={product.deposit}
            currency={currency}
            disabled={busy}
            invalid={refused?.patch.deposit !== undefined}
            onCommit={(text) => save({ deposit: text }, "Deposit saved")}
          />
        ) : null}
        {refused ? (
          <p role="alert" className="col-span-full text-sm text-blocked">
            {refused.message}
          </p>
        ) : null}
        <p role="status" className="col-span-full text-sm text-accepted empty:hidden">
          {saved}
        </p>
      </div>
      <div className="min-w-0 md:pt-2">
        <SyncStatus
          product={product}
          timezone={timezone}
          disabled={busy}
          canSend={canSend}
          onRetry={onRetry}
        />
      </div>
      <div className="md:justify-self-end">
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
      {product.kind === "product" ? (
        <div className="md:col-span-full">
          <ProductStockControl
            productId={product.id}
            onStateChange={setStockState}
          />
        </div>
      ) : null}
    </li>
  );
}

export function CatalogManager({
  initial,
  timezone,
  canSendAtStart,
}: {
  initial: CatalogView;
  timezone: string;
  // The server's answer, by the rule sending itself follows, to whether anything can go now.
  canSendAtStart: boolean;
}) {
  const [view, setView] = useState(initial);
  const [canSend, setCanSend] = useState(canSendAtStart);
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
    async (first: SendRequest = {}) => {
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
        if (connectionLost(answer.view, first)) {
          setCanSend(false);
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
  const withDeposit = view.products.some((product) => product.kind === "service");
  const columns = withDeposit ? COLUMNS.withDeposit : COLUMNS.priceOnly;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-medium text-balance">Your catalog</h1>
        <p aria-live="polite" className={`tabular-nums ${SECONDARY_TEXT}`}>
          {plural(published, "product")} on sale
          {unpublished > 0 ? `, ${unpublished} unpublished` : ""}
          {/* Without a connection the waiting ones are only marked not connected, so nothing is sent. */}
          {sending === "all" && waiting > 0 && canSend ? `. Sending to PayPal Catalog, ${waiting} left` : ""}
        </p>
        <p className={`max-w-prose text-sm ${SECONDARY_TEXT}`}>
          Buyers&apos; assistants read prices and what is on sale from here. A PayPal Catalog record is
          only a reference with a name and a description, and it does not list your product in PayPal
          Store Sync, Agent Ready or any other shopping search. PayPal cannot delete a record, so
          unpublishing stops sales here and leaves the record where it is.
        </p>
      </header>

      <div className="flex flex-col items-start gap-3 empty:hidden">
        {/* Sending is offered only when it can work, since otherwise it could only mark the same
            products not connected again. The page says what would let them go instead. */}
        {unsent > 0 && !canSend ? (
          <p className="max-w-prose border-l-4 border-doubt pl-4">
            This shop has no working PayPal connection, so nothing can go to PayPal Catalog yet.
            Buyers can still find your products. To send them,{" "}
            <Link href="/seller/paypal-connection" className="underline underline-offset-4">
              connect PayPal Sandbox
            </Link>{" "}
            from the shop owner&apos;s account, then come back here.
          </p>
        ) : null}

        {unsent > 0 && canSend && !working ? (
          <button type="button" onClick={() => send({ retryFailed: true })} className={mainButton}>
            Send {plural(unsent, "product")} to PayPal Catalog
          </button>
        ) : null}

        {problem ? (
          <p role="alert" className="max-w-prose text-sm text-blocked">
            {problem}
          </p>
        ) : null}
      </div>

      {view.products.length === 0 ? (
        <p className={SECONDARY_TEXT}>
          Nothing here yet.{" "}
          <Link href="/seller/imports" className="underline underline-offset-4">
            Upload a price list
          </Link>{" "}
          to fill your catalog.
        </p>
      ) : (
        <div>
          {/* Each field names itself for a screen reader, so this heading is only for the eye. */}
          <div
            aria-hidden="true"
            className={`hidden border-b border-zinc-200 pb-2 text-xs md:grid dark:border-zinc-800 ${SECONDARY_TEXT} ${columns}`}
          >
            <span>Product</span>
            <span className="text-right">Price in {view.shopCurrency}</span>
            {withDeposit ? <span className="text-right">Deposit in {view.shopCurrency}</span> : null}
            <span>PayPal Catalog</span>
          </div>
          <ul className="flex flex-col max-md:border-t max-md:border-zinc-200 max-md:dark:border-zinc-800">
            {view.products.map((product) => (
              <ProductRow
                key={product.id}
                product={product}
                currency={view.shopCurrency}
                timezone={timezone}
                withDeposit={withDeposit}
                busy={working}
                canSend={canSend}
                onSave={(patch) => saveProduct(product.id, patch)}
                onRetry={() => void send({ productId: product.id })}
              />
            ))}
          </ul>
        </div>
      )}

      {view.truncated ? (
        <p className={`text-sm tabular-nums ${SECONDARY_TEXT}`}>
          Showing the first {view.products.length} products by name
        </p>
      ) : null}
    </div>
  );
}
