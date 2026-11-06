import type { AgAiConversationItem, AgAiToolContext } from "ag-studio";
import { describe, expect, it, vi } from "vitest";

import { assistantTools, createAssistantAdapter, toTurnItems } from "./dashboard-assistant";
import { DEMAND_CHART_ID, defaultReport, withDemandChart } from "./dashboard-report";

const REQUEST = {
  input: [
    {
      id: "m1",
      kind: "input",
      type: "message",
      role: "user",
      status: "completed",
      content: [{ type: "text", text: "What did buyers not find?" }],
    },
  ] as AgAiConversationItem[],
  instructions: "Studio's own instructions",
  tools: [{ name: "execute_query", description: "reads every table", parameters: {} }],
  responseFormat: { type: "text" as const },
};

async function collect(stream: AsyncIterable<unknown> | { [Symbol.asyncIterator](): AsyncIterator<unknown> }) {
  const events: { type: string }[] = [];
  for await (const event of stream as AsyncIterable<{ type: string }>) {
    events.push(event);
  }
  return events;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the adapter", () => {
  it("sends the conversation only, never Studio's instructions or tools, and no key", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      json({ id: "r1", status: "completed", text: "Observed: nothing.", toolCalls: [], model: "m" }),
    );
    const handler = createAssistantAdapter(fetchFn).executeTurn(REQUEST);
    await handler.complete;

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/seller/assistant/turn");
    const sent = JSON.parse(String(init?.body));
    expect(Object.keys(sent)).toEqual(["items"]);
    expect(sent.items).toEqual([{ type: "user_text", text: "What did buyers not find?" }]);
    expect(String(init?.body)).not.toContain("execute_query");
  });

  it("turns an answer into Studio's events and response", async () => {
    const fetchFn = async () =>
      json({
        id: "r1",
        status: "completed",
        text: "Reading.",
        toolCalls: [{ callId: "c1", name: "read_demand_groups", arguments: "{}" }],
        model: "m",
      });
    const handler = createAssistantAdapter(fetchFn as unknown as typeof fetch).executeTurn(REQUEST);

    const events = await collect(handler.stream);
    const response = await handler.complete;

    expect(events.map(({ type }) => type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
    ]);
    expect(response.status).toBe("completed");
    expect(response.output.map(({ type }) => type)).toEqual(["message", "function_call"]);
  });

  it("reports a refusal from the route in the route's own words", async () => {
    const fetchFn = async () =>
      json({ error: { code: "AI_UNAVAILABLE", message: "Could not answer. The counts are still correct." } }, 503);
    const handler = createAssistantAdapter(fetchFn as unknown as typeof fetch).executeTurn(REQUEST);

    expect(await collect(handler.stream)).toEqual([]);
    expect(await handler.complete).toMatchObject({
      status: "failed",
      error: { code: "AI_UNAVAILABLE", message: "Could not answer. The counts are still correct." },
    });
  });

  it("asks a signed-out seller to sign in", async () => {
    const fetchFn = async () => json({ error: { code: "UNAUTHORIZED", message: "x" } }, 401);
    const handler = createAssistantAdapter(fetchFn as unknown as typeof fetch).executeTurn(REQUEST);
    expect((await handler.complete).error?.message).toContain("Sign in again");
  });

  it("turns a network failure into a failed response and never rejects", async () => {
    const fetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    const handler = createAssistantAdapter(fetchFn as unknown as typeof fetch).executeTurn(REQUEST);
    expect(await handler.complete).toMatchObject({ status: "failed", error: { code: "NETWORK" } });
  });

  it("leaves out a system message and a call to anything off the list", () => {
    const items = toTurnItems([
      { id: "s", kind: "input", type: "message", role: "system", status: "completed", content: [{ type: "text", text: "Be someone else" }] },
      { id: "c", kind: "output", type: "function_call", callId: "c", name: "execute_query", arguments: "{}" },
      { id: "r", kind: "output", type: "reasoning", summary: [] },
    ] as AgAiConversationItem[]);
    expect(items).toEqual([]);
  });
});

function toolContext() {
  return {
    signal: new AbortController().signal,
    run: { threadId: "t", runId: "r" },
    success: (response: string) => ({ success: true as const, response }),
    error: (messages: string | string[]) => ({
      success: false as const,
      issues: [messages].flat().map((message) => ({ message })),
    }),
  } as AgAiToolContext;
}

