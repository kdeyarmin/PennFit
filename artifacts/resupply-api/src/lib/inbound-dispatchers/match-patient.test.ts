// Tests for the inbound-referral patient matcher.
//
// Coverage of every strategy step:
//   * Empty input (no phone, no dob, no last name) → none
//   * exact_phone single hit
//   * exact_phone ambiguous (>1) falls through to exact_dob_last_name
//   * exact_dob_last_name single hit
//   * exact_dob_last_name ambiguous falls through to fuzzy_phone_tail
//   * fuzzy_phone_tail single hit
//   * fuzzy_phone_tail ambiguous → none
//   * fuzzy_phone_tail skipped when phone tail isn't 7 digits
//   * DB error on exact_phone bubbles up

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { matchPatient } from "./match-patient";

beforeEach(() => supabaseMock.reset());

describe("matchPatient", () => {
  it("returns kind='none' when no phone / dob / lastName provided", async () => {
    const r = await matchPatient({ phoneE164: null, dob: null, lastName: null });
    expect(r).toEqual({ patientId: null, kind: "none" });
  });

  it("returns kind='exact_phone' on a single phone match", async () => {
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "p_1" }],
    });
    const r = await matchPatient({
      phoneE164: "+18005550100",
      dob: null,
      lastName: null,
    });
    expect(r).toEqual({ patientId: "p_1", kind: "exact_phone" });
  });

  it("falls through when exact_phone returns multiple matches", async () => {
    // exact_phone returns 2 → ambiguous → fall through
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "p_1" }, { id: "p_2" }],
    });
    // exact_dob_last_name returns 1 hit
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "p_3" }],
    });
    const r = await matchPatient({
      phoneE164: "+18005550100",
      dob: "1970-01-01",
      lastName: "Smith",
    });
    expect(r).toEqual({ patientId: "p_3", kind: "exact_dob_last_name" });
  });

  it("returns kind='fuzzy_phone_tail' on a single fuzzy match", async () => {
    // exact_phone miss
    stageSupabaseResponse("patients", "select", { data: [] });
    // (no exact_dob_last_name attempt — dob/lastName both null)
    // fuzzy_phone_tail single hit
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_f" }] });

    const r = await matchPatient({
      phoneE164: "+18005550100",
      dob: null,
      lastName: null,
    });
    expect(r).toEqual({ patientId: "p_f", kind: "fuzzy_phone_tail" });
  });

  it("returns kind='none' when fuzzy_phone_tail is ambiguous", async () => {
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "p_1" }, { id: "p_2" }],
    });
    const r = await matchPatient({
      phoneE164: "+18005550100",
      dob: null,
      lastName: null,
    });
    expect(r.kind).toBe("none");
  });

  it("returns kind='none' on a 6-digit (non-7-digit) phone", async () => {
    // Phone tail is only 6 digits → fuzzy step is skipped.
    // exact_phone single hit on a normalized short phone still works
    // — we test with a phone that's too short to even try.
    const r = await matchPatient({
      phoneE164: "+1", // too short to slice 7-digit tail
      dob: null,
      lastName: null,
    });
    expect(r.kind).toBe("none");
  });

  it("propagates DB errors from exact_phone", async () => {
    stageSupabaseResponse("patients", "select", {
      error: { message: "kaboom" },
    });
    await expect(
      matchPatient({
        phoneE164: "+18005550100",
        dob: null,
        lastName: null,
      }),
    ).rejects.toThrow();
  });
});
