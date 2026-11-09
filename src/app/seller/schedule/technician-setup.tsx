"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import type { TechnicianWeek } from "@/server/contracts/seller-schedule";

// The owner's first setup: one technician and the hours they work, in shop time. Buyers'
// assistants are offered repair times only inside these hours.

const DAYS = [
  { weekday: 1, short: "Mon", long: "Monday" },
  { weekday: 2, short: "Tue", long: "Tuesday" },
  { weekday: 3, short: "Wed", long: "Wednesday" },
  { weekday: 4, short: "Thu", long: "Thursday" },
  { weekday: 5, short: "Fri", long: "Friday" },
  { weekday: 6, short: "Sat", long: "Saturday" },
  { weekday: 7, short: "Sun", long: "Sunday" },
];

const field =
  "h-11 rounded-lg border border-zinc-300 bg-background px-3 text-base dark:border-zinc-700";
const SECONDARY_TEXT = "text-zinc-600 dark:text-zinc-400";

type ApiError = { error?: { message?: unknown } };

async function send(url: string, method: "POST" | "PUT", body: unknown) {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as TechnicianWeek & ApiError;
  if (!response.ok) {
    const message = typeof data.error?.message === "string" ? data.error.message : null;
    throw new Error(
      response.status === 401
        ? "This shop is no longer signed in here. Sign in again and try once more."
        : (message ?? "Could not save. Try again."),
    );
  }
  return data;
}

function daysText(weekdays: number[]): string {
  const names = DAYS.filter(({ weekday }) => weekdays.includes(weekday)).map(({ long }) => long);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

export function TechnicianSetup({
  timezone,
  waiting,
  onSaved,
}: {
  timezone: string;
  // A technician who was added but has no hours yet, such as after a save that failed halfway.
  waiting: { technicianId: string; name: string } | null;
  onSaved: () => void;
}) {
  const router = useRouter();
  const ids = useId();
  const [technician, setTechnician] = useState(waiting);
  const [name, setName] = useState("");
  const [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5]);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("18:00");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!technician && name.trim() === "") {
      setProblem("Enter the technician's name.");
      return;
    }
    if (weekdays.length === 0) {
      setProblem("Choose at least one working day.");
      return;
    }
    if (!start || !end || end <= start) {
      setProblem("The end of the working day has to be later than its start.");
      return;
    }
    setBusy(true);
    setProblem(null);
    let person = technician;
    try {
      if (!person) {
        const created = await send("/api/seller/schedule/technicians", "POST", { name });
        person = { technicianId: created.technicianId, name: created.name };
        // Kept, so trying again after a failed second step only sets the hours.
        setTechnician(person);
      }
      await send(
        `/api/seller/schedule/technicians/${encodeURIComponent(person.technicianId)}/windows`,
        "PUT",
        { windows: [...weekdays].sort((a, b) => a - b).map((weekday) => ({ weekday, start, end })) },
      );
      setSaved(
        `${person.name} works ${daysText(weekdays)}, ${start} to ${end}. Buyers' assistants can now book repairs in these hours.`,
      );
      onSaved();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
      // The page's own reading of the shop follows what was saved, including a technician added
      // before a failed second step.
      router.refresh();
    }
  }

  if (saved) {
    return (
      <p role="status" className="max-w-prose border-l-4 border-ink pl-4">
        {saved}
      </p>
    );
  }

  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="flex max-w-2xl flex-col gap-6 rounded-xl border border-zinc-200 p-5 sm:p-6 dark:border-zinc-800"
    >
      <div className="flex flex-col gap-2">
        <h2 id={`${ids}-title`} className="text-lg font-medium">
          {technician ? `Set ${technician.name}'s working hours` : "Set up who takes repairs"}
        </h2>
        <p className={`max-w-prose ${SECONDARY_TEXT}`}>
          {technician
            ? `${technician.name} has no working hours yet, so buyers cannot book them.`
            : "Buyers cannot book repairs until a technician has working hours."}{" "}
          Times are shop time, {timezone}.
        </p>
      </div>

      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        {!technician && (
          <label className="flex flex-col gap-1.5">
            <span className="font-medium">Technician</span>
            <input
              name="name"
              autoComplete="off"
              maxLength={80}
              required
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              className={`${field} max-w-sm`}
            />
          </label>
        )}

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 font-medium">Working days</legend>
          <div className="flex flex-wrap gap-2">
            {DAYS.map(({ weekday, short, long }) => {
              const checked = weekdays.includes(weekday);
              return (
                <label
                  key={weekday}
                  className={`relative inline-flex h-11 min-w-14 cursor-pointer items-center justify-center rounded-lg border px-3 text-sm font-medium transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink ${
                    checked
                      ? "border-ink bg-ink text-background"
                      : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={checked}
                    onChange={(event) => {
                      const on = event.currentTarget.checked;
                      setWeekdays((days) =>
                        on ? [...days, weekday] : days.filter((day) => day !== weekday),
                      );
                    }}
                  />
                  <span aria-hidden="true">{short}</span>
                  <span className="sr-only">{long}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="font-medium">From</span>
            <input
              type="time"
              required
              value={start}
              onChange={(event) => setStart(event.currentTarget.value)}
              className={`${field} tabular-nums`}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-medium">To</span>
            <input
              type="time"
              required
              value={end}
              onChange={(event) => setEnd(event.currentTarget.value)}
              className={`${field} tabular-nums`}
            />
          </label>
        </div>

        {problem && (
          <p role="alert" className="border-l-4 border-blocked pl-4 text-sm">
            {problem}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="h-11 w-fit rounded-lg bg-ink px-4 font-medium text-background transition-[background-color,transform] hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink active:scale-[0.98] disabled:opacity-60"
        >
          {busy ? "Saving" : "Save working hours"}
        </button>
      </form>
    </section>
  );
}
