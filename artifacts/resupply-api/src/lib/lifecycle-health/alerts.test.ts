// Alert generation AND suppression.
//
// Suppression is the half that decides whether this subsystem is worth
// having. Twelve scans a day over 27 signals can produce 324 messages
// per tenant per day; if it does that even once, everybody writes a
// filter rule and the monitor becomes decoration that people believe in.
//
// So these tests pin the count of notifications, not just their content.

import { describe, expect, it } from "vitest";

import {
  decideAlertAction,
  DEFAULT_RENOTIFY_HOURS,
  renotifyHours,
  RENOTIFY_HOURS_ENV,
  type OpenAlert,
} from "./alerts";
import type { SignalStatus } from "./evaluate";

const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function openAlert(overrides: Partial<OpenAlert> = {}): OpenAlert {
  return {
    id: "alert-1",
    signalKey: "shipped_unbilled",
    status: "warning",
    peakStatus: "warning",
    firstObservedAt: new Date(NOW - 6 * HOUR).toISOString(),
    lastObservedAt: new Date(NOW - HOUR).toISOString(),
    lastNotifiedAt: new Date(NOW - HOUR).toISOString(),
    lastNotifiedStatus: "warning",
    notifyCount: 1,
    observedValue: 12,
    ...overrides,
  };
}

function decide(
  status: SignalStatus,
  open: OpenAlert | null,
  hours = DEFAULT_RENOTIFY_HOURS,
) {
  return decideAlertAction({
    open,
    evaluation: { status, key: "shipped_unbilled" },
    nowMs: NOW,
    renotifyHours: hours,
  });
}

describe("generation", () => {
  it("opens and notifies on a brand-new warning", () => {
    const d = decide("warning", null);
    expect(d).toMatchObject({ action: "open", notify: true });
  });

  it("opens and notifies on a brand-new failure", () => {
    expect(decide("failure", null)).toMatchObject({
      action: "open",
      notify: true,
    });
  });

  it("escalates and notifies when a warning becomes a failure", () => {
    const d = decide("failure", openAlert({ status: "warning" }));
    expect(d).toMatchObject({ action: "escalate", notify: true });
  });

  it("escalates even inside the quiet window", () => {
    // Getting worse is news regardless of how recently we spoke. This is
    // the one case where the suppression window must not apply.
    const d = decide(
      "failure",
      openAlert({
        status: "warning",
        lastNotifiedAt: new Date(NOW - 60_000).toISOString(),
      }),
    );
    expect(d).toMatchObject({ action: "escalate", notify: true });
  });
});

describe("suppression", () => {
  it("says nothing about an unchanged alert reported an hour ago", () => {
    const d = decide("warning", openAlert());
    expect(d).toMatchObject({ action: "suppress", notify: false });
  });

  it("stays silent for the whole configured window", () => {
    for (const hoursAgo of [0, 1, 5, 12, 23]) {
      const d = decide(
        "warning",
        openAlert({
          lastNotifiedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
        }),
      );
      expect(d.notify, `${hoursAgo}h ago`).toBe(false);
    }
  });

  it("speaks again once the window elapses", () => {
    const d = decide(
      "warning",
      openAlert({ lastNotifiedAt: new Date(NOW - 25 * HOUR).toISOString() }),
    );
    expect(d).toMatchObject({ action: "renotify", notify: true });
  });

  it("honours a shortened window immediately", () => {
    // Read per call, not at module load, so raising or lowering it during
    // an incident takes effect on the next tick rather than the next
    // deploy.
    const d = decide(
      "warning",
      openAlert({ lastNotifiedAt: new Date(NOW - 3 * HOUR).toISOString() }),
      2,
    );
    expect(d.notify).toBe(true);
  });

  it("notifies an open alert nobody was ever told about", () => {
    // The send failed, or the row predates notification. Silence here
    // would make the failure permanent.
    const d = decide("warning", openAlert({ lastNotifiedAt: null }));
    expect(d).toMatchObject({ action: "renotify", notify: true });
  });

  it("notifies when the stored notification time is unparseable", () => {
    const d = decide("warning", openAlert({ lastNotifiedAt: "not-a-date" }));
    expect(d).toMatchObject({ action: "renotify", notify: true });
  });

  it("counts notifications over a simulated day of two-hourly scans", () => {
    // The number that matters. Twelve scans, one persistent problem.
    let last: string | null = null;
    let notifications = 0;
    for (let tick = 0; tick < 12; tick += 1) {
      const nowMs = NOW + tick * 2 * HOUR;
      const open: OpenAlert | null =
        tick === 0
          ? null
          : openAlert({ status: "failure", lastNotifiedAt: last });
      const d = decideAlertAction({
        open,
        evaluation: { status: "failure", key: "shipped_unbilled" },
        nowMs,
        renotifyHours: DEFAULT_RENOTIFY_HOURS,
      });
      if (d.notify) {
        notifications += 1;
        last = new Date(nowMs).toISOString();
      }
    }
    // One for the opening, and nothing else inside 24 hours.
    expect(notifications).toBe(1);
  });
});

describe("recovery", () => {
  it("resolves and notifies once when the signal comes back inside threshold", () => {
    const d = decide("ok", openAlert());
    expect(d).toMatchObject({ action: "resolve", notify: true });
  });

  it("resolves when the tenant turns the feature off", () => {
    // A positive statement about the system's shape, unlike a failed
    // read. Leaving an alert open against a feature that no longer
    // exists is a permanent unfixable row.
    const d = decide("disabled", openAlert());
    expect(d.action).toBe("resolve");
  });

  it("resolves when the integration is removed", () => {
    expect(decide("not_configured", openAlert()).action).toBe("resolve");
  });

  it("says nothing when a healthy signal stays healthy", () => {
    expect(decide("ok", null)).toMatchObject({ action: "none", notify: false });
  });

  it("goes quiet — not silent-and-closed — when a failure improves to a warning", () => {
    // Nobody needs an email saying a fire is now a smaller fire, and the
    // alert must stay OPEN so the peak is still visible on arrival.
    const d = decide("warning", openAlert({ status: "failure" }));
    expect(d).toMatchObject({ action: "deescalate", notify: false });
  });
});

describe("an unreadable signal is not a healthy one", () => {
  it("NEVER resolves an open alert on a failed read", () => {
    // The single most dangerous shortcut available here: a database
    // hiccup would clear the whole board and send recovery notices
    // saying every problem had gone away.
    const d = decide("unknown", openAlert({ status: "failure" }));
    expect(d.action).toBe("none");
    expect(d.notify).toBe(false);
    expect(d.reason).toMatch(/stands rather than being closed/i);
  });

  it("does not open an alert for an unreadable signal either", () => {
    // The `analytics_window_truncated` and unknown-status signals are
    // how an outage in the monitor itself surfaces; opening a business
    // alert would blame the wrong thing.
    expect(decide("unknown", null).action).toBe("none");
  });
});

describe("the quiet window is configurable", () => {
  it("defaults to a day", () => {
    expect(renotifyHours({})).toBe(DEFAULT_RENOTIFY_HOURS);
  });

  it("takes a valid override", () => {
    expect(renotifyHours({ [RENOTIFY_HOURS_ENV]: "6" })).toBe(6);
  });

  it.each(["0", "-1", "abc", ""])("ignores %o and keeps the default", (raw) => {
    expect(renotifyHours({ [RENOTIFY_HOURS_ENV]: raw })).toBe(
      DEFAULT_RENOTIFY_HOURS,
    );
  });
});
