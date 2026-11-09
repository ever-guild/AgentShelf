"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ImportRowPatch, ImportRowView, ImportView } from "@/server/contracts/imports";

import { ImportProgress, stepStates } from "../../import-steps";
import { RequestFailed, request } from "./request";
import { RowEditor } from "./row-editor";

const POLL_MS = 2500;

const SECONDARY_TEXT = "text-zinc-600 dark:text-zinc-400";
const PRIMARY_ACTION =
  "inline-flex min-h-11 flex-none items-center rounded-lg bg-ink px-4 py-2 font-medium text-background transition-[background-color,transform] hover:bg-ink/90 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60";
const BULK_ACTION =
  "inline-flex min-h-11 items-center rounded-lg border border-zinc-300 px-3 py-2 text-left text-sm font-medium transition-colors enabled:hover:bg-zinc-100 disabled:opacity-60 sm:min-h-9 sm:py-1.5 dark:border-zinc-700 dark:enabled:hover:bg-zinc-800";

const isWaiting = (view: ImportView) => view.status === "queued" || view.status === "running";

const isBlocked = (row: ImportRowView) => row.issues.some((issue) => issue.severity === "blocker");

const sourceUrl = (view: ImportView) => `/api/seller/imports/${view.id}/source`;

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function summary(view: ImportView): string {
  const { total, removed, accepted, blocked } = view.counts;
  // A published row leaves the review, so a list published in full has only its removed rows left.
  if (total > 0 && total === removed) {
    return `${plural(removed, "row")} removed`;
  }
  const parts = [plural(total - removed, "row")];
  if (view.status === "completed") {
    // Every live row of a finished review is accepted, the ones that cannot be published among them.
    if (accepted - blocked > 0) {
      parts.push(`${accepted - blocked} ready to publish`);
    }
    if (blocked > 0) {
      parts.push(`${blocked} cannot be published`);
    }
  } else {
    const pending = view.rows.filter((row) => row.status === "pending" && !isBlocked(row));
    const toCheck = pending.filter((row) => row.issues.length > 0).length;
    if (accepted > 0) {
      parts.push(`${accepted} accepted`);
    }
    if (blocked > 0) {
      parts.push(`${blocked} to fix`);
    }
    if (toCheck > 0) {
      parts.push(`${toCheck} to check`);
    }
    if (pending.length - toCheck > 0) {
      parts.push(`${pending.length - toCheck} to accept`);
    }
  }
  if (removed > 0) {
    parts.push(`${removed} removed`);
  }
  return parts.join(", ");
}

// The page's title says where the seller stands. The file's name sits above it, as where they are.
function title(view: ImportView, publishable: number): string {
  switch (view.status) {
    case "queued":
      return "Your photo is next in line";
    case "running":
      return "Reading your photo";
    case "needs_review":
      return "Check your price list";
    case "failed":
      return view.sourceKind === "photo" ? "This photo could not be read" : "This file could not be read";
    case "completed":
      return view.publishedCount > 0 && publishable === 0 ? "Published" : "Review finished";
  }
}

function lead(view: ImportView): string | null {
  if (isWaiting(view)) {
    return "This usually takes under a minute. You can leave this page and come back. Your rows will be waiting here.";
  }
  if (view.status !== "needs_review") {
    return null;
  }
  return view.sourceKind === "photo"
    ? "Compare each row with your photo. Words in blue are what your list says."
    : "Check each row before anything goes into your catalog. Words in blue are what your file says.";
}

// The seller's own photo, laid beside the table like the original beside its carbon copy. It stays
// in view while the rows scroll past it.
function SourcePhoto({ view }: { view: ImportView }) {
  const url = sourceUrl(view);
  return (
    <figure className="flex flex-col gap-2 lg:sticky lg:top-4">
      <div className="relative overflow-hidden rounded-sm bg-zinc-100 shadow-[0_1px_2px_rgb(9_9_11/0.12),0_16px_40px_-12px_rgb(9_9_11/0.28)] ring-1 ring-zinc-950/10 dark:bg-zinc-900 dark:shadow-none dark:ring-white/10">
        {/* The photo comes from a route that needs the seller's cookie, which the image optimizer would not send. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={`Your upload, ${view.sourceName}`}
          className="max-h-[60vh] w-full object-contain lg:max-h-[calc(100dvh-4rem)]"
        />
        {/* The line means the photo is being read right now, so one still waiting its turn stays still. */}
        {view.status === "running" ? <div className="reading-line" /> : null}
      </div>
      <figcaption className={`flex items-center justify-between gap-4 text-sm ${SECONDARY_TEXT}`}>
        Your photo
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 items-center underline underline-offset-4 transition-colors hover:text-foreground lg:min-h-0"
        >
          Open full size
        </a>
      </figcaption>
    </figure>
  );
}

