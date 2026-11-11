"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import {
  COPY_STATUS_TEXT,
  copyToClipboard,
  getAgentConfig,
  getClaudeCodeCommand,
  PROMPT_PURCHASE,
  PROMPT_SEARCH,
  PURCHASE_FLOW_STEPS,
  QUICK_OPEN,
  REPAIR_SERVICES_DISTINCTION,
  STEPS_BY_ASSISTANT,
  type Assistant,
  type CopyState,
} from "./buyer-connect-copy";

interface BuyerConnectGuideProps {
  address: string;
  initialAssistant?: Assistant;
  idPrefix?: string;
}

const ASSISTANTS: { id: Assistant; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "agent", label: "Any agent" },
];

const SECONDARY_TEXT = "text-zinc-600";
const COPY_BUTTON =
  "inline-flex h-9 shrink-0 items-center rounded-lg border border-zinc-300 bg-background px-3 text-sm font-medium transition-colors hover:bg-zinc-100 active:scale-[0.98]";
const BLOCK = "rounded-lg bg-zinc-100 px-3 py-2 font-mono text-sm break-words whitespace-pre-wrap select-all";
const MORE = `w-fit cursor-pointer text-sm font-medium underline underline-offset-4 transition-colors hover:text-ink`;

type Copied = { key: string; state: CopyState } | null;