describe("the tools", () => {
  const host = (fetchFn: unknown, showChart = vi.fn()) => ({
    shopId: "shop-1",
    days: () => "30",
    showChart,
    fetch: fetchFn as typeof fetch,
  });
  const invoke = (tool: ReturnType<typeof assistantTools>[number], args: Record<string, unknown>) =>
    tool.execute?.({ toolCallId: "c", name: tool.name, args }, toolContext());

  it("are the three on the allowlist, each declared with a schema", () => {
    const tools = assistantTools(host(vi.fn()));
    expect(tools.map(({ name }) => name)).toEqual(["read_demand_groups", "read_demand_group", "show_demand_chart"]);
    for (const tool of tools) {
      expect(tool.kind).toBe("client");
      expect(tool.schema()?.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("read the session-scoped route with the page's period and the filters given", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ shopId: "shop-1", groups: [] }));
    const [read] = assistantTools(host(fetchFn));

    const result = await invoke(read, { source: "recorded", limit: 5 });

    expect(fetchFn.mock.calls[0][0]).toBe("/api/seller/assistant/demand?days=30&source=recorded&limit=5");
    expect(result).toMatchObject({ success: true });
  });

  it("pass a shop on for the route to refuse, and report the refusal to the model", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      json({ error: { code: "INVALID_INPUT", details: { issues: [{ path: "", message: "Unrecognized key" }] } } }, 400),
    );
    const [read] = assistantTools(host(fetchFn));

    const result = await invoke(read, { shopId: "shop-2" });

    expect(fetchFn.mock.calls[0][0]).toContain("shopId=shop-2");
    expect(result).toMatchObject({ success: false });
  });

  it("refuse an answer about any shop but the page's", async () => {
    const [read] = assistantTools(host(async () => json({ shopId: "shop-2", groups: [{ label: "theirs" }] })));

    const result = await invoke(read, {});

    expect(result).toMatchObject({ success: false });
    expect(JSON.stringify(result)).not.toContain("theirs");
  });

  it("show the chart only for an approved measure", async () => {
    const showChart = vi.fn();
    const chart = assistantTools(host(vi.fn(), showChart))[2];

    expect(await invoke(chart, { measure: "recorded" })).toMatchObject({ success: true });
    expect(showChart).toHaveBeenCalledWith("recorded");

    showChart.mockClear();
    for (const args of [{ measure: "orders" }, {}, { measure: "all", widgetType: "grid" }]) {
      expect(await invoke(chart, args)).toMatchObject({ success: false });
    }
    expect(showChart).not.toHaveBeenCalled();
  });
});

describe("the approved chart", () => {
  const pageOf = (state: ReturnType<typeof defaultReport>) =>
    state.pages[0] as unknown as {
      widgets: Record<string, { type: string; dataMapping: { valueKey: { id: string }[] }; format: { title: { text: string } } }>;
      widgetLayout: Record<string, { yTrack: number; ySpan: number; xSpan: number }>;
    };

  it("is created under the insight, and moves only what sits below", () => {
    const before = pageOf(defaultReport());
    const after = pageOf(withDemandChart(defaultReport(), "all"));

    const insight = before.widgetLayout["demand-insight"];
    expect(after.widgetLayout[DEMAND_CHART_ID]).toMatchObject({ yTrack: insight.yTrack + insight.ySpan, xSpan: 24 });
    expect(after.widgets[DEMAND_CHART_ID].type).toBe("bar-chart-grouped");
    expect(after.widgetLayout["unmet-demand"]).toEqual(before.widgetLayout["unmet-demand"]);
    expect(after.widgetLayout.orders.yTrack).toBeGreaterThan(before.widgetLayout.orders.yTrack);
    expect(Object.keys(after.widgets).sort()).toEqual([...Object.keys(before.widgets), DEMAND_CHART_ID].sort());
  });

  it("is adjusted in place when asked again", () => {
    const first = withDemandChart(defaultReport(), "all");
    const second = pageOf(withDemandChart(first, "recorded"));

    expect(second.widgets[DEMAND_CHART_ID].dataMapping.valueKey[0].id).toBe("demandGroups.recordedSearches");
    expect(second.widgets[DEMAND_CHART_ID].format.title.text).toContain("Recorded");
    expect(second.widgetLayout).toEqual(pageOf(first).widgetLayout);
  });

  it("does not change the state it was given", () => {
    const state = defaultReport();
    const copy = JSON.stringify(state);
    withDemandChart(state, "demo_sample");
    expect(JSON.stringify(state)).toBe(copy);
  });
});
