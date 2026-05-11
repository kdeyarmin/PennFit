// Pure-function tests for the Phase B dispatch helpers.

import { describe, it, expect } from "vitest";

import {
  CAMPAIGN_TRANSITIONS,
  TICKS_PER_MINUTE,
  TICK_INTERVAL_SECONDS,
  batchSizeForThrottle,
  customArgsFor,
  isLegalCampaignTransition,
  type CampaignStatus,
} from "./dispatch-helpers";

describe("batchSizeForThrottle", () => {
  it("floors at 1 even for sub-minimum throttles", () => {
    expect(batchSizeForThrottle(0)).toBe(1);
    expect(batchSizeForThrottle(-50)).toBe(1);
    expect(batchSizeForThrottle(NaN)).toBe(1);
    expect(batchSizeForThrottle(1)).toBe(1);
  });

  it("scales linearly with throttle", () => {
    // TICKS_PER_MINUTE=6 ⇒ batchSize = ceil(throttle / 6)
    expect(batchSizeForThrottle(6)).toBe(1);
    expect(batchSizeForThrottle(60)).toBe(10);
    expect(batchSizeForThrottle(120)).toBe(20);
    expect(batchSizeForThrottle(600)).toBe(100);
    expect(batchSizeForThrottle(3600)).toBe(600);
  });

  it("rounds up so a throttle of 7 sends 2 per tick (12/min effective)", () => {
    // Better to slightly over-send than under-send when the
    // throttle isn't a clean multiple of TICKS_PER_MINUTE — keeps
    // the campaign from stalling on small audiences.
    expect(batchSizeForThrottle(7)).toBe(2);
    expect(batchSizeForThrottle(11)).toBe(2);
  });

  it("TICK_INTERVAL_SECONDS × TICKS_PER_MINUTE = 60", () => {
    // Sanity: the tick cadence and the rate-limit conversion stay
    // in sync if anyone tweaks one of the constants.
    expect(TICK_INTERVAL_SECONDS * TICKS_PER_MINUTE).toBe(60);
  });
});

describe("isLegalCampaignTransition", () => {
  it("allows same-status no-ops", () => {
    expect(isLegalCampaignTransition("draft", "draft")).toBe(true);
    expect(isLegalCampaignTransition("sending", "sending")).toBe(true);
    expect(isLegalCampaignTransition("paused", "paused")).toBe(true);
  });

  it("matches the documented state machine", () => {
    // draft → sending | cancelled
    expect(isLegalCampaignTransition("draft", "sending")).toBe(true);
    expect(isLegalCampaignTransition("draft", "cancelled")).toBe(true);
    expect(isLegalCampaignTransition("draft", "paused")).toBe(false);
    expect(isLegalCampaignTransition("draft", "sent")).toBe(false);

    // sending → sent | paused | cancelled
    expect(isLegalCampaignTransition("sending", "sent")).toBe(true);
    expect(isLegalCampaignTransition("sending", "paused")).toBe(true);
    expect(isLegalCampaignTransition("sending", "cancelled")).toBe(true);
    expect(isLegalCampaignTransition("sending", "draft")).toBe(false);

    // paused → sending | cancelled
    expect(isLegalCampaignTransition("paused", "sending")).toBe(true);
    expect(isLegalCampaignTransition("paused", "cancelled")).toBe(true);
    expect(isLegalCampaignTransition("paused", "sent")).toBe(false);

    // sent + cancelled terminal
    for (const to of [
      "draft",
      "sending",
      "paused",
      "cancelled",
    ] as CampaignStatus[]) {
      expect(isLegalCampaignTransition("sent", to)).toBe(false);
    }
    for (const to of [
      "draft",
      "sending",
      "paused",
      "sent",
    ] as CampaignStatus[]) {
      expect(isLegalCampaignTransition("cancelled", to)).toBe(false);
    }
  });

  it("covers every documented status in the transition map", () => {
    const statuses: CampaignStatus[] = [
      "draft",
      "sending",
      "sent",
      "paused",
      "cancelled",
    ];
    for (const s of statuses) {
      expect(CAMPAIGN_TRANSITIONS[s]).toBeDefined();
    }
  });
});

describe("customArgsFor", () => {
  it("produces the SendGrid event-correlation envelope", () => {
    expect(
      customArgsFor(
        "00000000-0000-0000-0000-0000000000aa",
        "00000000-0000-0000-0000-0000000000bb",
      ),
    ).toEqual({
      bulk_campaign_id: "00000000-0000-0000-0000-0000000000aa",
      bulk_campaign_recipient_id: "00000000-0000-0000-0000-0000000000bb",
    });
  });
});
