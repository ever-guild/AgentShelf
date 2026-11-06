"use client";

import {
  AgStudioAiModule,
  createAiHarness,
  directLlmRunner,
  type AgAiHarnessSetup,
  type AgDataSourcesDefinition,
  type AgPanelConfig,
  type AgReportState,
  type AgResponsiveLayoutBreakpoint,
  type AgStudioApi,
  type AgStudioMode,
  type AgStudioModule,
} from "ag-studio";
import {
  AgStudio,
  AgStudioProvider,
  createWidgets,
  type AgWidgetCustomCellRendererProps,
  type AgWidgetDefinition,
} from "ag-studio-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ASSISTANT_STARTERS, assistantTools, createAssistantAdapter } from "./dashboard-assistant";
import {
  DEMAND_INSIGHT_WIDGET,
  PAYMENT_STATUS_WIDGET,
  UNMET_DEMAND_WIDGET,
  UPCOMING_BOOKINGS_WIDGET,
  defaultReport,
  loadSavedLayout,
  saveLayout,
  withDemandChart,
} from "./dashboard-report";
import { getDashboardState, openOrderDetails } from "./dashboard-store";
import { agentShelfTheme } from "./dashboard-theme";
import { DemandInsightWidget, PaymentStatusWidget, UnmetDemandWidget, UpcomingBookingsWidget } from "./dashboard-widgets";

// AG Studio itself. The page around it owns the data and the session. Everything Studio is told
// about AgentShelf is here, in dashboard-report.ts and in dashboard-data.ts.

const STUDIO_MODULES: AgStudioModule[] = [AgStudioAiModule];

const PANELS: AgPanelConfig = {
  view: {},
  edit: { left: ["data"], right: ["edit", "filters"] },
};

// Studio offers its chat panel only in edit mode, so asking opens that mode with this panel alone.
const ASKING_PANELS: AgPanelConfig = {
  view: {},
  edit: { left: ["ai"] },
};

// A phone gets one column in the order the dashboard was laid out, with each widget tall enough
// to read.
const BREAKPOINTS: AgResponsiveLayoutBreakpoint[] = [
  {
    maxWidth: 760,
    layout: (layouts, { columns }) => {
      const order = layouts
        .map(({ layout }, index) => ({ layout, index }))
        .sort((a, b) => a.layout.yTrack - b.layout.yTrack || a.layout.xTrack - b.layout.xTrack);
      const placed = new Array(layouts.length);
      let yTrack = 0;
      for (const { layout, index } of order) {
        placed[index] = { xTrack: 0, yTrack, xSpan: columns, ySpan: layout.ySpan };
        yTrack += layout.ySpan;
      }
      return placed;
    },
  },
];

// The first column of the orders grid opens the order. A button, so a keyboard reaches it.
function OrderLink(props: AgWidgetCustomCellRendererProps) {
  const orderId = props.getLinkedValue({ id: "orders.orderId", aggregation: "first" });
  return (
    <button
      type="button"
      className="grid-order-link"
      aria-label={`Open order ${String(props.value)}`}
      onClick={() => typeof orderId === "string" && openOrderDetails(orderId)}
    >
      {String(props.value)}
    </button>
  );
}

function customWidget(
  id: string,
  label: string,
  comp: AgWidgetDefinition["comp"],
  extraMapping: AgWidgetDefinition["dataMapping"] = {},
): AgWidgetDefinition {
  return {
    id,
    label,
    comp,
    defaultSize: { width: 12, height: 20 },
    minSize: { width: 6, height: 8 },
    dataMapping: {
      fields: { type: "fieldset", supportedRoles: ["category", "numeric", "temporal"], required: true },
      ...extraMapping,
    },
    form: ({ createDefaults }) => createDefaults({}),
    toolbar: [],
  };
}

const WIDGETS = createWidgets({
  additionalTypes: [
    customWidget(PAYMENT_STATUS_WIDGET, "Payment status", PaymentStatusWidget, {
      orderGroup: { type: "field", supportedRoles: ["category"] },
    }),
    customWidget(UPCOMING_BOOKINGS_WIDGET, "Upcoming bookings", UpcomingBookingsWidget),
    customWidget(UNMET_DEMAND_WIDGET, "Unmet demand", UnmetDemandWidget),
    customWidget(DEMAND_INSIGHT_WIDGET, "Demand insight", DemandInsightWidget),
  ],
  overrides: [
    {
      id: "grid",
      options: {
        createCellRenderer: (field: { fieldId: string }) =>
          field.fieldId === "orders.reference" ? OrderLink : undefined,
        getLinkedFields: (field: { fieldId: string }) =>
          field.fieldId === "orders.reference" ? [{ id: "orders.orderId", aggregation: "first" }] : undefined,
      },
    },
  ],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Studio's registry generics do not accept custom IDs without a registry type of their own.
} as any);

const LOCALE_TEXT = { widgetOverlayNoData: "Nothing here in this period" };

const SAVE_DELAY_MS = 800;

// One agent and three tools. Studio's built-in agents are left out, because their tools can read
// every table on the page and change any widget. There is no history store, so a conversation ends
// with the page and no search text is kept in the browser.
function assistantSetup(shopId: string): AgAiHarnessSetup {
  const adapter = createAssistantAdapter();
  return ({ api }) => {
    const studio = api as AgStudioApi;
    const tools = assistantTools({
      shopId,
      days: () => String(getDashboardState().data.insights?.periodDays ?? 30),
      showChart: (measure) => studio.setState(withDemandChart(studio.getState(), measure)),
    });
    return createAiHarness(studio, () => ({
      agents: [
        directLlmRunner({
          id: "demand",
          name: "Demand assistant",
          description: "Answers questions about what buyers could not find in this shop.",
          adapter,
          tools: () => tools,
          maxTurns: 6,
        }),
      ],
      primary: "demand",
      promptStarters: ASSISTANT_STARTERS,
    }));
  };
}

export default function DashboardStudio({
  licenseKey,
  shopId,
  data,
  mode,
  asking,
  onApi,
}: {
  licenseKey: string | undefined;
  shopId: string;
  data: AgDataSourcesDefinition;
  mode: AgStudioMode;
  asking: boolean;
  onApi: (api: AgStudioApi) => void;
}) {
  const [initialState] = useState<AgReportState>(() => loadSavedLayout(shopId) ?? defaultReport());
  const ai = useMemo(() => assistantSetup(shopId), [shopId]);
  const apiRef = useRef<AgStudioApi | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Only a seller's own change is worth keeping. A filter click changes state too, but
  // saveLayout keeps none of that.
  const onStateUpdated = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const api = apiRef.current;
      if (api) {
        saveLayout(shopId, api.getState());
      }
    }, SAVE_DELAY_MS);
  }, [shopId]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  return (
    <AgStudioProvider licenseKey={licenseKey} modules={STUDIO_MODULES}>
      <AgStudio
        data={data}
        mode={mode}
        theme={agentShelfTheme}
        widgets={WIDGETS}
        panels={asking ? ASKING_PANELS : PANELS}
        ai={ai}
        initialState={initialState}
        responsiveLayoutBreakpoints={BREAKPOINTS}
        localeText={LOCALE_TEXT}
        onApiReady={(event) => {
          apiRef.current = event.api as AgStudioApi;
          onApi(event.api as AgStudioApi);
        }}
        onStateUpdated={onStateUpdated}
      />
    </AgStudioProvider>
  );
}
