"use client";

import { useId, useState, type ReactNode } from "react";

import type { ImportRowPatch, ImportRowView, ImportView } from "@/server/contracts/imports";
import type { RowField } from "@/server/imports/draft-rows";

import { AMOUNT_HINT } from "../../amount-hint";
import { RequestFailed } from "./request";

const SECONDARY_TEXT = "text-zinc-600 dark:text-zinc-400";
const MUTED_TEXT = "text-zinc-500 dark:text-zinc-400";

// `@[42rem]` is the width at which five columns fit. It follows the table's own width and not the
// window's, because the photo beside the table takes its share. Below it a row is a small grid.
const fieldChrome =
  "min-w-0 rounded-lg border border-zinc-300 bg-transparent px-2 text-base transition-colors enabled:hover:border-zinc-400 disabled:border-transparent disabled:px-0 disabled:opacity-100 @[42rem]:text-sm dark:border-zinc-700 dark:enabled:hover:border-zinc-600";
const controlClass = `${fieldChrome} h-11 disabled:appearance-none @[42rem]:h-9`;
const quietAction =
  "inline-flex min-h-11 items-center underline underline-offset-4 transition-colors hover:text-foreground @[42rem]:min-h-6";

// A row's left edge says where it stands, so a long table can be scanned for what still needs work.
// The words are in the decision column and under the row, so the color is never the only signal.
function edgeClass(row: ImportRowView): string {
  if (row.status === "removed") {
    return "border-l-zinc-200 dark:border-l-zinc-800";
  }
  if (row.issues.some((issue) => issue.severity === "blocker")) {
    return "border-l-blocked";
  }
  if (row.status === "accepted") {
    return "border-l-accepted";
  }
  if (row.issues.length > 0) {
    return "border-l-doubt";
  }
  return "border-l-zinc-300 dark:border-l-zinc-700";
}

// In the small grid each cell carries its own label, since the table head is hidden.
function Cell({
  label,
  children,
  className = "",
}: {
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <td className={`min-w-0 align-top @[42rem]:table-cell @[42rem]:px-2 @[42rem]:py-3 ${className}`}>
      {label ? (
        <span className={`mb-1 block text-xs @[42rem]:hidden ${SECONDARY_TEXT}`}>{label}</span>
      ) : null}
      {children}
    </td>
  );
}

// The field's text comes from the server, and its key follows that text. A saved value that the
// server rewrote, such as 12,5 to 12.50, replaces what was typed. A refused one stays for correcting.
function TextField({
  label,
  value,
  onCommit,
  inputMode,
  describedBy,
  className = "",
}: {
  label: string;
  value: string | null;
  onCommit: (text: string) => void;
  inputMode?: "decimal" | "numeric";
  describedBy?: string;
  className?: string;
}) {
  const current = value ?? "";
  return (
    <input
      key={current}
      aria-label={label}
      aria-describedby={describedBy}
      defaultValue={current}
      inputMode={inputMode}
      className={`w-full ${controlClass} ${className}`}
      onBlur={(event) => {
        if (event.target.value.trim() !== current) {
          onCommit(event.target.value);
        }
      }}
    />
  );
}

function TextArea({
  label,
  value,
  onCommit,
  textColor,
}: {
  label: string;
  value: string | null;
  onCommit: (text: string) => void;
  textColor: string;
}) {
  const current = value ?? "";
  return (
    <label className={`flex flex-col gap-1 text-xs ${SECONDARY_TEXT}`}>
      {label}
      <textarea
        key={current}
        defaultValue={current}
        rows={2}
        className={`w-full py-1.5 disabled:resize-none ${fieldChrome} ${textColor}`}
        onBlur={(event) => {
          if (event.target.value.trim() !== current) {
            onCommit(event.target.value);
          }
        }}
      />
    </label>
  );
}

const ISSUE_TEXT = { blocker: "text-blocked", warning: "text-doubt" };

// A price that could not be read comes back quoted at the start of its message, and the quoted words
// are the list's own, so they keep the list's color inside the sentence.
function IssueMessage({ message }: { message: string }) {
  const quoted = /^(".*")( .*)$/.exec(message);
  return quoted ? (
    <>
      <span className="text-ink">{quoted[1]}</span>
      {quoted[2]}
    </>
  ) : (
    message
  );
}

