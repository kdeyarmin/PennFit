import { describe, expect, it } from "vitest";

import {
  CLOSED_REASONS_BY_STATUS,
  EPISODE_CLOSED_REASONS,
  EPISODE_CLOSED_REASON_LABEL,
  EPISODE_STATUSES,
  EPISODE_STATUS_LABEL,
  FULFILLMENT_CANCELLED,
  IN_PROGRESS_EPISODE_STATUSES,
  OPEN_EPISODE_STATUSES,
  OUTREACH_OPEN_EPISODE_STATUSES,
  TERMINAL_EPISODE_STATUSES,
  buildEpisodeClosure,
  isEpisodeStatus,
  isInProgressEpisodeStatus,
  isOutreachOpenEpisodeStatus,
  isTerminalEpisodeStatus,
  type EpisodeClosedReason,
  type TerminalEpisodeStatus,
} from "./episode-status";

describe("episode status vocabulary", () => {
  it("keeps every subset inside the full vocabulary", () => {
    for (const list of [
      IN_PROGRESS_EPISODE_STATUSES,
      OUTREACH_OPEN_EPISODE_STATUSES,
      OPEN_EPISODE_STATUSES,
      TERMINAL_EPISODE_STATUSES,
    ]) {
      for (const s of list) {
        expect(EPISODE_STATUSES).toContain(s);
      }
    }
  });

  it("never lets a terminal status back into the reminder ladder", () => {
    for (const s of TERMINAL_EPISODE_STATUSES) {
      expect(isInProgressEpisodeStatus(s)).toBe(false);
      expect(isOutreachOpenEpisodeStatus(s)).toBe(false);
    }
  });

  it("keeps address_hold out of the ladder but inside the open set", () => {
    // The whole point of the status: the cycle is alive (so we must not
    // open a duplicate) but silent (so we stop nagging about an order we
    // just told the patient is on hold).
    expect(isInProgressEpisodeStatus("address_hold")).toBe(false);
    expect(isOutreachOpenEpisodeStatus("address_hold")).toBe(true);
    expect(isTerminalEpisodeStatus("address_hold")).toBe(false);
  });

  it("excludes confirmed from the outreach-open set", () => {
    // Including it would make the confirm path's next-cycle open a silent
    // no-op, which is exactly the one-shot-automation bug.
    expect(isOutreachOpenEpisodeStatus("confirmed")).toBe(false);
    expect(OPEN_EPISODE_STATUSES).toContain("confirmed");
  });

  it("treats an unrecognised status as not-in-progress", () => {
    for (const bogus of ["", "pending", "approved", "COMPLETED", "resolved"]) {
      expect(isInProgressEpisodeStatus(bogus)).toBe(false);
      expect(isOutreachOpenEpisodeStatus(bogus)).toBe(false);
      expect(isEpisodeStatus(bogus)).toBe(false);
    }
    expect(isInProgressEpisodeStatus(null)).toBe(false);
    expect(isInProgressEpisodeStatus(undefined)).toBe(false);
  });

  it("labels every status and every reason", () => {
    for (const s of EPISODE_STATUSES) {
      expect(EPISODE_STATUS_LABEL[s]).toBeTruthy();
    }
    for (const r of EPISODE_CLOSED_REASONS) {
      expect(EPISODE_CLOSED_REASON_LABEL[r]).toBeTruthy();
    }
  });
});

describe("closed-reason pairing", () => {
  it("assigns every reason to exactly one terminal status", () => {
    const seen = new Map<EpisodeClosedReason, TerminalEpisodeStatus[]>();
    for (const status of TERMINAL_EPISODE_STATUSES) {
      for (const reason of CLOSED_REASONS_BY_STATUS[status]) {
        seen.set(reason, [...(seen.get(reason) ?? []), status]);
      }
    }
    for (const reason of EPISODE_CLOSED_REASONS) {
      expect(seen.get(reason), `reason "${reason}" has no status`).toHaveLength(
        1,
      );
    }
    expect(seen.size).toBe(EPISODE_CLOSED_REASONS.length);
  });

  it("gives every terminal status at least one reason", () => {
    for (const status of TERMINAL_EPISODE_STATUSES) {
      expect(CLOSED_REASONS_BY_STATUS[status].length).toBeGreaterThan(0);
    }
  });

  it("builds a closure for a legal pair", () => {
    const at = new Date("2026-03-04T05:06:07.000Z");
    expect(buildEpisodeClosure("fulfilled", "shipped", at)).toEqual({
      status: "fulfilled",
      closed_reason: "shipped",
      closed_at: "2026-03-04T05:06:07.000Z",
    });
  });

  it("throws on a mis-paired status and reason", () => {
    // An opt-out folded into `declined` would destroy the decline rate as
    // a signal, so the pairing is a hard error rather than a convention.
    expect(() =>
      buildEpisodeClosure("declined", "patient_opted_out", new Date()),
    ).toThrow(/not valid for status "declined"/);
    expect(() =>
      buildEpisodeClosure("expired", "shipped", new Date()),
    ).toThrow();
  });

  it("separates a confirmed ship from an assumed one", () => {
    // The grace sweep must never claim real shipment evidence: that date
    // becomes the date of service on an 837P.
    expect(CLOSED_REASONS_BY_STATUS.fulfilled).toContain("shipped");
    expect(CLOSED_REASONS_BY_STATUS.fulfilled).toContain("assumed_shipped");
    expect(new Set(CLOSED_REASONS_BY_STATUS.fulfilled).size).toBe(2);
  });
});

describe("fulfillment status spelling", () => {
  it("pins the double-L cancelled spelling the cadence filters use", () => {
    // worker/jobs/reminders.ts and lib/entitlement/resolve-sku-entitlement.ts
    // both exclude dispenses with `.neq("status", "cancelled")`. A single-L
    // write slips past both and is counted as a real dispense, silently
    // suppressing the patient's next resupply reminder.
    expect(FULFILLMENT_CANCELLED).toBe("cancelled");
  });
});
