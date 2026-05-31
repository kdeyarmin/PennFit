// Tests for the automated low_usage_checkin alert trigger.
//
// Coverage:
//   * Flag OFF → no work at all (fail-closed).
//   * Flag ON but RESUPPLY_COACH_PHONE unset → skip before dispatch.
//   * Flag ON + coach phone set → reaches dispatchAlert (verified via
//     the alert_definitions lookup it performs).
//   * Never throws (fire-and-forget safety) even on a DB error.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getSupabaseCallCount,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { invalidateFeatureFlagCache } from "../feature-flags";
import { maybeDispatchLowUsageCheckinAlert } from "./low-usage-checkin-trigger";

const ORIGINAL_COACH_PHONE = process.env.RESUPPLY_COACH_PHONE;

beforeEach(() => {
  supabaseMock.reset();
  invalidateFeatureFlagCache();
  delete process.env.RESUPPLY_COACH_PHONE;
});

afterEach(() => {
  supabaseMock.reset();
  if (ORIGINAL_COACH_PHONE === undefined) {
    delete process.env.RESUPPLY_COACH_PHONE;
  } else {
    process.env.RESUPPLY_COACH_PHONE = ORIGINAL_COACH_PHONE;
  }
});

describe("maybeDispatchLowUsageCheckinAlert", () => {
  it("does nothing when the alerts.auto_dispatch flag is OFF", async () => {
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
    });
    process.env.RESUPPLY_COACH_PHONE = "+18005551212";

    await maybeDispatchLowUsageCheckinAlert({
      patientId: "p_1",
      nightsUsed: 12,
    });
    expect(getSupabaseCallCount("feature_flags", "select")).toBe(1);
    // Flag off → never reaches the dispatch path.
    expect(getSupabaseCallCount("alert_definitions", "select")).toBe(0);
  });

  it("skips (no dispatch) when RESUPPLY_COACH_PHONE is unset", async () => {
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    // No coach phone env.
    await maybeDispatchLowUsageCheckinAlert({
      patientId: "p_1",
      nightsUsed: 12,
    });
    expect(getSupabaseCallCount("alert_definitions", "select")).toBe(0);
  });

  it("reaches dispatch when flag on + coach phone set", async () => {
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    process.env.RESUPPLY_COACH_PHONE = "+18005551212";
    // Let dispatch resolve the definition then bail at a clean outcome
    // (alert not found) — enough to prove dispatch was invoked.
    stageSupabaseResponse("alert_definitions", "select", { data: null });

    await maybeDispatchLowUsageCheckinAlert({
      patientId: "p_1",
      nightsUsed: 12,
    });
    expect(getSupabaseCallCount("alert_definitions", "select")).toBe(1);
  });

  it("never throws when a DB read errors", async () => {
    stageSupabaseResponse("feature_flags", "select", {
      error: { code: "08006", message: "connection failure" },
    });
    process.env.RESUPPLY_COACH_PHONE = "+18005551212";
    await expect(
      maybeDispatchLowUsageCheckinAlert({ patientId: "p_1", nightsUsed: 12 }),
    ).resolves.toBeUndefined();
  });
});
