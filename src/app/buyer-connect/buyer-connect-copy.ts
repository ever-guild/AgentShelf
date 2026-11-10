export type Assistant = "claude" | "chatgpt" | "agent";
export type CopyState = "idle" | "copied" | "selected" | "failed";

export const COPY_STATUS_TEXT: Record<CopyState, string> = {
  idle: "",
  copied: "Copied",
  selected: "Selected. Press Ctrl or Cmd and C to copy",
  failed: "Copy failed. Select and copy the text manually",
};

export const PROMPT_SEARCH =
  "Use only AgentShelf Buyer and call search_products to find an iPhone 13 screen protector in Liepaja. Do not use web search or tools outside AgentShelf Buyer, and do not book, order, or pay.";

export const PROMPT_PURCHASE =
  "Use only AgentShelf Buyer. First call search_products for an iPhone 13 tempered glass at Liepāja Phone Workshop and show me the current available item, availability, price, and currency. If the result is ambiguous or the current price differs from a price I previously approved, ask me to confirm before checkout. Once I choose a current result, call create_checkout exactly once for that product and quantity 1, then give me its PayPal Sandbox approval link. Do not use web search or tools outside AgentShelf Buyer, do not automatically repeat or create another checkout while payment is pending, and do not claim payment is complete until get_order_status reports paid. After I return from PayPal, check order status.";

export function getClaudeCodeCommand(address: string): string {
  return `claude mcp add --scope user --transport http AgentShelf ${address}`;
}

export interface ConnectStep {
  number: number;
  title: string;
  detail: string;
}

// Three steps for each assistant: where to go, what to enter, how to use it in a chat.
export const CLAUDE_AI_STEPS: ConnectStep[] = [
  {
    number: 1,
    title: "Open Connectors",
    detail: "In claude.ai, open Customize, then Connectors",
  },
  {
    number: 2,
    title: "Add custom connector",
    detail:
      "Name it AgentShelf Buyer, paste the address ending in /mcp and choose No sign-in. In a Team or Enterprise workspace an owner may have to add it.",
  },
  {
    number: 3,
    title: "Switch it on in a chat",
    detail: "Press +, open Connectors and switch on AgentShelf Buyer",
  },
];

export const CHATGPT_STEPS: ConnectStep[] = [
  {
    number: 1,
    title: "Open Plugins",
    detail: "Open ChatGPT Plugins and click +",
  },
  {
    number: 2,
    title: "Add custom MCP server",
    detail:
      "Name it AgentShelf Buyer, paste the address ending in /mcp and choose No authentication. Your account or workspace may restrict this.",
  },
  {
    number: 3,
    title: "Pick it in a chat",
    detail: "Create as a plugin, install it, start a new chat, type @ and pick AgentShelf Buyer",
  },
];

// Any other agent that can use a remote MCP server.
export const AGENT_STEPS: ConnectStep[] = [
  {
    number: 1,
    title: "Add a remote MCP server",
    detail: "In your agent’s settings, add a server and choose Streamable HTTP",
  },
  {
    number: 2,
    title: "Paste the address",
    detail: "It needs no authentication, token or API key",
  },
  {
    number: 3,
    title: "Check the tools",
    detail: "It lists search_products, get_slots, book_slot, create_checkout and get_order_status",
  },
];

export const STEPS_BY_ASSISTANT: Record<Assistant, ConnectStep[]> = {
  claude: CLAUDE_AI_STEPS,
  chatgpt: CHATGPT_STEPS,
  agent: AGENT_STEPS,
};

// The short way in. Neither assistant has a link that fills its form in, so the nearest thing is to
// put the address on the clipboard and open the page where it is pasted.
export const QUICK_OPEN: Partial<Record<Assistant, { url: string; label: string; next: string }>> = {
  claude: {
    url: "https://claude.ai/customize/connectors",
    label: "Copy address and open Claude",
    next: "Claude opens on Connectors. Choose Add, then Add custom connector, and paste the address.",
  },
  chatgpt: {
    url: "https://chatgpt.com/plugins",
    label: "Copy address and open ChatGPT",
    next: "ChatGPT opens on Plugins. Click +, choose Add custom MCP server, and paste the address.",
  },
};

// A server entry in the shape many agents read from their settings file.
export function getAgentConfig(address: string): string {
  return JSON.stringify({ mcpServers: { agentshelf: { type: "http", url: address } } }, null, 2);
}

export interface PurchaseFlowStep {
  number: number;
  tool: string;
  title: string;
  description: string;
  note?: string;
}

export const PURCHASE_FLOW_STEPS: PurchaseFlowStep[] = [
  {
    number: 1,
    tool: "search_products",
    title: "Assistant searches catalog",
    description: "The buyer assistant finds the requested item across local workshops and catalogs.",
  },
  {
    number: 2,
    tool: "create_checkout",
    title: "Assistant initiates checkout",
    description: "The assistant calls create_checkout and returns a PayPal Sandbox approval link.",
    note: "Receiving the link does NOT complete the purchase. The order remains pending human payment approval.",
  },
  {
    number: 3,
    tool: "PayPal Sandbox",
    title: "Human confirms payment",
    description: "The buyer opens the approval link in their browser and confirms payment in PayPal Sandbox using a sandbox buyer account.",
  },
  {
    number: 4,
    tool: "get_order_status",
    title: "Assistant verifies order",
    description: "The assistant queries get_order_status to verify the payment is captured and the order status is paid.",
  },
];

export const REPAIR_SERVICES_DISTINCTION = {
  warning: "Services and repairs are NOT bought through create_checkout.",
  flow: "For repairs: get_slots → choose technician slot → book_slot → confirm booking deposit in PayPal Sandbox.",
  explanation:
    "Unlike physical inventory, repair services reserve a technician's working schedule. The assistant holds the requested slot and creates a deposit link before the appointment is confirmed.",
};

export async function copyToClipboard(
  text: string,
  targetEl?: HTMLElement | null,
): Promise<CopyState> {
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return "copied";
    } catch {
      // Fall through to fallback
    }
  }

  if (typeof document === "undefined" || typeof window === "undefined") {
    return "failed";
  }

  const selectTarget = (): boolean => {
    if (!targetEl) return false;
    try {
      const selection = window.getSelection();
      if (!selection) return false;
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(targetEl);
      selection.addRange(range);
      return selection.toString() === text;
    } catch {
      return false;
    }
  };

  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    if (document.execCommand("copy")) return "copied";
  } catch {
    // A failed legacy copy may still leave the visible text selectable.
  } finally {
    try {
      textarea?.remove();
    } catch {
      // Cleanup must not replace the copy status with an exception.
    }
  }

  return selectTarget() ? "selected" : "failed";
}
