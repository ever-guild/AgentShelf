"use client";

import { useEffect, useRef, useState } from "react";

type CopyState = "idle" | "copied" | "selected";

const STATUS_TEXT: Record<CopyState, string> = {
  idle: "",
  copied: "Copied",
  selected: "Selected. Press Ctrl or Cmd and C to copy",
};

export function ConnectorAddress({ address }: { address: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const addressRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (state !== "copied") {
      return;
    }
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setState("copied");
    } catch {
      // No clipboard access, for example on a plain http page. Selecting leaves one keystroke to do.
      if (addressRef.current) {
        window.getSelection()?.selectAllChildren(addressRef.current);
      }
      setState("selected");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span
        ref={addressRef}
        className="min-w-0 rounded-lg bg-zinc-100 px-3 py-2 font-mono text-sm break-all select-all"
      >
        {address}
      </span>
      <button
        type="button"
        onClick={copy}
        className="h-9 rounded-lg border border-zinc-300 px-3 text-sm font-medium transition-colors hover:bg-zinc-100"
      >
        Copy
        <span className="sr-only"> the connector address</span>
      </button>
      <span role="status" className="text-sm text-zinc-600">
        {STATUS_TEXT[state]}
      </span>
    </div>
  );
}