// On a phone the photo has scrolled away long before the last row, so a small one stays at hand.
function PhotoAtHand({ view }: { view: ImportView }) {
  const url = sourceUrl(view);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="block size-11 flex-none overflow-hidden rounded-sm ring-1 ring-zinc-950/10 lg:hidden dark:ring-white/10"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="Open your photo full size" className="size-full object-cover" />
    </a>
  );
}

export function ImportReview({
  initial,
  canSuggest,
}: {
  initial: ImportView;
  canSuggest: boolean;
}) {
  const [view, setView] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState<number | null>(null);
  const latest = useRef(0);
  const router = useRouter();

  const path = `/api/seller/imports/${view.id}`;

  // A session that ended mid-review goes back to signing in, wherever it was noticed.
  const call = useCallback(
    async <T,>(url: string, init?: RequestInit): Promise<T> => {
      try {
        return await request<T>(url, init);
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
  const apply = useCallback(async (work: () => Promise<ImportView>) => {
    latest.current += 1;
    const id = latest.current;
    const next = await work();
    if (id === latest.current) {
      setView(next);
    }
    return next;
  }, []);

  const waiting = isWaiting(view);
  useEffect(() => {
    if (!waiting) {
      return;
    }
    const timer = setInterval(() => {
      void call<ImportView>(path)
        .then(setView)
        .catch(() => {
          // The next poll tries again, and the page says nothing about a passing network problem.
        });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, path, call]);

  async function act(name: string, work: () => Promise<ImportView>) {
    setBusy(name);
    setProblem(null);
    try {
      await apply(work);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Something went wrong. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const post = (suffix: string, body?: unknown) =>
    call<ImportView>(`${path}/${suffix}`, {
      method: "POST",
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });

  const saveRow = useCallback(
    (rowId: string, patch: ImportRowPatch) =>
      apply(() =>
        call<ImportView>(`${path}/rows/${rowId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        }),
      ),
    [apply, call, path],
  );

  async function suggest() {
    setProblem(null);
    setSuggesting(0);
    try {
      // A batch that leaves the count where it was has nothing more to offer.
      let previous = Number.POSITIVE_INFINITY;
      for (;;) {
        const answer = await call<{ view: ImportView; remaining: number }>(`${path}/suggestions`, {
          method: "POST",
        });
        setView(answer.view);
        setSuggesting(answer.remaining);
        if (answer.remaining === 0 || answer.remaining >= previous) {
          break;
        }
        previous = answer.remaining;
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Something went wrong. Try again.");
    } finally {
      setSuggesting(null);
    }
  }

  const live = view.rows.filter((row) => row.status !== "removed");
  const noCurrency = live.filter((row) => row.currency === null).length;
  const unwritten = live.filter(
    (row) =>
      row.title !== null &&
      row.descriptionEn === null &&
      row.descriptionLv === null &&
      !row.issues.some((issue) => issue.code === "suggestion_rejected"),
  ).length;
  const clean = view.rows.filter((row) => row.status === "pending" && row.issues.length === 0).length;
  const reviewing = view.status === "needs_review";
  const finished = view.status === "completed";
  const canFinish = reviewing && view.counts.pending === 0 && view.counts.accepted > 0;
  const working = busy !== null || suggesting !== null;

  // Every live row of a finished review is accepted, and a draft is gone once it is published.
  const publishable = finished ? view.counts.accepted - view.counts.blocked : 0;
  const showTable = reviewing || (finished && view.rows.length > 0);
  const leadText = lead(view);
  // Without a photo there is no first column, and naming the second one would make an empty one.
  const besidePhoto = view.hasSource ? "lg:col-start-2" : "";
  const finishHint = canFinish
    ? "Finishing closes this review. You publish after that."
    : view.counts.pending > 0
      ? `Accept or remove ${plural(view.counts.pending, "more row")} to finish`
      : "Accept at least one row to finish";
  const problemNote = problem ? (
    <p role="alert" className="max-w-prose text-sm text-blocked">
      {problem}
    </p>
  ) : null;

  // Beside the table the photo gives up some width so a name fits in its field. With no table, while
  // the photo is read or when it could not be, the photo takes half the page.
  const columns = showTable
    ? "lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]"
    : "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]";

  return (
    <div
      className={`mx-auto grid w-full gap-6 px-4 py-8 sm:px-6 ${
        view.hasSource ? `max-w-[96rem] lg:grid-rows-[auto_1fr] ${columns}` : "max-w-7xl"
      }`}
    >
      <header className={`flex min-w-0 flex-col gap-2 ${besidePhoto}`}>
        <p className={`text-sm wrap-anywhere ${SECONDARY_TEXT}`}>
          <Link
            href="/seller/imports"
            className="underline underline-offset-4 transition-colors hover:text-foreground"
          >
            Your uploads
          </Link>
          <span aria-hidden="true"> / </span>
          {view.sourceName}
        </p>
        {view.status !== "failed" ? (
          <div className="py-2">
            <ImportProgress states={stepStates(view.status, view.publishedCount, publishable)} />
          </div>
        ) : null}
        <div aria-live="polite" className="flex flex-col gap-2">
          <h1 className="text-3xl font-medium text-balance">
            {title(view, publishable)}
          </h1>
          {leadText ? <p className={`max-w-prose ${SECONDARY_TEXT}`}>{leadText}</p> : null}
        </div>
      </header>

      {view.hasSource ? (
        <aside className="min-w-0 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <SourcePhoto view={view} />
        </aside>
      ) : null}

      <div className={`flex min-w-0 flex-col gap-6 ${besidePhoto}`}>
        {view.status === "failed" && view.error ? (
          <div role="alert" className="flex flex-col items-start gap-4">
            <p className="max-w-prose">{view.error.message}</p>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              {view.error.retryable ? (
                <button
                  type="button"
                  disabled={working}
                  onClick={() => act("retry", () => post("retry"))}
                  className={PRIMARY_ACTION}
                >
                  Try again
                </button>
              ) : null}
              <Link
                href="/seller/imports"
                className={
                  view.error.retryable
                    ? `inline-flex min-h-11 items-center underline underline-offset-4 transition-colors hover:text-foreground ${SECONDARY_TEXT}`
                    : PRIMARY_ACTION
                }
              >
                Upload another file
              </Link>
            </div>
          </div>
        ) : null}

        {finished && view.publishedCount > 0 ? (
          <p className="max-w-prose">
            {plural(view.publishedCount, "product")} from this list{" "}
            {view.publishedCount === 1 ? "is" : "are"} published, and buyers&apos; assistants can find{" "}
            {view.publishedCount === 1 ? "it" : "them"}.{" "}
            <Link
              href="/seller/catalog"
              className="underline underline-offset-4 transition-colors hover:text-foreground"
            >
              Open your catalog
            </Link>
          </p>
        ) : null}

        {finished && publishable > 0 ? (
          <div className="flex flex-col items-start gap-4">
            <p className="max-w-prose">
              {plural(publishable, "row is", "rows are")} ready for your catalog. Nothing is on sale
              until you publish.
            </p>
            <button
              type="button"
              disabled={working}
              onClick={() =>
                act("publish", async () => {
                  const next = await post("publish");
                  if (next.counts.accepted === 0) {
                    router.push("/seller/catalog");
                  }
                  return next;
                })
              }
              className={PRIMARY_ACTION}
            >
              {busy === "publish" ? "Publishing" : `Publish ${plural(publishable, "product")}`}
            </button>
          </div>
        ) : null}

        {finished && view.counts.blocked > 0 ? (
          <p role="status" className="max-w-prose text-blocked">
            {plural(view.counts.blocked, "row")} cannot be published, for the{" "}
            {view.counts.blocked === 1 ? "reason shown under it" : "reasons shown under each one"}.
            This review is closed, so add {view.counts.blocked === 1 ? "it" : "them"} to a new upload.
          </p>
        ) : null}

        {view.ignoredColumns.length > 0 && reviewing ? (
          <p className={`max-w-prose text-sm ${SECONDARY_TEXT}`}>
            Not used from your file: <span className="text-ink">{view.ignoredColumns.join(", ")}</span>
          </p>
        ) : null}

        {reviewing && (noCurrency > 0 || clean > 0 || (canSuggest && unwritten > 0)) ? (
          <div className="flex flex-wrap items-center gap-2">
            {noCurrency > 0 ? (
              <button
                type="button"
                disabled={working}
                onClick={() => act("currency", () => post("bulk", { action: "set_missing_currency" }))}
                className={BULK_ACTION}
              >
                Use {view.shopCurrency} for {plural(noCurrency, "row")} with no currency
              </button>
            ) : null}
            {clean > 0 ? (
              <button
                type="button"
                disabled={working}
                onClick={() => act("accept", () => post("bulk", { action: "accept_clean" }))}
                className={BULK_ACTION}
              >
                Accept {plural(clean, "row")} with no problems
              </button>
            ) : null}
            {canSuggest && unwritten > 0 ? (
              <button type="button" disabled={working} onClick={suggest} className={BULK_ACTION}>
                {suggesting !== null ? "Writing descriptions" : "Suggest descriptions in English and Latvian"}
              </button>
            ) : null}
          </div>
        ) : null}

        {reviewing ? null : problemNote}

        {showTable ? (
          <div className="flex min-w-0 flex-col">
            {reviewing ? (
              <p className={`pb-3 text-sm sm:hidden ${SECONDARY_TEXT}`}>{finishHint}</p>
            ) : null}
            {/* The running count and the way out stay in view, however long the list is. */}
            <div
              className={`flex items-center gap-3 border-b border-zinc-200 bg-background pb-3 dark:border-zinc-800 ${
                reviewing ? "sticky top-0 z-10 -mx-4 px-4 pt-3 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0" : ""
              }`}
            >
              {reviewing && view.hasSource ? <PhotoAtHand view={view} /> : null}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p aria-live="polite" className="text-xs font-medium tabular-nums sm:text-sm">
                  {summary(view)}
                </p>
                {reviewing ? (
                  <p className={`hidden text-sm sm:block ${SECONDARY_TEXT}`}>{finishHint}</p>
                ) : null}
                {reviewing ? problemNote : null}
              </div>
              {reviewing ? (
                <button
                  type="button"
                  disabled={!canFinish || working}
                  onClick={() => act("finish", () => post("finish"))}
                  className={`${PRIMARY_ACTION} px-3 text-sm disabled:cursor-not-allowed sm:px-4 sm:text-base ${
                    canFinish
                      ? ""
                      : "disabled:bg-zinc-200 disabled:text-zinc-600 disabled:opacity-100 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-400"
                  }`}
                >
                  Finish review
                </button>
              ) : null}
            </div>

            <div className="@container">
              <fieldset disabled={finished} className="min-w-0">
                <legend className="sr-only">Rows from your upload</legend>
                <table className="block w-full @[42rem]:table @[42rem]:table-fixed @[42rem]:border-collapse">
                  <thead className="sr-only @[42rem]:not-sr-only">
                    <tr className={`border-b border-zinc-200 text-left text-xs dark:border-zinc-800 ${SECONDARY_TEXT}`}>
                      <th scope="col" className="py-2 pr-2 pl-3 font-medium">Name</th>
                      <th scope="col" className="w-26 px-2 py-2 font-medium">Kind</th>
                      <th scope="col" className="w-40 px-2 py-2 font-medium">Price</th>
                      <th scope="col" className="w-32 px-2 py-2 font-medium">Booking</th>
                      <th scope="col" className="w-28 py-2 pr-1 pl-2 font-medium">Decision</th>
                    </tr>
                  </thead>
                  {view.rows.map((row) => (
                    <RowEditor
                      key={row.id}
                      row={row}
                      shopCurrency={view.shopCurrency}
                      readOnly={finished}
                      onSave={saveRow}
                    />
                  ))}
                </table>
              </fieldset>
            </div>
          </div>
        ) : null}

        {view.model && showTable ? (
          <p className={`text-xs ${SECONDARY_TEXT}`}>
            Read by {view.model}, prompt {view.promptVersion}
          </p>
        ) : null}
      </div>
    </div>
  );
}
