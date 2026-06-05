import { describe, expect, it } from "vitest";

import {
  aggregateOutreachAttribution,
  type AttributionBucket,
  type AttributionSource,
} from "./outreach-attribution";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const P3 = "33333333-3333-4333-8333-333333333333";

function src(
  r: ReturnType<typeof aggregateOutreachAttribution>,
  source: AttributionSource,
): AttributionBucket {
  if (source === "overall") return r.overall;
  const b = r.bySource.find((x) => x.source === source);
  if (!b) throw new Error(`missing ${source}`);
  return b;
}

describe("aggregateOutreachAttribution", () => {
  it("returns zeros and null rates for empty input", () => {
    const r = aggregateOutreachAttribution({
      reminderContacts: [],
      clinicalContacts: [],
      fulfillments: [],
      attributionWindowDays: 14,
    });
    expect(src(r, "resupply_reminder").contactedPatients).toBe(0);
    expect(src(r, "resupply_reminder").conversionRate).toBeNull();
    expect(r.overall.conversionRate).toBeNull();
  });

  it("attributes a fulfillment within the window after contact", () => {
    const r = aggregateOutreachAttribution({
      reminderContacts: [{ patientId: P1, at: "2026-06-01T00:00:00Z" }],
      clinicalContacts: [],
      fulfillments: [{ patientId: P1, at: "2026-06-08T00:00:00Z" }], // +7d
      attributionWindowDays: 14,
    });
    const b = src(r, "resupply_reminder");
    expect(b.contactedPatients).toBe(1);
    expect(b.convertedPatients).toBe(1);
    expect(b.conversionRate).toBe(1);
  });

  it("does NOT attribute a fulfillment before the contact", () => {
    const r = aggregateOutreachAttribution({
      reminderContacts: [{ patientId: P1, at: "2026-06-10T00:00:00Z" }],
      clinicalContacts: [],
      fulfillments: [{ patientId: P1, at: "2026-06-01T00:00:00Z" }], // before
      attributionWindowDays: 14,
    });
    expect(src(r, "resupply_reminder").convertedPatients).toBe(0);
  });

  it("does NOT attribute a fulfillment past the attribution window", () => {
    const r = aggregateOutreachAttribution({
      reminderContacts: [{ patientId: P1, at: "2026-06-01T00:00:00Z" }],
      clinicalContacts: [],
      fulfillments: [{ patientId: P1, at: "2026-06-20T00:00:00Z" }], // +19d > 14
      attributionWindowDays: 14,
    });
    expect(src(r, "resupply_reminder").convertedPatients).toBe(0);
  });

  it("uses the earliest contact for attribution", () => {
    const r = aggregateOutreachAttribution({
      reminderContacts: [
        { patientId: P1, at: "2026-06-15T00:00:00Z" },
        { patientId: P1, at: "2026-06-01T00:00:00Z" }, // earliest
      ],
      clinicalContacts: [],
      // +10d from earliest (1st), but -5d from the later contact.
      fulfillments: [{ patientId: P1, at: "2026-06-11T00:00:00Z" }],
      attributionWindowDays: 14,
    });
    expect(src(r, "resupply_reminder").contactedPatients).toBe(1);
    expect(src(r, "resupply_reminder").convertedPatients).toBe(1);
  });

  it("computes a partial conversion rate across patients", () => {
    const r = aggregateOutreachAttribution({
      reminderContacts: [
        { patientId: P1, at: "2026-06-01T00:00:00Z" },
        { patientId: P2, at: "2026-06-01T00:00:00Z" },
        { patientId: P3, at: "2026-06-01T00:00:00Z" },
      ],
      clinicalContacts: [],
      fulfillments: [
        { patientId: P1, at: "2026-06-03T00:00:00Z" }, // converts
        { patientId: P2, at: "2026-06-05T00:00:00Z" }, // converts
        // P3 never orders
      ],
      attributionWindowDays: 14,
    });
    const b = src(r, "resupply_reminder");
    expect(b.contactedPatients).toBe(3);
    expect(b.convertedPatients).toBe(2);
    expect(b.conversionRate).toBeCloseTo(2 / 3, 5);
  });

  it("de-dupes a patient contacted by both sources into overall (earliest wins)", () => {
    const r = aggregateOutreachAttribution({
      reminderContacts: [{ patientId: P1, at: "2026-06-10T00:00:00Z" }],
      clinicalContacts: [{ patientId: P1, at: "2026-06-02T00:00:00Z" }], // earlier
      // Fulfillment +6d from the clinical (earliest) contact, within 14d.
      fulfillments: [{ patientId: P1, at: "2026-06-08T00:00:00Z" }],
      attributionWindowDays: 14,
    });
    expect(src(r, "resupply_reminder").contactedPatients).toBe(1);
    expect(src(r, "clinical_outreach").contactedPatients).toBe(1);
    // Counted once overall, attributed off the earliest (clinical) contact.
    expect(r.overall.contactedPatients).toBe(1);
    expect(r.overall.convertedPatients).toBe(1);
  });
});
