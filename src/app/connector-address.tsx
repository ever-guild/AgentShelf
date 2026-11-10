"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  BuyerConnectDialog,
  COPY_STATUS_TEXT,
  copyToClipboard,
  type Assistant,
  type CopyState,
} from "./buyer-connect";

export function ConnectorAddress({ address }: { address: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const [activeAssistant, setActiveAssistant] = useState<Assistant | null>(null);
  const addressRef = useRef<HTMLSpanElement>(null);
  const closeDialog = useCallback(() => setActiveAssistant(null), []);

  useEffect(() => {
    if (state !== "copied") {
      return;
    }
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    const result = await copyToClipboard(address, addressRef.current);
    setState(result);
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* Address and Copy button */}
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          <span
            ref={addressRef}
            className="min-w-0 rounded-lg bg-zinc-100 px-3 py-2 font-mono text-sm break-all select-all text-zinc-800"
          >
            {address}
          </span>
          <button
            type="button"
            onClick={copy}
            className="h-9 shrink-0 rounded-lg border border-zinc-300 px-3 text-sm font-medium transition-colors hover:bg-zinc-100 active:scale-[0.98]"
          >
            Copy
            <span className="sr-only"> the connector address</span>
          </button>
          <span role="status" aria-live="polite" className="text-xs text-zinc-600">
            {COPY_STATUS_TEXT[state]}
          </span>
        </div>

        {/* Dedicated Assistant Connection Buttons */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveAssistant("claude")}
            className="inline-flex h-9 items-center justify-center rounded-lg border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 active:scale-[0.98]"
          >
            Connect Claude
          </button>
          <button
            type="button"
            onClick={() => setActiveAssistant("chatgpt")}
            className="inline-flex h-9 items-center justify-center rounded-lg border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 active:scale-[0.98]"
          >
            Connect ChatGPT
          </button>
        </div>
      </div>

      {/* Accessible Interactive Dialog */}
      <BuyerConnectDialog
        isOpen={activeAssistant !== null}
        initialAssistant={activeAssistant ?? "claude"}
        address={address}
        onClose={closeDialog}
      />

      {/* Static Fallback for no-JS environments */}
      <noscript>
        <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-xs text-zinc-800">
          <p className="font-semibold text-zinc-900">Connecting your assistant without JavaScript:</p>
          <p className="mt-1">
            <strong>MCP Server Address:</strong> <code>{address}</code> (Public, no login required)
          </p>
          <p className="mt-1">
            <strong>Claude Code CLI:</strong> <code>claude mcp add --scope user --transport http AgentShelf {address}</code>
          </p>
          <p className="mt-1">
            <strong>Claude:</strong> Customize → Connectors → Add custom connector
          </p>
          <p className="mt-1">
            <strong>ChatGPT:</strong> Plugins → + → Add custom MCP server → No authentication → Create as plugin → Install → open a new chat and select @AgentShelf Buyer
          </p>
        </div>
      </noscript>
    </>
  );
}