// The fields that show a refused change right under themselves. Any other refusal goes under the row.
const FIELDS_WITH_OWN_NOTE = ["price", "duration", "deposit"];

export function RowEditor({
  row,
  shopCurrency,
  readOnly,
  onSave,
}: {
  row: ImportRowView;
  shopCurrency: string;
  readOnly: boolean;
  onSave: (rowId: string, patch: ImportRowPatch) => Promise<ImportView>;
}) {
  const [refused, setRefused] = useState<{ field: string | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const hintId = useId();

  async function save(patch: ImportRowPatch) {
    setSaving(true);
    setRefused(null);
    try {
      await onSave(row.id, patch);
    } catch (error) {
      setRefused({
        field: error instanceof RequestFailed ? (error.failure.details?.field ?? null) : null,
        message: error instanceof Error ? error.message : "That change did not save. Try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  const blocked = row.issues.some((issue) => issue.severity === "blocker");
  const removed = row.status === "removed";
  const isService = row.kind === "service";
  const hasSuggestion = Boolean(row.descriptionEn || row.descriptionLv);
  const hasDescription = Boolean(row.description) || hasSuggestion;
  // With no price, the blocker already quotes what the list says.
  const showsPrinted = row.price !== null && row.priceText !== null && row.priceText !== row.price;
  // An empty amount field says what to enter under itself, and a filled one shows it by its value.
  // Nothing inside the field could pass for an amount, and a removed row asks for nothing. A refusal
  // under the field already says what to enter, so the hint gives way to it.
  const asksFor = (field: "price" | "deposit", value: string | null) =>
    !readOnly && !removed && value === null && refused?.field !== field
      ? `${hintId}-${field}`
      : undefined;
  const priceHint = asksFor("price", row.price);
  const depositHint = asksFor("deposit", row.deposit);
  const fieldNote = (field: RowField) =>
    refused?.field === field ? (
      <p role="alert" className="mt-1 text-xs text-blocked">
        {refused.message}
      </p>
    ) : null;
  const refusedUnderRow = refused && !FIELDS_WITH_OWN_NOTE.includes(refused.field ?? "");
  const edge = edgeClass(row);
  const rowClass = `contents @[42rem]:table-row @[42rem]:border-l-2 ${edge}`;

  return (
    <tbody
      className={`grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-2 gap-y-3 border-b border-l-2 border-b-zinc-200 p-3 transition-colors focus-within:bg-zinc-50 @[42rem]:table-row-group @[42rem]:border-l-0 @[42rem]:p-0 dark:border-b-zinc-800 dark:focus-within:bg-zinc-900 ${edge} ${removed ? MUTED_TEXT : ""}`}
    >
      <tr className={rowClass}>
        <Cell label="Name" className="col-span-2 @[42rem]:pl-3">
          {/* A disabled field cannot scroll, so a closed review shows the whole name as text. */}
          {readOnly ? (
            <p
              className={`flex min-h-11 items-center text-base wrap-anywhere @[42rem]:min-h-9 @[42rem]:text-sm ${
                removed ? "line-through" : ""
              } ${row.title ? "" : MUTED_TEXT}`}
            >
              {row.title ?? "No name"}
            </p>
          ) : (
            <TextField
              label={`Name, ${row.sourceRef}`}
              value={row.title}
              className={removed ? "line-through" : ""}
              onCommit={(text) => save({ title: text })}
            />
          )}
          <p className={`mt-1 text-xs ${MUTED_TEXT}`}>{row.sourceRef}</p>
        </Cell>
        <Cell label="Kind">
          <select
            key={row.kind ?? ""}
            aria-label={`Kind, ${row.sourceRef}`}
            defaultValue={row.kind ?? ""}
            className={`w-full ${controlClass}`}
            onChange={(event) =>
              save({ kind: event.target.value === "" ? null : (event.target.value as "product" | "service") })
            }
          >
            <option value="">Choose</option>
            <option value="product">Product</option>
            <option value="service">Service</option>
          </select>
        </Cell>
        <Cell label="Price">
          <div className="flex gap-1">
            <div className="min-w-0 flex-1">
              <TextField
                label={`Price, ${row.sourceRef}`}
                value={row.price}
                inputMode="decimal"
                describedBy={priceHint}
                className="tabular-nums"
                onCommit={(text) => save({ price: text })}
              />
            </div>
            <select
              key={row.currency ?? ""}
              aria-label={`Currency, ${row.sourceRef}`}
              defaultValue={row.currency ?? ""}
              className={`w-[5.5rem] flex-none ${controlClass}`}
              onChange={(event) => save({ currency: event.target.value === "" ? null : event.target.value })}
            >
              <option value="">?</option>
              <option value={shopCurrency}>{shopCurrency}</option>
              {row.currency && row.currency !== shopCurrency ? (
                <option value={row.currency}>{row.currency}</option>
              ) : null}
            </select>
          </div>
          {showsPrinted ? (
            <p className={`mt-1 text-xs wrap-anywhere ${SECONDARY_TEXT}`}>
              Your list says <span className="text-sm text-ink tabular-nums">{row.priceText}</span>
            </p>
          ) : null}
          {priceHint ? (
            <p id={priceHint} className={`mt-1 text-xs tabular-nums ${MUTED_TEXT}`}>
              {AMOUNT_HINT}
            </p>
          ) : null}
          {fieldNote("price")}
        </Cell>
        {/* A product has nothing to book, so the small grid leaves this cell out and stays short. */}
        <Cell className={isService ? "col-span-2" : "hidden"}>
          {isService ? (
            <>
              <div className="grid grid-cols-2 gap-2 @[42rem]:grid-cols-1 @[42rem]:gap-1">
                <label className={`flex flex-col gap-1 text-xs @[42rem]:flex-row @[42rem]:items-center ${SECONDARY_TEXT}`}>
                  <span className="flex-none @[42rem]:w-12">Minutes</span>
                  <TextField
                    label={`Minutes, ${row.sourceRef}`}
                    value={row.serviceDurationMinutes === null ? null : String(row.serviceDurationMinutes)}
                    inputMode="numeric"
                    className={`tabular-nums ${removed ? "" : "text-foreground"}`}
                    onCommit={(text) => {
                      const minutes = Number(text.trim());
                      if (text.trim() === "") {
                        void save({ serviceDurationMinutes: null });
                      } else if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 10080) {
                        void save({ serviceDurationMinutes: minutes });
                      } else {
                        setRefused({
                          field: "duration",
                          message: "Enter a whole number of minutes, up to one week.",
                        });
                      }
                    }}
                  />
                </label>
                <div className="flex flex-col gap-1">
                  <label className={`flex flex-col gap-1 text-xs @[42rem]:flex-row @[42rem]:items-center ${SECONDARY_TEXT}`}>
                    <span className="flex-none @[42rem]:w-12">Deposit</span>
                    <TextField
                      label={`Deposit, ${row.sourceRef}`}
                      value={row.deposit}
                      inputMode="decimal"
                      describedBy={depositHint}
                      className={`tabular-nums ${removed ? "" : "text-foreground"}`}
                      onCommit={(text) => save({ deposit: text })}
                    />
                  </label>
                  {/* Under the word Deposit as well on a wide table, where the field alone is too
                      narrow to hold the hint on one line. */}
                  {depositHint ? (
                    <p id={depositHint} className={`text-xs tabular-nums ${MUTED_TEXT}`}>
                      {AMOUNT_HINT}
                    </p>
                  ) : null}
                </div>
              </div>
              {fieldNote("duration")}
              {fieldNote("deposit")}
            </>
          ) : (
            <span className={`inline-flex h-9 items-center text-xs ${MUTED_TEXT}`}>No booking needed</span>
          )}
        </Cell>
        <Cell className="order-2 col-span-2 @[42rem]:order-none @[42rem]:pr-1 @[42rem]:pl-2">
          <div className="flex flex-wrap items-center gap-x-4 text-sm @[42rem]:flex-col @[42rem]:items-start">
            {removed ? <span className={`inline-flex h-11 items-center font-medium @[42rem]:h-9 ${MUTED_TEXT}`}>Removed</span> : null}
            {!removed && blocked ? (
              <span className="inline-flex h-11 items-center font-medium text-blocked @[42rem]:h-9">
                {readOnly ? "Cannot publish" : "To fix"}
              </span>
            ) : null}
            {!removed && !blocked && row.status === "accepted" ? (
              <span className="inline-flex h-11 items-center font-medium text-accepted @[42rem]:h-9">Accepted</span>
            ) : null}
            {/* A column of blue buttons would drown the blue of the list's own words, so a row's
                accept is quiet and the page's one blue action is finishing the review. */}
            {!readOnly && !removed && !blocked && row.status === "pending" ? (
              <button
                type="button"
                disabled={saving}
                onClick={() => save({ status: "accepted" })}
                className="h-11 rounded-lg border border-zinc-300 px-4 font-medium text-foreground transition-[background-color,transform] enabled:hover:bg-zinc-100 enabled:active:scale-[0.98] disabled:opacity-60 @[42rem]:h-9 @[42rem]:px-3 dark:border-zinc-700 dark:enabled:hover:bg-zinc-800"
              >
                Accept
              </button>
            ) : null}
            {readOnly ? null : (
              <div className={`flex gap-x-4 @[42rem]:gap-x-2 @[42rem]:text-xs ${SECONDARY_TEXT}`}>
                {row.status === "accepted" ? (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => save({ status: "pending" })}
                    className={quietAction}
                  >
                    Undo
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => save({ status: removed ? "pending" : "removed" })}
                  className={quietAction}
                >
                  {removed ? "Restore" : "Remove"}
                </button>
              </div>
            )}
          </div>
        </Cell>
      </tr>
      {row.issues.length > 0 || refusedUnderRow ? (
        <tr className={rowClass}>
          {/* Each message names its field, so one full-width line replaces a tall note in a narrow cell. */}
          <td colSpan={5} className="col-span-2 align-top @[42rem]:table-cell @[42rem]:px-3 @[42rem]:pb-3">
            <ul className="flex flex-col gap-1 text-sm">
              {refusedUnderRow ? (
                <li role="alert" className="text-blocked">
                  {refused.message}
                </li>
              ) : null}
              {row.issues.map((issue) => (
                <li key={issue.code} className={ISSUE_TEXT[issue.severity]}>
                  <IssueMessage message={issue.message} />
                </li>
              ))}
            </ul>
          </td>
        </tr>
      ) : null}
      {/* A closed review cannot take a new description, so a row without one offers nothing here. */}
      {readOnly && !hasDescription ? null : (
        <tr className={rowClass}>
          <td colSpan={5} className="order-3 col-span-2 align-top @[42rem]:table-cell @[42rem]:px-3 @[42rem]:pb-3">
            <details open={hasSuggestion} className="text-sm">
              <summary className={`cursor-pointer py-1 text-xs transition-colors hover:text-foreground ${SECONDARY_TEXT}`}>
                {hasDescription ? "Description" : "Add a description"}
              </summary>
              <div className="mt-2 grid gap-2 @[42rem]:grid-cols-3">
                <TextArea
                  label="As your list says it"
                  value={row.description}
                  textColor="text-ink"
                  onCommit={(text) => save({ description: text })}
                />
                <TextArea
                  label="English"
                  value={row.descriptionEn}
                  textColor="text-foreground"
                  onCommit={(text) => save({ descriptionEn: text })}
                />
                <TextArea
                  label="Latvian"
                  value={row.descriptionLv}
                  textColor="text-foreground"
                  onCommit={(text) => save({ descriptionLv: text })}
                />
              </div>
              {hasSuggestion && !readOnly ? (
                <p className={`mt-1 text-xs ${MUTED_TEXT}`}>
                  Suggested from this row&apos;s own words. Check them before you accept.
                </p>
              ) : null}
            </details>
          </td>
        </tr>
      )}
    </tbody>
  );
}
