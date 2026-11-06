"use client";

import type {
  AgDataSourcesDefinition,
  AgPanelConfig,
  AgReportState,
  AgResponsiveLayoutBreakpoint,
  AgStudioApi,
  AgStudioMode,
  AgStudioModule,
} from "ag-studio";
import {
  AgStudio,
  AgStudioProvider,
  createWidgets,
  type AgWidgetCustomCellRendererProps,
  type AgWidgetDefinition,
} from "ag-studio-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  PAYMENT_STATUS_WIDGET,
  UNMET_DEMAND_WIDGET,
  UPCOMING_BOOKINGS_WIDGET,
  defaultReport,
  loadSavedLayout,
  saveLayout,
} from "./dashboard-report";
import { openOrderDetails } from "./dashboard-store";
import { agentShelfTheme } from "./dashboard-theme";
import { PaymentStatusWidget, UnmetDemandWidget, UpcomingBookingsWidget } from "./dashboard-widgets";

// AG Studio itself. The page around it owns the data and the session. Everything Studio is told
// about AgentShelf is here, in dashboard-report.ts and in dashboard-data.ts.

// The place for the seller's assistant. Register AgStudioAiModule here, pass its harness to the `ai`
// property below, and add "ai" to the edit panels. Nothing on this page is an assistant yet.
const STUDIO_MODULES: AgStudioModule[] = [];

const PANELS: AgPanelConfig = {
  view: {},
  edit: { left: ["data"], right: ["edit", "filters"] },
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

export default function DashboardStudio({
  licenseKey,
  shopId,
  data,
  mode,
  onApi,
}: {
  licenseKey: string | undefined;
  shopId: string;
  data: AgDataSourcesDefinition;
  mode: AgStudioMode;
  onApi: (api: AgStudioApi) => void;
}) {
  const [initialState] = useState<AgReportState>(() => loadSavedLayout(shopId) ?? defaultReport());
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
        panels={PANELS}
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
