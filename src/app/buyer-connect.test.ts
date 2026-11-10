import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

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
} from "./buyer-connect/buyer-connect-copy";
import { BuyerConnectDialog } from "./buyer-connect/buyer-connect-dialog";
import { BuyerConnectGuide } from "./buyer-connect/buyer-connect-guide";
import { ConnectorAddress } from "./connector-address";

describe("Buyer Connect Prompts and Copy", () => {
  it("matches the exact read-only search prompt", () => {
    expect(PROMPT_SEARCH).toContain("Use only AgentShelf Buyer and call search_products");
    expect(PROMPT_SEARCH).toContain("Do not use web search or tools outside AgentShelf Buyer");
    expect(PROMPT_SEARCH).toContain("do not book, order, or pay");
  });

  it("requires a fresh price and one buyer-approved checkout without unsafe retries", () => {
    expect(PROMPT_PURCHASE).toContain("call search_products");
    expect(PROMPT_PURCHASE).toContain("current available item, availability, price, and currency");
    expect(PROMPT_PURCHASE).toContain("ask me to confirm before checkout");
    expect(PROMPT_PURCHASE).toContain("call create_checkout exactly once");
    expect(PROMPT_PURCHASE).toContain("Do not use web search or tools outside AgentShelf Buyer");
    expect(PROMPT_PURCHASE).toContain("do not automatically repeat or create another checkout while payment is pending");
    expect(PROMPT_PURCHASE).toContain("until get_order_status reports paid");
    expect(PROMPT_PURCHASE).not.toContain("€9.90");
  });

  it("formats the Claude Code CLI command with the given MCP address", () => {
    const address = "https://agentshelf.onrender.com/mcp";
    expect(getClaudeCodeCommand(address)).toBe(
      "claude mcp add --scope user --transport http AgentShelf https://agentshelf.onrender.com/mcp",
    );
  });

  it("specifies correct connection steps for claude.ai", () => {
    const texts = CLAUDE_AI_STEPS.map((s) => `${s.title}: ${s.detail}`).join(" ");
    expect(texts).toContain("Settings");
    expect(texts).toContain("Connectors");
    expect(texts).toContain("AgentShelf Buyer");
    expect(texts).toContain("No sign-in");
    expect(texts).toContain("/mcp");
  });

  it("specifies correct connection steps for ChatGPT", () => {
    const texts = CHATGPT_STEPS.map((s) => `${s.title}: ${s.detail}`).join(" ");
    expect(texts).toContain("ChatGPT Plugins");
    expect(texts).toContain("click +");
    expect(texts).toContain("Add custom MCP server");
    expect(texts).toContain("AgentShelf Buyer");
    expect(texts).toContain("No authentication");
    expect(texts).toContain("Create as a plugin");
    expect(texts).toContain("install it");
    expect(texts).toContain("type @");
  });

  it("defines the 4-step purchase flow with human confirmation and pending state note", () => {
    expect(PURCHASE_FLOW_STEPS).toHaveLength(4);
    expect(PURCHASE_FLOW_STEPS[0].tool).toBe("search_products");
    expect(PURCHASE_FLOW_STEPS[1].tool).toBe("create_checkout");
    expect(PURCHASE_FLOW_STEPS[1].note).toMatch(/NOT complete the purchase/i);
    expect(PURCHASE_FLOW_STEPS[2].tool).toBe("PayPal Sandbox");
    expect(PURCHASE_FLOW_STEPS[3].tool).toBe("get_order_status");
  });

  it("clearly distinguishes repair services from products checkout", () => {
    expect(REPAIR_SERVICES_DISTINCTION.warning).toContain(
      "Services and repairs are NOT bought through create_checkout",
    );
    expect(REPAIR_SERVICES_DISTINCTION.flow).toContain("get_slots");
    expect(REPAIR_SERVICES_DISTINCTION.flow).toContain("book_slot");
    expect(REPAIR_SERVICES_DISTINCTION.flow).toContain("PayPal Sandbox");
  });

  it("provides user-friendly copy status messages", () => {
    expect(COPY_STATUS_TEXT.idle).toBe("");
    expect(COPY_STATUS_TEXT.copied).toBe("Copied");
    expect(COPY_STATUS_TEXT.selected).toContain("Press Ctrl or Cmd and C to copy");
  });
});

