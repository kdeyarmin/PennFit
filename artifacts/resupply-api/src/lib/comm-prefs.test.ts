// Tests for the hard TCPA SMS send-window gate (app-review
// 2026-06-10, P1-3). Pure time/timezone math — no DB.

import { describe, expect, it } from "vitest";

import { isOutsideSmsSendWindow } from "./comm-prefs";

describe("isOutsideSmsSendWindow", () => {
  it("allows mid-afternoon ET (the 19:xx UTC cron slot)", () => {
    // 19:43 UTC = 15:43 ET in June (EDT).
    expect(
      isOutsideSmsSendWindow(new Date("2026-06-10T19:43:00Z"), {
        timezone: "America/New_York",
      }),
    ).toBe(false);
  });

  it("blocks ~midnight ET (the old 04:43 UTC cron slot)", () => {
    expect(
      isOutsideSmsSendWindow(new Date("2026-06-10T04:43:00Z"), {
        timezone: "America/New_York",
      }),
    ).toBe(true);
  });

  it("is half-open: 9am local allowed, 8pm local blocked", () => {
    // 13:00 UTC = 09:00 EDT — first allowed hour.
    expect(
      isOutsideSmsSendWindow(new Date("2026-06-10T13:00:00Z"), {
        timezone: "America/New_York",
      }),
    ).toBe(false);
    // 00:00 UTC = 20:00 EDT — first blocked hour.
    expect(
      isOutsideSmsSendWindow(new Date("2026-06-11T00:00:00Z"), {
        timezone: "America/New_York",
      }),
    ).toBe(true);
  });

  it("evaluates in the patient's timezone, not the practice's", () => {
    // 14:00 UTC = 10:00 EDT (inside) but 07:00 PDT (outside).
    const at = new Date("2026-06-10T14:00:00Z");
    expect(isOutsideSmsSendWindow(at, { timezone: "America/New_York" })).toBe(
      false,
    );
    expect(
      isOutsideSmsSendWindow(at, { timezone: "America/Los_Angeles" }),
    ).toBe(true);
  });

  it("prefers the explicit timezone over the ZIP", () => {
    const at = new Date("2026-06-10T14:00:00Z"); // 7am PT / 10am ET
    expect(
      isOutsideSmsSendWindow(at, {
        timezone: "America/Los_Angeles",
        shippingZip: "15201", // Pittsburgh — would be allowed
      }),
    ).toBe(true);
  });

  it("falls back to America/New_York when no timezone or ZIP is known", () => {
    // 17:00 UTC = 1pm ET — inside.
    expect(isOutsideSmsSendWindow(new Date("2026-06-10T17:00:00Z"))).toBe(
      false,
    );
    // 04:00 UTC = midnight ET — outside.
    expect(isOutsideSmsSendWindow(new Date("2026-06-10T04:00:00Z"))).toBe(true);
  });

  it("falls back to ET on an unrecognized timezone string", () => {
    expect(
      isOutsideSmsSendWindow(new Date("2026-06-10T17:00:00Z"), {
        timezone: "Not/AZone",
      }),
    ).toBe(false);
    expect(
      isOutsideSmsSendWindow(new Date("2026-06-10T04:00:00Z"), {
        timezone: "Not/AZone",
      }),
    ).toBe(true);
  });
});
