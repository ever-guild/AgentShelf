"use client";

import { BryntumScheduler } from "@bryntum/scheduler-react-community";
import { useEffect, useMemo, useState } from "react";

import "./schedule-timeline.css";
import { BAR_MARGIN_PX, ROW_HEIGHT_PX, fitBarState } from "./timeline-size";

// The Bryntum view of a day. It is read-only: nothing here can write, and every way of moving or
// creating an event is switched off, so no gesture can look like a booking that does not exist.
// Service titles come from a shop's price list, so they reach the page only as text nodes.

export type TimelineBooking = {
  id: string;
  resourceId: string;
  // Shop wall clock with no offset. Community has no timezone setting.
  startDate: string;
  endDate: string;
  name: string;
  stateClass: string;
  label: string;
  // What the bar itself may say for the state, longest first, for a bar too short for the label.
  barForms: string[];
  detail: string;
  // When it starts, which is all a short bar has room for. Where it ends shows on the axis.
  start: string;
  times: string;
};

// An hour's label sits at its own line on the axis, so a bar lines up with the time it starts.
const VIEW_PRESET = {
  base: "hourAndDay",
  tickWidth: 110,
  displayDateFormat: "HH:mm",
  headers: [{ unit: "hour", dateFormat: "HH:mm", align: "start" as const }],
};

const COLUMNS = [
  { text: "Technician", field: "name", width: 104, sortable: false, enableCellContextMenu: false },
];

// The state line's type as schedule-timeline.css sets it, so a word is measured as it is drawn.
const STATE_FONT = "500 12px";
const stateWidths = new Map<string, number>();
let pen: CanvasRenderingContext2D | null | undefined;

function measureState(text: string): number {
  let width = stateWidths.get(text);
  if (width === undefined) {
    if (pen === undefined) {
      pen = document.createElement("canvas").getContext("2d");
      if (pen) {
        pen.font = `${STATE_FONT} ${getComputedStyle(document.body).fontFamily}`;
      }
    }
    // Rounded up, so a word that fits only by a fraction still fits once drawn. With no canvas, a
    // generous guess per letter keeps words whole.
    width = pen ? Math.ceil(pen.measureText(text).width) : text.length * 9;
    stateWidths.set(text, width);
  }
  return width;
}

export default function ScheduleTimeline({
  start,
  end,
  techniciansJson,
  bookingsJson,
}: {
  start: string;
  end: string;
  techniciansJson: string;
  bookingsJson: string;
}) {
  const technicians = useMemo(
    () => JSON.parse(techniciansJson) as { id: string; name: string }[],
    [techniciansJson],
  );
  const bookings = useMemo(() => JSON.parse(bookingsJson) as TimelineBooking[], [bookingsJson]);
  // Words are measured in the page's own font, so the bars wait for it rather than fit a stand-in.
  const [fontsReady, setFontsReady] = useState(() => document.fonts.status === "loaded");
  useEffect(() => {
    let current = true;
    void document.fonts.ready.then(() => {
      if (current) {
        setFontsReady(true);
      }
    });
    return () => {
      current = false;
    };
  }, []);
  if (!fontsReady) {
    return null;
  }
  return (
    <div className="schedule-timeline">
      <BryntumScheduler
        readOnly
        autoHeight
        startDate={start}
        endDate={end}
        viewPreset={VIEW_PRESET}
        rowHeight={ROW_HEIGHT_PX}
        barMargin={BAR_MARGIN_PX}
        eventLayout="stack"
        columns={COLUMNS}
        resources={technicians}
        events={bookings}
        zoomOnMouseWheel={false}
        zoomOnTimeAxisDoubleClick={false}
        eventRenderer={({ eventRecord, renderData }) => {
          const field = (name: string) => String(eventRecord.get(name) ?? "");
          const description = `${field("label")}. ${field("times")}. ${field("name")}. ${field("detail")}`;
          renderData.ariaLabel = description;
          // Bryntum gives the bar's width here, and renders again whenever the axis is resized.
          const state = fitBarState(
            (eventRecord.get("barForms") as string[] | undefined) ?? [field("label")],
            renderData.width,
            measureState,
          );
          const shape = [
            state.narrow ? "booking-bar-narrow" : "",
            state.lines.length > 1 ? "booking-bar-long-state" : "",
          ].join(" ");
          return {
            className: `booking-bar booking-state ${field("stateClass")} ${shape}`,
            title: description,
            children: [
              { tag: "span", className: "booking-bar-time", text: field("start") },
              { tag: "span", className: "booking-bar-name", text: field("name") },
              ...(state.lines.length > 0
                ? [
                    {
                      tag: "span",
                      className: "booking-bar-state",
                      children: state.lines.map((line) => ({ tag: "span", text: line })),
                    },
                  ]
                : []),
            ],
          };
        }}
        cellEditFeature={false}
        cellMenuFeature={false}
        columnReorderFeature={false}
        columnResizeFeature={false}
        eventDragFeature={false}
        eventDragCreateFeature={false}
        eventEditFeature={false}
        eventMenuFeature={false}
        eventResizeFeature={false}
        eventTooltipFeature={false}
        headerMenuFeature={false}
        scheduleMenuFeature={false}
        scheduleTooltipFeature={false}
        sortFeature={false}
        timeAxisHeaderMenuFeature={false}
      />
    </div>
  );
}
