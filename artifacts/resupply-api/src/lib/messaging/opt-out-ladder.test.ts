// The STOP -> START round trip.
//
// This is the sharpest trap in the channel-exit work. Once `pausePatient`
// began closing episodes, the ladder's ONLY producer became
// `openOutreachEpisode` — called from prescription create, the import
// bootstrap, and shipment evidence. None of those fire on a START. So
// without an explicit re-open, a patient who texts STOP and then START is
// permanently invisible to resupply: active, enrolled, and never
// contacted again. Nothing throws, nothing logs, and the failure only
// surfaces months later when they call to say their supplies ran out.

import { beforeEach, describe, expect, it } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { pausePatient, reactivatePatient } from "./order-flow";

const ORG = "00000000-0000-4000-8000-000000000001";
const PATIENT = "00000000-0000-4000-8000-000000000011";

beforeEach(() => {
  supabaseMock.reset();
});

describe("pausePatient (STOP)", () => {
  it("closes the patient's open cycles as an opt-out, not a decline", async () => {
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT, email: null },
      error: null,
    });
    stageSupabaseResponse("episodes", "update", {
      data: [{ id: "e1" }, { id: "e2" }],
      error: null,
    });

    await pausePatient(PATIENT, ORG);

    const [patch] = supabaseMock.writePayloads("episodes", "update") as [
      Record<string, unknown>,
    ];
    // `canceled` / `patient_opted_out`. Folding an opt-out into `declined`
    // would make the decline rate meaningless — one is a withdrawal from
    // contact, the other is a refusal of this specific order.
    expect(patch.status).toBe("canceled");
    expect(patch.closed_reason).toBe("patient_opted_out");
  });

  it("still acknowledges the STOP when the episode close fails", async () => {
    // Carrier-mandated. A bookkeeping failure must never turn a STOP into
    // an error the caller surfaces instead of the opt-out confirmation.
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT, email: null },
      error: null,
    });
    stageSupabaseResponse("episodes", "update", {
      data: null,
      error: { code: "57014", message: "canceling statement" },
    });

    await expect(pausePatient(PATIENT, ORG)).resolves.toBeUndefined();
  });

  it("leaves queued orders alone", async () => {
    // A STOP is about messaging. Supplies the patient already confirmed
    // should still reach them.
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT, email: null },
      error: null,
    });
    stageSupabaseResponse("episodes", "update", { data: [], error: null });

    await pausePatient(PATIENT, ORG);

    expect(supabaseMock.callCount("fulfillments", "update")).toBe(0);
  });
});

describe("reactivatePatient (START)", () => {
  it("re-opens a cycle for every active prescription", async () => {
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT, email: null },
      error: null,
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: [
        {
          id: "rx1",
          item_sku: "CUSHION-STD",
          cadence_days: 30,
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "rx2",
          item_sku: "TUBING-STD",
          cadence_days: 90,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      error: null,
    });
    stageSupabaseResponse("fulfillments", "select", { data: [], error: null });
    // openOutreachEpisode: existence check then insert, per prescription.
    stageSupabaseResponse("episodes", "select", { data: null, error: null });
    stageSupabaseResponse("episodes", "insert", {
      data: { id: "new1" },
      error: null,
    });
    stageSupabaseResponse("episodes", "select", { data: null, error: null });
    stageSupabaseResponse("episodes", "insert", {
      data: { id: "new2" },
      error: null,
    });

    await reactivatePatient(PATIENT, ORG);

    expect(supabaseMock.callCount("episodes", "insert")).toBe(2);
  });

  it("brings a long-paused patient back already due, not due in another cycle", async () => {
    // Someone who STOPped four months into a 90-day cycle must return
    // overdue. Anchoring on the opt-in instead of their last dispense
    // would give them another 90 days of silence while supplies run out.
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT, email: null },
      error: null,
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: [
        {
          id: "rx1",
          item_sku: "CUSHION-STD",
          cadence_days: 30,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      error: null,
    });
    stageSupabaseResponse("fulfillments", "select", {
      data: [
        {
          item_sku: "CUSHION-STD",
          shipped_at: "2026-01-10T00:00:00.000Z",
          created_at: "2026-01-08T00:00:00.000Z",
        },
      ],
      error: null,
    });
    stageSupabaseResponse("episodes", "select", { data: null, error: null });
    stageSupabaseResponse("episodes", "insert", {
      data: { id: "new1" },
      error: null,
    });

    await reactivatePatient(PATIENT, ORG);

    const [insert] = supabaseMock.writePayloads("episodes", "insert") as [
      Record<string, unknown>,
    ];
    // Anchored on the 2026-01-10 ship + 30 days, NOT on now.
    expect(insert.due_at).toBe("2026-02-09T00:00:00.000Z");
  });

  it("does not re-open for a patient who was never paused", async () => {
    // The `.eq("status","paused")` guard means the update matches nothing,
    // so a repeat START is a no-op rather than a second cycle.
    stageSupabaseResponse("patients", "update", { data: null, error: null });

    await reactivatePatient(PATIENT, ORG);

    expect(supabaseMock.callCount("prescriptions", "select")).toBe(0);
    expect(supabaseMock.callCount("episodes", "insert")).toBe(0);
  });

  it("still acknowledges the START when the re-open fails", async () => {
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT, email: null },
      error: null,
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: null,
      error: { code: "57014", message: "canceling statement" },
    });

    await expect(reactivatePatient(PATIENT, ORG)).resolves.toBeUndefined();
  });
});
