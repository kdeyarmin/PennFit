import { describe, expect, it } from "vitest";

import { buildInsuranceDueDigest, daysUntilDue } from "./insurance-due-digest";

const NOW = new Date("2026-08-27T15:00:00.000Z");

describe("daysUntilDue", () => {
  it("returns 0 for today", () => {
    expect(daysUntilDue("2026-08-27T08:00:00.000Z", NOW)).toBe(0);
  });

  it("returns positive whole days for a future due date", () => {
    expect(daysUntilDue("2026-08-30T12:00:00.000Z", NOW)).toBe(3);
  });

  it("returns negative for overdue", () => {
    expect(daysUntilDue("2026-08-25T12:00:00.000Z", NOW)).toBe(-2);
  });
});

describe("buildInsuranceDueDigest", () => {
  const skus = new Map([
    ["rx_mask", "MASK-NASAL-M"],
    ["rx_filter", "FILTER-DISP-2"],
  ]);

  it("returns empty when there are no episodes", () => {
    expect(buildInsuranceDueDigest([], skus, NOW)).toEqual({
      nextShipment: null,
      eligibility: { eligibleNow: [], soonest: null },
    });
  });

  it("maps an overdue episode to eligibleNow + nextShipment", () => {
    const digest = buildInsuranceDueDigest(
      [
        {
          id: "ep_1",
          prescription_id: "rx_mask",
          due_at: "2026-08-20T00:00:00.000Z",
        },
      ],
      skus,
      NOW,
    );
    expect(digest.eligibility.eligibleNow).toEqual([
      { subscriptionId: "ep_1", firstItemName: "MASK-NASAL-M" },
    ]);
    expect(digest.eligibility.soonest).toEqual({
      firstItemName: "MASK-NASAL-M",
      daysUntil: 0,
    });
    expect(digest.nextShipment).toMatchObject({
      subscriptionId: "ep_1",
      date: "2026-08-20T00:00:00.000Z",
      daysUntil: 0,
      firstItemName: "MASK-NASAL-M",
      cancelAtPeriodEnd: false,
    });
  });

  it("maps a future episode to soonest countdown without eligibleNow", () => {
    const digest = buildInsuranceDueDigest(
      [
        {
          id: "ep_2",
          prescription_id: "rx_filter",
          due_at: "2026-09-10T00:00:00.000Z",
        },
      ],
      skus,
      NOW,
    );
    expect(digest.eligibility.eligibleNow).toEqual([]);
    expect(digest.eligibility.soonest).toEqual({
      firstItemName: "FILTER-DISP-2",
      daysUntil: 14,
    });
    expect(digest.nextShipment?.daysUntil).toBe(14);
    expect(digest.nextShipment?.firstItemName).toBe("FILTER-DISP-2");
  });

  it("picks the earliest due_at for nextShipment across mixed episodes", () => {
    const digest = buildInsuranceDueDigest(
      [
        {
          id: "ep_future",
          prescription_id: "rx_filter",
          due_at: "2026-09-01T00:00:00.000Z",
        },
        {
          id: "ep_due",
          prescription_id: "rx_mask",
          due_at: "2026-08-26T00:00:00.000Z",
        },
      ],
      skus,
      NOW,
    );
    expect(digest.nextShipment?.subscriptionId).toBe("ep_due");
    expect(digest.eligibility.eligibleNow).toHaveLength(1);
    expect(digest.eligibility.soonest?.daysUntil).toBe(0);
  });
});
