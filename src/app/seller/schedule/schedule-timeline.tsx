"use client";

import { BryntumScheduler } from "@bryntum/scheduler-react-community";
import { useMemo } from "react";

import "./schedule-timeline.css";

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
  detail: string;
  times: string;
};

const VIEW_PRESET = {
  base: "hourAndDay",
  tickWidth: 110,
  displayDateFormat: "HH:mm",
  headers: [{ unit: "hour", dateFormat: "HH:mm" }],
};

const COLUMNS = [
  { text: "Technician", field: "name", width: 120, sortable: false, enableCellContextMenu: false },
];

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
  return (
    <div className="schedule-timeline">
      <BryntumScheduler
        readOnly
        autoHeight
        startDate={start}
        endDate={end}
        viewPreset={VIEW_PRESET}
        rowHeight={84}
        barMargin={4}
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
          return {
            className: `booking-bar booking-state ${field("stateClass")}`,
            title: description,
            children: [
              { tag: "strong", text: field("label") },
              { tag: "span", text: field("name") },
              { tag: "span", className: "booking-bar-time", text: field("times") },
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
