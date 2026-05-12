import { describe, it, expect } from "vitest";

import { buildClosuresIcal } from "./build-ical";

describe("buildClosuresIcal", () => {
  it("renders BEGIN/END markers + a VEVENT per closure", () => {
    const ics = buildClosuresIcal({
      practiceName: "Test DME",
      closures: [
        {
          id: "c_1",
          label: "Thanksgiving",
          startsAt: "2026-11-26T00:00:00Z",
          endsAt: "2026-11-27T00:00:00Z",
          autoReplyMessage: "Closed for Thanksgiving.",
        },
      ],
      now: new Date("2026-05-01T00:00:00Z"),
    });
    expect(ics).toMatch(/^BEGIN:VCALENDAR/);
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:c_1@pennfit.app");
    expect(ics).toContain("DTSTART:20261126T000000Z");
    expect(ics).toContain("DTEND:20261127T000000Z");
    expect(ics).toContain("SUMMARY:Thanksgiving");
  });

  it("escapes commas and newlines in summary + description", () => {
    const ics = buildClosuresIcal({
      practiceName: "Test DME",
      closures: [
        {
          id: "c_1",
          label: "Weather, 2-day",
          startsAt: "2026-02-01T00:00:00Z",
          endsAt: "2026-02-03T00:00:00Z",
          autoReplyMessage: "Line one.\nLine two.",
        },
      ],
    });
    expect(ics).toContain("Weather\\, 2-day");
    expect(ics).toContain("Line one.\\nLine two.");
  });

  it("uses CRLF line endings", () => {
    const ics = buildClosuresIcal({
      practiceName: "Test DME",
      closures: [],
    });
    expect(ics.includes("\r\n")).toBe(true);
    expect(ics.endsWith("\r\n")).toBe(true);
  });
});
