// The flag decides where a refill cycle's start date comes from, and the
// FAIL direction is the whole point of these: an unreadable flag must not
// silently stop opening cycles.

import { beforeEach, describe, expect, it } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { invalidateFeatureFlagCache } from "../feature-flags";
import { shouldOpenNextCycleAtConfirm } from "./ship-evidence-gate";

const ORG = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  supabaseMock.reset();
  // Flag reads are process-cached for 5s, so without this every case
  // after the first would assert against the first one's answer.
  invalidateFeatureFlagCache();
});

describe("shouldOpenNextCycleAtConfirm", () => {
  it("opens at the confirm by default", async () => {
    // OFF is what every tenant does today. The confirm-time date is a
    // provisional estimate that shipment evidence later re-anchors.
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
      error: null,
    });
    await expect(shouldOpenNextCycleAtConfirm(ORG)).resolves.toBe(true);
  });

  it("waits for evidence when the tenant asks it to", async () => {
    // recordShipmentEvidence and the grace sweep become the only
    // producers — both know a real date, which is the point.
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
      error: null,
    });
    await expect(shouldOpenNextCycleAtConfirm(ORG)).resolves.toBe(false);
  });

  it("opens at the confirm when the flag cannot be read", async () => {
    // The asymmetry this whole module exists for. Opening on an estimate
    // is corrected the moment a shipment is recorded; NOT opening leaves
    // a cycle that nothing knows is missing.
    stageSupabaseResponse("feature_flags", "select", {
      data: null,
      error: { message: "connection reset" },
    });
    await expect(shouldOpenNextCycleAtConfirm(ORG)).resolves.toBe(true);
  });

  // Not tested here: a tenant with no row for the flag at all. Migration
  // 0538 seeds one for every organization and the flag is in
  // DELIBERATELY_OFF_FLAGS, so a new tenant gets an explicit `false` —
  // which `feature-flag-presets` already pins. Asserting it through this
  // wrapper would be testing the flag subsystem's own dev fallbacks.
});