describe("copyToClipboard fallback logic", () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });

  it("returns copied when navigator.clipboard.writeText succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText } },
      writable: true,
      configurable: true,
    });

    const result = await copyToClipboard("test-text");
    expect(result).toBe("copied");
    expect(writeText).toHaveBeenCalledWith("test-text");
  });

  it("returns failed when clipboard throws and no selectable DOM target exists", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText } },
      writable: true,
      configurable: true,
    });

    const result = await copyToClipboard("test-text");
    expect(result).toBe("failed");
  });

  it("returns selected when navigator.clipboard is unavailable", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      writable: true,
      configurable: true,
    });

    const result = await copyToClipboard("test-text");
    expect(result).toBe("failed");
  });

  it("returns copied only when the legacy copy command succeeds and removes its textarea", async () => {
    const removed = vi.fn();
    const textarea = {
      value: "",
      style: {},
      setAttribute: vi.fn(),
      select: vi.fn(),
      remove: removed,
    };
    vi.stubGlobal("window", { getSelection: () => null });
    vi.stubGlobal("document", {
      createElement: () => textarea,
      body: { appendChild: vi.fn() },
      execCommand: vi.fn(() => true),
    });

    await expect(copyToClipboard("test-text")).resolves.toBe("copied");
    expect(textarea.value).toBe("test-text");
    expect(removed).toHaveBeenCalledOnce();
  });

  it("returns selected only when fallback leaves the supplied text selected", async () => {
    const range = { selectNodeContents: vi.fn() };
    const selection = {
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
      toString: vi.fn(() => "test-text"),
    };
    const textarea = {
      value: "",
      style: {},
      setAttribute: vi.fn(),
      select: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal("window", { getSelection: () => selection });
    vi.stubGlobal("document", {
      createElement: () => textarea,
      createRange: () => range,
      body: { appendChild: vi.fn() },
      execCommand: vi.fn(() => false),
    });

    await expect(copyToClipboard("test-text", {} as HTMLElement)).resolves.toBe("selected");
    expect(selection.addRange).toHaveBeenCalledWith(range);
    expect(textarea.remove).toHaveBeenCalledOnce();
  });

  it("does not report selected when the fallback selection differs from the requested text", async () => {
    const selection = {
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
      toString: () => "different text",
    };
    const textarea = {
      value: "",
      style: {},
      setAttribute: vi.fn(),
      select: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal("window", { getSelection: () => selection });
    vi.stubGlobal("document", {
      createElement: () => textarea,
      createRange: () => ({ selectNodeContents: vi.fn() }),
      body: { appendChild: vi.fn() },
      execCommand: vi.fn(() => false),
    });

    await expect(copyToClipboard("test-text", {} as HTMLElement)).resolves.toBe("failed");
    expect(textarea.remove).toHaveBeenCalledOnce();
  });
});

describe("BuyerConnectGuide Component Rendering", () => {
  const testAddress = "https://example.com/mcp";

  it("renders the 5 required steps and address", () => {
    const html = renderToStaticMarkup(
      React.createElement(BuyerConnectGuide, { address: testAddress, initialAssistant: "claude" }),
    );

    expect(html).toContain("MCP Server Address");
    expect(html).toContain(testAddress);
    expect(html).toContain("Public · No login needed");
    expect(html).toContain("Connect in Claude");
    expect(html).toContain("Try Sample Prompts in Chat");
    expect(html).toContain("How Assistant Buying Works (4-Step Flow)");
    expect(html).toContain("Services &amp; Repairs Distinction");
  });

  it("renders both sample prompts with copy buttons", () => {
    const html = renderToStaticMarkup(
      React.createElement(BuyerConnectGuide, { address: testAddress, initialAssistant: "claude" }),
    );

    expect(html).toContain(PROMPT_SEARCH);
    expect(html).toContain(PROMPT_PURCHASE);
    expect(html).toContain("Copy prompt");
    expect(html).toContain("Purchase (Sandbox Checkout)");
  });

  it("renders ChatGPT setup instructions when assistant is chatgpt", () => {
    const html = renderToStaticMarkup(
      React.createElement(BuyerConnectGuide, { address: testAddress, initialAssistant: "chatgpt" }),
    );

    expect(html).toContain("Connect in ChatGPT");
    expect(html).toContain("ChatGPT Plugins");
    expect(html).toContain("Create as a plugin");
    expect(html).toContain("install it");
  });

  it("renders Claude setup instructions and terminal command when assistant is claude", () => {
    const html = renderToStaticMarkup(
      React.createElement(BuyerConnectGuide, { address: testAddress, initialAssistant: "claude" }),
    );

    expect(html).toContain("claude.ai (Web)");
    expect(html).toContain("Claude Code (CLI)");
    expect(html).toContain("Add custom connector");
    expect(html).toContain("No sign-in");
  });
});

describe("BuyerConnectDialog Component", () => {
  const testAddress = "https://example.com/mcp";

  it("renders nothing when isOpen is false", () => {
    const html = renderToStaticMarkup(
      React.createElement(BuyerConnectDialog, {
        isOpen: false,
        onClose: () => {},
        address: testAddress,
      }),
    );
    expect(html).toBe("");
  });

  it("renders accessible modal with role=dialog and aria-modal=true when open", () => {
    const html = renderToStaticMarkup(
      React.createElement(BuyerConnectDialog, {
        isOpen: true,
        onClose: () => {},
        address: testAddress,
      }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="buyer-connect-dialog-title"');
    expect(html).toContain("Connect Your AI Assistant");
    expect(html).toContain('aria-label="Close dialog"');
    expect(html).toContain("Done");
  });
});

describe("ConnectorAddress Component", () => {
  const testAddress = "https://agentshelf.example.com/mcp";

  it("renders the address, Copy button, and Connect Claude/ChatGPT buttons", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectorAddress, { address: testAddress }));

    expect(html).toContain(testAddress);
    expect(html).toContain("Copy");
    expect(html).toContain("Connect Claude");
    expect(html).toContain("Connect ChatGPT");
    expect(html).toContain("noscript");
  });
});