// A block of text with its own copy button and a line that says what happened.
function Copyable({
  id,
  text,
  label,
  copied,
  onCopied,
}: {
  id: string;
  text: string;
  label: string;
  copied: Copied;
  onCopied: (copied: Copied) => void;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const state = copied?.key === id ? copied.state : "idle";
  return (
    <div className="flex flex-col gap-2">
      <p ref={ref} className={BLOCK}>
        {text}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={COPY_BUTTON}
          onClick={async () => onCopied({ key: id, state: await copyToClipboard(text, ref.current) })}
        >
          {label}
        </button>
        <span role="status" aria-live="polite" className={`text-xs ${SECONDARY_TEXT}`}>
          {COPY_STATUS_TEXT[state]}
        </span>
      </div>
    </div>
  );
}

// The guide shows only what connecting takes: the address, three steps for the chosen assistant and
// one request to try. Everything a first purchase needs sits behind one more line.
export function BuyerConnectGuide({
  address,
  initialAssistant = "claude",
  idPrefix = "buyer-connect",
}: BuyerConnectGuideProps) {
  const [assistant, setAssistant] = useState<Assistant>(initialAssistant);
  const [copied, setCopied] = useState<Copied>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
    );
    if (tabs.length === 0) return;
    event.preventDefault();
    const current = tabs.indexOf(event.currentTarget);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    tabs[next]?.focus();
    const chosen = ASSISTANTS[next];
    if (chosen) setAssistant(chosen.id);
  }

  const copy = { copied, onCopied: setCopied };

  const steps = STEPS_BY_ASSISTANT[assistant];
  const entry = QUICK_OPEN[assistant];
  const quick = entry && assistant === "claude"
    ? { ...entry, url: `${entry.url}?${new URLSearchParams({ modal: "add-custom-connector", connectorName: "AgentShelf", connectorUrl: address })}` }
    : entry;
  const name = ASSISTANTS.find(({ id }) => id === assistant)?.label ?? "";

  return (
    <div className="flex flex-col gap-8 text-foreground">
      <div
        role="tablist"
        aria-label="Assistant"
        className="inline-flex w-fit max-w-full flex-wrap rounded-lg bg-zinc-100 p-1"
      >
        {ASSISTANTS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${id}`}
            aria-selected={assistant === id}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={assistant === id ? 0 : -1}
            onKeyDown={handleTabKeyDown}
            onClick={() => setAssistant(id)}
            className={`inline-flex h-9 items-center rounded-md px-4 text-sm font-medium transition-colors ${
              assistant === id ? "bg-background text-foreground" : `${SECONDARY_TEXT} hover:text-foreground`
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <section aria-labelledby={`${idPrefix}-address-title`} className="flex flex-col gap-2">
        <h3 id={`${idPrefix}-address-title`} className="font-medium">
          Connector address
        </h3>
        <p className={`text-sm ${SECONDARY_TEXT}`}>Public, with no sign-in, token or key</p>
        <Copyable id="address" text={address} label="Copy address" {...copy} />
      </section>

      <section
        role="tabpanel"
        id={`${idPrefix}-panel`}
        aria-labelledby={`${idPrefix}-tab-${assistant}`}
        className="flex flex-col gap-4"
      >
        <h3 className="font-medium">{assistant === "agent" ? "Connect any agent" : `Connect in ${name}`}</h3>
        {quick ? (
          <div className="flex flex-col gap-2">
            {/* A link, so the new tab opens the way the browser expects, with the copy riding on the click. */}
            <a
              href={quick.url}
              target="_blank"
              rel="noreferrer"
              onClick={() => {
                void copyToClipboard(address).then((state) => setCopied({ key: "quick", state }));
              }}
              className="inline-flex h-11 w-fit items-center rounded-lg bg-ink px-4 font-medium text-background transition-[background-color,transform] hover:bg-ink/90 active:scale-[0.98]"
            >
              {quick.label}
            </a>
            <p className={`text-sm ${SECONDARY_TEXT}`}>{quick.next}</p>
            <span role="status" aria-live="polite" className={`text-xs ${SECONDARY_TEXT}`}>
              {copied?.key === "quick" ? COPY_STATUS_TEXT[copied.state] : ""}
            </span>
            <p className="pt-2 text-sm font-medium">Or step by step</p>
          </div>
        ) : null}
        <ol className="flex flex-col gap-3">
          {steps.map((step) => (
            <li key={step.number} className="flex gap-4">
              <span aria-hidden="true" className="font-medium text-ink tabular-nums">
                {step.number}
              </span>
              <div className="flex flex-col gap-1">
                <p className="font-medium">{step.title}</p>
                <p className={`text-sm ${SECONDARY_TEXT}`}>{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>

        {assistant === "claude" ? (
          <details className="flex flex-col gap-3">
            <summary className={MORE}>Using Claude Code</summary>
            <div className="flex flex-col gap-2 pt-3">
              <p className={`text-sm ${SECONDARY_TEXT}`}>Run this once in a terminal</p>
              <Copyable id="claude-code" text={getClaudeCodeCommand(address)} label="Copy command" {...copy} />
            </div>
          </details>
        ) : null}

        {assistant === "agent" ? (
          <div className="flex flex-col gap-2">
            <p className={`text-sm ${SECONDARY_TEXT}`}>Many agents read a server entry like this from their settings</p>
            <Copyable id="agent-config" text={getAgentConfig(address)} label="Copy settings" {...copy} />
          </div>
        ) : null}
      </section>

      <section aria-labelledby={`${idPrefix}-try-title`} className="flex flex-col gap-2">
        <h3 id={`${idPrefix}-try-title`} className="font-medium">
          Then ask
        </h3>
        <p className={`text-sm ${SECONDARY_TEXT}`}>This one only searches, nothing is ordered</p>
        <Copyable id="prompt-search" text={PROMPT_SEARCH} label="Copy request" {...copy} />
      </section>

      <details>
        <summary className={MORE}>Buy something in PayPal Sandbox</summary>
        <div className="flex flex-col gap-6 pt-4">
          <div className="flex flex-col gap-2">
            <p className={`text-sm ${SECONDARY_TEXT}`}>
              A careful request for one purchase. A person approves the payment in PayPal with a Sandbox
              buyer account.
            </p>
            <Copyable id="prompt-purchase" text={PROMPT_PURCHASE} label="Copy request" {...copy} />
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="font-medium">What happens</h3>
            <ol className="flex flex-col divide-y divide-zinc-200 border-y border-zinc-200 text-sm">
              {PURCHASE_FLOW_STEPS.map((step) => (
                <li key={step.number} className="grid gap-x-4 gap-y-1 py-2 sm:grid-cols-[10rem_1fr]">
                  <code className={`font-mono text-xs ${SECONDARY_TEXT}`}>{step.tool}</code>
                  <span>{step.description}</span>
                </li>
              ))}
            </ol>
            <p className={`text-sm ${SECONDARY_TEXT}`}>
              A PayPal approval link is not a payment, the order stays pending until a person approves it
            </p>
          </div>

          <div className="flex flex-col gap-1 text-sm">
            <h3 className="text-base font-medium">Repairs are booked, not bought</h3>
            <p className={SECONDARY_TEXT}>{REPAIR_SERVICES_DISTINCTION.explanation}</p>
            <p className={`font-mono text-xs ${SECONDARY_TEXT}`}>{REPAIR_SERVICES_DISTINCTION.flow}</p>
          </div>
        </div>
      </details>
    </div>
  );
}
