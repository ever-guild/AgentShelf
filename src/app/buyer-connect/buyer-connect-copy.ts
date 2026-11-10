export type Assistant = "claude" | "chatgpt";
export type ClaudeMode = "web" | "cli";
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

export const CLAUDE_AI_STEPS: ConnectStep[] = [
  {
    number: 1,
    title: "Open Settings",
    detail: "In claude.ai, click your profile menu at the bottom-left and select Settings.",
  },
  {
    number: 2,
    title: "Navigate to Connectors",
    detail: "Under Customize, select Connectors, then click Add custom connector. Team or Enterprise workspaces may require an organization owner to add it.",
  },
  {
    number: 3,
    title: "Enter MCP Server Details",
    detail: "Name: AgentShelf Buyer · URL: your connector address · Authentication: No sign-in. Public MCP URL must end in /mcp.",
  },
  {
    number: 4,
    title: "Enable in Chat",
    detail: "In any chat, click the + button, open Connectors, and toggle on AgentShelf Buyer.",
  },
];

export const CHATGPT_STEPS: ConnectStep[] = [
  {
    number: 1,
    title: "Open Settings",
    detail: "In ChatGPT, open Settings from your account profile menu.",
  },
  {
    number: 2,
    title: "Add Custom MCP Server",
    detail: "Open ChatGPT Plugins, click +, then choose Add custom MCP server. Account or workspace policy may restrict access.",
  },
  {
    number: 3,
    title: "Enter MCP Server Details",
    detail: "Name: AgentShelf Buyer · URL: your connector address ending in /mcp · Authentication: No authentication.",
  },
  {
    number: 4,
    title: "Select in Chat",
    detail: "Create as a plugin, install it, start a new chat, type @, and select the installed AgentShelf Buyer plugin.",
  },
];

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
