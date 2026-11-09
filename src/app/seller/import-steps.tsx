import type { ImportStatus } from "@/server/contracts/imports";

// The three steps every price list goes through. Each screen shows them from the import's own
// status, so a step is never marked done before the server says it is.
const STEPS = ["Read", "Check", "Publish"] as const;

type StepState = "done" | "current" | "next";

const SECONDARY_TEXT = "text-zinc-600 dark:text-zinc-400";

export function stepStates(
  status: ImportStatus,
  publishedCount: number,
  publishable: number,
): StepState[] {
  switch (status) {
    case "queued":
    case "running":
    case "failed":
      return ["current", "next", "next"];
    case "needs_review":
      return ["done", "current", "next"];
    case "completed":
      return publishedCount > 0 && publishable === 0
        ? ["done", "done", "done"]
        : ["done", "done", "current"];
  }
}

function Check() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ImportProgress({ states }: { states: StepState[] }) {
  return (
    <ol aria-label="Steps" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      {STEPS.map((label, index) => {
        const state = states[index];
        return (
          <li
            key={label}
            aria-current={state === "current" ? "step" : undefined}
            className={`flex items-center gap-2 ${state === "current" ? "font-medium text-foreground" : SECONDARY_TEXT}`}
          >
            <span
              className={`inline-flex size-6 flex-none items-center justify-center rounded-full font-mono text-xs tabular-nums ${
                state === "current"
                  ? "bg-ink text-background"
                  : state === "done"
                    ? "bg-zinc-200 text-foreground dark:bg-zinc-800"
                    : "border border-zinc-300 dark:border-zinc-700"
              }`}
            >
              {state === "done" ? <Check /> : index + 1}
            </span>
            <span>
              {label}
              <span className="sr-only">{state === "done" ? ", done" : state === "current" ? ", now" : ""}</span>
            </span>
            {index < STEPS.length - 1 ? (
              <span aria-hidden="true" className="h-px w-6 bg-zinc-300 sm:w-10 dark:bg-zinc-700" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// Before the first upload, the same steps say what will happen, in the product's own words.
export function HowItWorks() {
  const items = [
    {
      title: "Photograph your price list",
      text: "Or upload a CSV file. The model reads the names, the prices and how long each repair takes.",
    },
    {
      title: "Check every row",
      text: "Your photo stays beside the table, and words in blue are what your list says.",
    },
    {
      title: "Publish",
      text: "Buyers’ assistants find your products and book your repairs through one connector.",
    },
  ];
  return (
    <ol className="flex flex-col gap-6">
      {items.map((item, index) => (
        <li key={item.title} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-4 gap-y-1">
          <span className="inline-flex size-6 items-center justify-center rounded-full border border-zinc-300 font-mono text-xs tabular-nums text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
            {index + 1}
          </span>
          <span className="font-medium">{item.title}</span>
          <span className={`col-start-2 max-w-prose text-sm ${SECONDARY_TEXT}`}>{item.text}</span>
        </li>
      ))}
    </ol>
  );
}
