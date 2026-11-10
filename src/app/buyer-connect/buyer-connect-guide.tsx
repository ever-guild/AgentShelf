"use client";

import { useEffect, useRef, useState } from "react";

import {
  CHATGPT_STEPS,
  CLAUDE_AI_STEPS,
  COPY_STATUS_TEXT,
  copyToClipboard,
  getClaudeCodeCommand,
  PROMPT_PURCHASE,
  PROMPT_SEARCH,
  PURCHASE_FLOW_STEPS,
  REPAIR_SERVICES_DISTINCTION,
  type Assistant,
  type ClaudeMode,
  type CopyState,
} from "./buyer-connect-copy";

interface BuyerConnectGuideProps {
  address: string;
  initialAssistant?: Assistant;
  idPrefix?: string;
}

export function BuyerConnectGuide({
  address,
  initialAssistant = "claude",
  idPrefix = "buyer-connect",
}: BuyerConnectGuideProps) {
  const [assistant, setAssistant] = useState<Assistant>(initialAssistant);
  const [claudeMode, setClaudeMode] = useState<ClaudeMode>("web");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<Record<string, CopyState>>({});

  const addressRef = useRef<HTMLSpanElement>(null);
  const claudeCmdRef = useRef<HTMLPreElement>(null);
  const searchPromptRef = useRef<HTMLParagraphElement>(null);
  const purchasePromptRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!copiedKey) return;
    const timer = setTimeout(() => {
      setCopiedKey(null);
      setCopyStatus((prev) => ({ ...prev, [copiedKey]: "idle" }));
    }, 2500);
    return () => clearTimeout(timer);
  }, [copiedKey]);

  async function handleCopy(key: string, text: string, element?: HTMLElement | null) {
    const result = await copyToClipboard(text, element);
    setCopiedKey(key);
    setCopyStatus((prev) => ({ ...prev, [key]: result }));
  }

  const claudeCodeCommand = getClaudeCodeCommand(address);

  return (
    <div className="flex flex-col gap-8 text-zinc-900">
      {/* Assistant Selection Tabs */}
      <div className="flex flex-col gap-2">
        <label id={`${idPrefix}-assistant-label`} className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          Choose your AI Assistant
        </label>
        <div
          role="tablist"
          aria-labelledby={`${idPrefix}-assistant-label`}
          className="inline-flex rounded-lg border border-zinc-200 bg-zinc-100 p-1"
        >
          <button
            type="button"
            role="tab"
            id={`${idPrefix}-tab-claude`}
            aria-selected={assistant === "claude"}
            aria-controls={`${idPrefix}-panel-claude`}
            tabIndex={assistant === "claude" ? 0 : -1}
            onClick={() => setAssistant("claude")}
            className={`inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              assistant === "claude"
                ? "bg-white text-zinc-900 shadow-xs"
                : "text-zinc-600 hover:text-zinc-900"
            }`}
          >
            Claude (claude.ai & CLI)
          </button>
          <button
            type="button"
            role="tab"
            id={`${idPrefix}-tab-chatgpt`}
            aria-selected={assistant === "chatgpt"}
            aria-controls={`${idPrefix}-panel-chatgpt`}
            tabIndex={assistant === "chatgpt" ? 0 : -1}
            onClick={() => setAssistant("chatgpt")}
            className={`inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              assistant === "chatgpt"
                ? "bg-white text-zinc-900 shadow-xs"
                : "text-zinc-600 hover:text-zinc-900"
            }`}
          >
            ChatGPT
          </button>
        </div>
      </div>

      {/* Step 1: Server Address */}
      <section aria-labelledby={`${idPrefix}-step1-title`} className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50/50 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white">
              1
            </span>
            <h3 id={`${idPrefix}-step1-title`} className="text-sm font-medium text-zinc-900">
              MCP Server Address
            </h3>
          </div>
          <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
            Public · No login needed
          </span>
        </div>

        <p className="text-xs text-zinc-600">
          This is a public buyer MCP server. No seller token, API key, or authentication is required.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <span
            ref={addressRef}
            className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 font-mono text-sm break-all select-all text-zinc-800"
          >
            {address}
          </span>
          <button
            type="button"
            onClick={() => handleCopy("address", address, addressRef.current)}
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-zinc-300 bg-white px-3 text-sm font-medium transition-colors hover:bg-zinc-100"
          >
            {copyStatus["address"] === "copied" ? "Copied" : "Copy address"}
          </button>
        </div>
        <div aria-live="polite" className="text-xs text-zinc-500">
          {copyStatus["address"] ? COPY_STATUS_TEXT[copyStatus["address"]] : null}
        </div>
      </section>

      {/* Step 2: Connection Steps */}
      <section aria-labelledby={`${idPrefix}-step2-title`} className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white">
            2
          </span>
          <h3 id={`${idPrefix}-step2-title`} className="text-sm font-medium text-zinc-900">
            Connect in {assistant === "claude" ? "Claude" : "ChatGPT"}
          </h3>
        </div>

        {assistant === "claude" && (
          <div
            role="tabpanel"
            id={`${idPrefix}-panel-claude`}
            aria-labelledby={`${idPrefix}-tab-claude`}
            className="flex flex-col gap-4"
          >
            {/* Claude Sub-options: Web vs CLI */}
            <div className="flex gap-2 border-b border-zinc-200 pb-2">
              <button
                type="button"
                onClick={() => setClaudeMode("web")}
                className={`text-xs font-medium pb-1 transition-colors ${
                  claudeMode === "web"
                    ? "border-b-2 border-zinc-900 text-zinc-900"
                    : "text-zinc-500 hover:text-zinc-800"
                }`}
              >
                claude.ai (Web)
              </button>
              <button
                type="button"
                onClick={() => setClaudeMode("cli")}
                className={`text-xs font-medium pb-1 transition-colors ${
                  claudeMode === "cli"
                    ? "border-b-2 border-zinc-900 text-zinc-900"
                    : "text-zinc-500 hover:text-zinc-800"
                }`}
              >
                Claude Code (CLI)
              </button>
            </div>

            {claudeMode === "web" ? (
              <ol className="flex flex-col gap-2.5">
                {CLAUDE_AI_STEPS.map((step) => (
                  <li key={step.number} className="flex gap-3 text-sm">
                    <span className="shrink-0 font-medium text-zinc-400 tabular-nums">
                      {step.number}.
                    </span>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-zinc-800">{step.title}</span>
                      <span className="text-xs text-zinc-600">{step.detail}</span>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-zinc-600">
                  Run this command in your terminal to add AgentShelf to your user MCP scope:
                </p>
                <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-zinc-900 p-3 text-zinc-100">
                  <pre
                    ref={claudeCmdRef}
                    className="font-mono text-xs whitespace-pre-wrap break-all select-all text-zinc-200"
                  >
                    {claudeCodeCommand}
                  </pre>
                  <div className="flex items-center justify-between pt-1">
                    <span aria-live="polite" className="text-xs text-zinc-400">
                      {copyStatus["claude-cmd"] ? COPY_STATUS_TEXT[copyStatus["claude-cmd"]] : ""}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopy("claude-cmd", claudeCodeCommand, claudeCmdRef.current)}
                      className="inline-flex h-7 items-center rounded-md bg-zinc-800 px-2.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
                    >
                      {copyStatus["claude-cmd"] === "copied" ? "Copied" : "Copy command"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {assistant === "chatgpt" && (
          <div
            role="tabpanel"
            id={`${idPrefix}-panel-chatgpt`}
            aria-labelledby={`${idPrefix}-tab-chatgpt`}
            className="flex flex-col gap-2.5"
          >
            <ol className="flex flex-col gap-2.5">
              {CHATGPT_STEPS.map((step) => (
                <li key={step.number} className="flex gap-3 text-sm">
                  <span className="shrink-0 font-medium text-zinc-400 tabular-nums">
                    {step.number}.
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-zinc-800">{step.title}</span>
                    <span className="text-xs text-zinc-600">{step.detail}</span>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      {/* Step 3: Ready-to-copy Prompts */}
      <section aria-labelledby={`${idPrefix}-step3-title`} className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white">
            3
          </span>
          <h3 id={`${idPrefix}-step3-title`} className="text-sm font-medium text-zinc-900">
            Try Sample Prompts in Chat
          </h3>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {/* Prompt 1: Search */}
          <div className="flex flex-col justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-3.5 shadow-2xs">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                1. Search (Read-only)
              </span>
              <p
                ref={searchPromptRef}
                className="rounded-md bg-zinc-50 p-2.5 font-mono text-xs text-zinc-800 select-all"
              >
                {PROMPT_SEARCH}
              </p>
              <p className="text-[11px] text-zinc-500">
                Uses search_products to find items without placing an order.
              </p>
            </div>
            <div className="flex items-center justify-between border-t border-zinc-100 pt-2">
              <span aria-live="polite" className="text-xs text-zinc-500">
                {copyStatus["prompt-search"] ? COPY_STATUS_TEXT[copyStatus["prompt-search"]] : ""}
              </span>
              <button
                type="button"
                onClick={() => handleCopy("prompt-search", PROMPT_SEARCH, searchPromptRef.current)}
                className="inline-flex h-8 items-center rounded-lg border border-zinc-300 px-2.5 text-xs font-medium transition-colors hover:bg-zinc-100"
              >
                {copyStatus["prompt-search"] === "copied" ? "Copied" : "Copy prompt"}
              </button>
            </div>
          </div>

          {/* Prompt 2: Purchase */}
          <div className="flex flex-col justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-3.5 shadow-2xs">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                2. Purchase (Sandbox Checkout)
              </span>
              <p
                ref={purchasePromptRef}
                className="rounded-md bg-zinc-50 p-2.5 font-mono text-xs text-zinc-800 select-all"
              >
                {PROMPT_PURCHASE}
              </p>
              <p className="text-[11px] text-zinc-500">
                Calls create_checkout to obtain a PayPal Sandbox payment approval link.
              </p>
            </div>
            <div className="flex items-center justify-between border-t border-zinc-100 pt-2">
              <span aria-live="polite" className="text-xs text-zinc-500">
                {copyStatus["prompt-purchase"] ? COPY_STATUS_TEXT[copyStatus["prompt-purchase"]] : ""}
              </span>
              <button
                type="button"
                onClick={() => handleCopy("prompt-purchase", PROMPT_PURCHASE, purchasePromptRef.current)}
                className="inline-flex h-8 items-center rounded-lg border border-zinc-300 px-2.5 text-xs font-medium transition-colors hover:bg-zinc-100"
              >
                {copyStatus["prompt-purchase"] === "copied" ? "Copied" : "Copy prompt"}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Step 4: 4-Step Purchase Schema */}
      <section aria-labelledby={`${idPrefix}-step4-title`} className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white">
            4
          </span>
          <h3 id={`${idPrefix}-step4-title`} className="text-sm font-medium text-zinc-900">
            How Assistant Buying Works (4-Step Flow)
          </h3>
        </div>

        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PURCHASE_FLOW_STEPS.map((step) => (
            <li
              key={step.number}
              className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-3 text-xs"
            >
              <div className="flex items-center justify-between gap-1">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-100 font-semibold text-zinc-700">
                  {step.number}
                </span>
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-700">
                  {step.tool}
                </code>
              </div>
              <h4 className="font-medium text-zinc-900">{step.title}</h4>
              <p className="text-zinc-600">{step.description}</p>
              {step.note && (
                <p className="mt-auto border-t border-zinc-100 pt-1.5 text-[11px] text-zinc-500 italic">
                  {step.note}
                </p>
              )}
            </li>
          ))}
        </ol>
      </section>

      {/* Step 5: Repair Services Distinction */}
      <section
        aria-labelledby={`${idPrefix}-step5-title`}
        className="flex flex-col gap-2.5 rounded-xl border border-amber-200 bg-amber-50/50 p-4"
      >
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-700 text-xs font-semibold text-white">
            5
          </span>
          <h3 id={`${idPrefix}-step5-title`} className="text-sm font-medium text-amber-950">
            Services & Repairs Distinction
          </h3>
        </div>

        <p className="text-xs font-medium text-amber-900">
          {REPAIR_SERVICES_DISTINCTION.warning}
        </p>

        <div className="rounded-lg border border-amber-200 bg-white p-2.5 font-mono text-xs text-amber-900">
          {REPAIR_SERVICES_DISTINCTION.flow}
        </div>

        <p className="text-xs text-amber-800">
          {REPAIR_SERVICES_DISTINCTION.explanation}
        </p>
      </section>
    </div>
  );
}
