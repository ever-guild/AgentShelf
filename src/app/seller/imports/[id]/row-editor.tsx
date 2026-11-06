"use client";

import { useState, type ReactNode } from "react";

import type { ImportRowPatch, ImportRowView, ImportView } from "@/server/contracts/imports";
import type { RowField } from "@/server/imports/draft-rows";

import { RequestFailed } from "./request";

const controlClass =
  "min-w-0 rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-base focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink disabled:border-transparent disabled:px-0 md:text-sm dark:border-zinc-700";
const inputClass = `w-full ${controlClass}`;

// A row's left edge says where it stands, so a long table can be scanned for what still needs work.
function edgeClass(row: ImportRowView): string {
  if (row.status === "removed") {
    return "border-l-zinc-200 opacity-60 dark:border-l-zinc-800";
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

// On a narrow screen each cell stacks and carries its own label, since the table head is hidden.
function Cell({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <td className={`block px-3 py-1.5 align-top md:table-cell md:px-2 md:py-2 ${className}`}>
      <span className="mb-1 block text-xs text-zinc-600 md:hidden dark:text-zinc-400">{label}</span>
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
  placeholder,
}: {
  label: string;
  value: string | null;
  onCommit: (text: string) => void;
  inputMode?: "decimal" | "numeric";
  placeholder?: string;
}) {
  const current = value ?? "";
  return (
    <input
      key={current}
      aria-label={label}
      defaultValue={current}
      inputMode={inputMode}
      placeholder={placeholder}
      className={inputClass}
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
}: {
  label: string;
  value: string | null;
  onCommit: (text: string) => void;
}) {
  const current = value ?? "";
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
      {label}
      <textarea
        key={current}
        defaultValue={current}
        rows={2}
        className={`${inputClass} text-foreground disabled:resize-none`}
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

  const blockers = row.issues.filter((issue) => issue.severity === "blocker");
  const removed = row.status === "removed";
  const isService = row.kind === "service";
  const hasSuggestion = Boolean(row.descriptionEn || row.descriptionLv);
  // With no price, the blocker already quotes what the list says.
  const showsPrinted = row.price !== null && row.priceText !== null && row.priceText !== row.price;
  const issuesFor = (field: RowField) => row.issues.filter((issue) => issue.field === field);
  const fieldNote = (field: RowField) =>
    refused?.field === field ? (
      <p role="alert" className="mt-1 text-xs text-blocked">
        {refused.message}
      </p>
    ) : null;
  const generalIssues = row.issues.filter(
    (issue) => !["price", "currency", "deposit", "duration"].includes(issue.field ?? ""),
  );

  return (
    <>
      <tr className={`block border-b-0 border-l-4 pt-2 md:table-row ${edgeClass(row)}`}>
        <Cell label="Name" className="md:pl-3">
          <TextField
            label={`Name, ${row.sourceRef}`}
            value={row.title}
            onCommit={(text) => save({ title: text })}
          />
          <p className="mt-1 text-xs text-zinc-500">{row.sourceRef}</p>
        </Cell>
        <Cell label="Kind">
          <select
            key={row.kind ?? ""}
            aria-label={`Kind, ${row.sourceRef}`}
            defaultValue={row.kind ?? ""}
            className={inputClass}
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
          <div className="flex gap-1.5">
            <div className="min-w-0 flex-1">
              <TextField
                label={`Price, ${row.sourceRef}`}
                value={row.price}
                inputMode="decimal"
                placeholder="0.00"
                onCommit={(text) => save({ price: text })}
              />
            </div>
            <select
              key={row.currency ?? ""}
              aria-label={`Currency, ${row.sourceRef}`}
              defaultValue={row.currency ?? ""}
              className={`${controlClass} w-[4.75rem] flex-none`}
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
            <p className="mt-1 text-xs text-ink">Your list says: {row.priceText}</p>
          ) : null}
          {fieldNote("price")}
          {[...issuesFor("price"), ...issuesFor("currency")].map((issue) => (
            <p key={issue.code} className={`mt-1 text-xs ${ISSUE_TEXT[issue.severity]}`}>
              {issue.message}
            </p>
          ))}
        </Cell>
        <Cell label="Booking">
          {isService ? (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                <span className="w-14 flex-none">Minutes</span>
                <TextField
                  label={`Minutes, ${row.sourceRef}`}
                  value={row.serviceDurationMinutes === null ? null : String(row.serviceDurationMinutes)}
                  inputMode="numeric"
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
              <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                <span className="w-14 flex-none">Deposit</span>
                <TextField
                  label={`Deposit, ${row.sourceRef}`}
                  value={row.deposit}
                  inputMode="decimal"
                  placeholder="0.00"
                  onCommit={(text) => save({ deposit: text })}
                />
              </label>
              {fieldNote("duration")}
              {fieldNote("deposit")}
              {[...issuesFor("duration"), ...issuesFor("deposit")].map((issue) => (
                <p key={issue.code} className={`text-xs ${ISSUE_TEXT[issue.severity]}`}>
                  {issue.message}
                </p>
              ))}
            </div>
          ) : (
            <span className="text-sm text-zinc-500">No booking needed</span>
          )}
        </Cell>
        <Cell label="Decision">
          {readOnly ? (
            <span className={`text-sm font-medium ${removed ? "text-zinc-500" : "text-accepted"}`}>
              {removed ? "Removed" : "Accepted"}
            </span>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              {row.status === "pending" ? (
                <button
                  type="button"
                  disabled={saving || blockers.length > 0}
                  onClick={() => save({ status: "accepted" })}
                  className="rounded bg-ink px-3 py-1.5 font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500 dark:text-zinc-950 dark:disabled:bg-zinc-800"
                >
                  Accept
                </button>
              ) : null}
              {row.status === "accepted" ? (
                <>
                  <span className="font-medium text-accepted">Accepted</span>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => save({ status: "pending" })}
                    className="underline underline-offset-4"
                  >
                    Undo
                  </button>
                </>
              ) : null}
              {removed ? (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => save({ status: "pending" })}
                  className="underline underline-offset-4"
                >
                  Restore
                </button>
              ) : (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => save({ status: "removed" })}
                  className="text-zinc-600 underline underline-offset-4 dark:text-zinc-400"
                >
                  Remove
                </button>
              )}
            </div>
          )}
        </Cell>
      </tr>
      <tr className={`block border-b border-l-4 border-b-zinc-200 pb-2 md:table-row dark:border-b-zinc-800 ${edgeClass(row)}`}>
        <td colSpan={5} className="block px-3 pb-2 md:table-cell">
          {refused && (refused.field === null || refused.field === "status") ? (
            <p role="alert" className="mb-1 text-sm text-blocked">
              {refused.message}
            </p>
          ) : null}
          {generalIssues.length > 0 ? (
            <ul className="mb-1 flex flex-col gap-0.5">
              {generalIssues.map((issue) => (
                <li key={issue.code} className={`text-xs ${ISSUE_TEXT[issue.severity]}`}>
                  {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
          <details open={hasSuggestion} className="group text-sm">
            <summary className="cursor-pointer text-xs text-zinc-600 dark:text-zinc-400">
              {row.description || hasSuggestion ? "Description" : "Add a description"}
            </summary>
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              <TextArea
                label="As your list says it"
                value={row.description}
                onCommit={(text) => save({ description: text })}
              />
              <TextArea
                label="English"
                value={row.descriptionEn}
                onCommit={(text) => save({ descriptionEn: text })}
              />
              <TextArea
                label="Latvian"
                value={row.descriptionLv}
                onCommit={(text) => save({ descriptionLv: text })}
              />
            </div>
            {hasSuggestion && !readOnly ? (
              <p className="mt-1 text-xs text-zinc-500">
                Suggested from this row&apos;s own words. Check them before you accept.
              </p>
            ) : null}
          </details>
        </td>
      </tr>
    </>
  );
}
