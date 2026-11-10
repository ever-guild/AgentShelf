export type Assistant = "claude" | "chatgpt";
export type ClaudeMode = "web" | "cli";
export type CopyState = "idle" | "copied" | "selected";

export const COPY_STATUS_TEXT: Record<CopyState, string> = {
  idle: "",
  copied: "Copied",
  selected: "Selected. Press Ctrl or Cmd and C to copy",
};

export const PROMPT_SEARCH =
  "Find an iPhone 13 screen protector in Liepaja. Use only AgentShelf Buyer; do not search the web or book/order.";

export const PROMPT_PURCHASE =
  "I want to buy the tempered glass for iPhone 13 from Liepāja Phone Workshop for €9.90. Please call create_checkout on AgentShelf Buyer to get my PayPal Sandbox payment link.";

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
    detail: "Under Customize, select Connectors, then click Add custom connector.",
  },
  {
    number: 3,
    title: "Enter MCP Server Details",
    detail: "Name: AgentShelf Buyer · URL: your connector address · Authentication: No sign-in.",
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
    detail: "Go to Apps / Developer mode and click Add custom MCP server.",
  },
  {
    number: 3,
    title: "Enter MCP Server Details",
    detail: "Name: AgentShelf Buyer · URL: your connector address · Authentication: No authentication.",
  },
  {
    number: 4,
    title: "Select in Chat",
    detail: "In any chat, select @AgentShelf from the connector list to enable tools.",
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

  if (typeof window !== "undefined") {
    if (targetEl) {
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(targetEl);
        selection.addRange(range);
      }
    }

    try {
      if (typeof document !== "undefined") {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "absolute";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        const successful = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (successful) {
          return "copied";
        }
      }
    } catch {
      // ignore
    }
  }

  return "selected";
}
