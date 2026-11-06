"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ImportRowPatch, ImportRowView, ImportView } from "@/server/contracts/imports";

import { RequestFailed, request } from "./request";
import { RowEditor } from "./row-editor";

const POLL_MS = 2500;

const isWaiting = (view: ImportView) => view.status === "queued" || view.status === "running";

const hasNoIssues = (row: ImportRowView) => row.issues.length === 0;

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function summary(view: ImportView): string {
  const { total, removed, accepted, pending, blocked } = view.counts;
  const live = total - removed;
  const parts = [plural(live, "row")];
  if (accepted > 0) {
    parts.push(`${accepted} accepted`);
  }
  if (blocked > 0) {
    parts.push(`${blocked} to fix`);
  }
  if (pending - blocked > 0) {
    parts.push(`${pending - blocked} to accept`);
  }
  return parts.join(", ");
}

function SourcePhoto({ view }: { view: ImportView }) {
  const url = `/api/seller/imports/${view.id}/source`;
  const reading = isWaiting(view);
  return (
    <figure className="flex flex-col gap-2 lg:sticky lg:top-4">
      <div className="relative overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
        {/* The photo comes from a route that needs the seller's cookie, which the image optimizer would not send. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={`Your upload, ${view.sourceName}`}
          className="max-h-[50vh] w-full object-contain lg:max-h-[85vh]"
        />
        {reading ? <div className="reading-line" /> : null}
      </div>
      <figcaption className="text-sm text-zinc-600 dark:text-zinc-400">
        <a href={url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
          Open full size
        </a>
      </figcaption>
    </figure>
  );
}

function WaitingNotice({ view }: { view: ImportView }) {
  return (
    <div aria-live="polite" className="flex flex-col gap-2">
      <h2 className="text-xl font-semibold tracking-tight">
        {view.status === "running" ? "Reading your photo" : "Your photo is next in line"}
      </h2>
      <p className="max-w-prose text-zinc-600 dark:text-zinc-400">
        This usually takes under a minute. You can leave this page and come back. Your rows will be
        waiting here.
      </p>
    </div>
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
  const clean = view.rows.filter((row) => row.status === "pending" && hasNoIssues(row)).length;
  const reviewing = view.status === "needs_review";
  const finished = view.status === "completed";
  const canFinish = reviewing && view.counts.pending === 0 && view.counts.accepted > 0;
  const working = busy !== null || suggesting !== null;

  const showTable = reviewing || finished;

  return (
    <div
      className={`mx-auto grid w-full gap-6 px-4 py-6 sm:px-6 ${
        view.hasSource ? "max-w-[96rem] lg:grid-cols-[minmax(18rem,1fr)_3fr]" : "max-w-7xl"
      }`}
    >
      {view.hasSource ? (
        <aside>
          <SourcePhoto view={view} />
        </aside>
      ) : null}

      <div className="flex min-w-0 flex-col gap-5">
        <header className="flex flex-col gap-1">
          <Link
            href="/seller/imports"
            className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
          >
            Your uploads
          </Link>
          <h1 className="break-words text-2xl font-semibold tracking-tight sm:text-3xl">
            {view.sourceName}
          </h1>
          {showTable ? (
            <p aria-live="polite" className="text-zinc-600 dark:text-zinc-400">
              {summary(view)}
            </p>
          ) : null}
        </header>

        {waiting ? <WaitingNotice view={view} /> : null}

        {view.status === "failed" && view.error ? (
          <div role="alert" className="flex flex-col items-start gap-3 border-l-4 border-blocked pl-4">
            <p className="max-w-prose">{view.error.message}</p>
            <div className="flex flex-wrap items-center gap-4">
              {view.error.retryable ? (
                <button
                  type="button"
                  disabled={working}
                  onClick={() => act("retry", () => post("retry"))}
                  className="rounded-md bg-ink px-4 py-2 font-medium text-white disabled:opacity-60 dark:text-zinc-950"
                >
                  Try again
                </button>
              ) : null}
              <Link href="/seller/imports" className="underline underline-offset-4">
                Upload another file
              </Link>
            </div>
          </div>
        ) : null}

        {finished ? (
          <p className="max-w-prose border-l-4 border-accepted pl-4">
            Review finished. {plural(view.counts.accepted, "row is", "rows are")} ready for your
            catalog. Nothing has been published yet.
          </p>
        ) : null}

        {view.ignoredColumns.length > 0 && reviewing ? (
          <p className="max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
            Not used from your file: {view.ignoredColumns.join(", ")}.
          </p>
        ) : null}

        {reviewing ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {noCurrency > 0 ? (
                <button
                  type="button"
                  disabled={working}
                  onClick={() => act("currency", () => post("bulk", { action: "set_missing_currency" }))}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  Use {view.shopCurrency} for {plural(noCurrency, "row")} with no currency
                </button>
              ) : null}
              {clean > 0 ? (
                <button
                  type="button"
                  disabled={working}
                  onClick={() => act("accept", () => post("bulk", { action: "accept_clean" }))}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  Accept {plural(clean, "row")} with no problems
                </button>
              ) : null}
              {canSuggest && unwritten > 0 ? (
                <button
                  type="button"
                  disabled={working}
                  onClick={suggest}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  {suggesting !== null
                    ? "Writing descriptions"
                    : "Suggest descriptions in English and Latvian"}
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={!canFinish || working}
                onClick={() => act("finish", () => post("finish"))}
                className="rounded-md bg-ink px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600 dark:text-zinc-950 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-400"
              >
                Finish review
              </button>
              {!canFinish ? (
                <span className="text-sm text-zinc-600 dark:text-zinc-400">
                  {view.counts.pending > 0
                    ? `Accept or remove ${plural(view.counts.pending, "more row")} to finish.`
                    : "Accept at least one row to finish."}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {problem ? (
          <p role="alert" className="max-w-prose text-sm text-blocked">
            {problem}
          </p>
        ) : null}

        {showTable ? (
          <fieldset disabled={finished} className="min-w-0">
            <legend className="sr-only">Rows from your upload</legend>
            <table className="block w-full md:table md:border-collapse">
              <thead className="sr-only md:not-sr-only">
                <tr className="text-left text-sm text-zinc-600 dark:text-zinc-400">
                  <th scope="col" className="w-[34%] py-2 pl-3 pr-2 font-medium">Name</th>
                  <th scope="col" className="w-[12%] px-2 py-2 font-medium">Kind</th>
                  <th scope="col" className="w-[22%] px-2 py-2 font-medium">Price</th>
                  <th scope="col" className="w-[18%] px-2 py-2 font-medium">Booking</th>
                  <th scope="col" className="w-[14%] py-2 pl-2 pr-1 font-medium">Decision</th>
                </tr>
              </thead>
              <tbody className="block md:table-row-group">
                {view.rows.map((row) => (
                  <RowEditor
                    key={row.id}
                    row={row}
                    shopCurrency={view.shopCurrency}
                    readOnly={finished}
                    onSave={saveRow}
                  />
                ))}
              </tbody>
            </table>
          </fieldset>
        ) : null}

        {view.model && showTable ? (
          <p className="text-xs text-zinc-500">
            Read by {view.model}, prompt {view.promptVersion}.
          </p>
        ) : null}
      </div>
    </div>
  );
}
