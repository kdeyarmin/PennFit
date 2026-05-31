// Unit tests for the per-patient override layering + suppression in
// `dispatchAlert`. Uses the shared supabase mock so no live PostgREST
// surface is needed. We exercise the override DECISION logic via the
// early-return outcomes that don't require a configured vendor client:
//
//   * Override is_active=false  → "suppressed_for_patient".
//   * Global message inactive   → "message_not_configured".
//   * Override table errors      → degrades to the global (no throw).
//
// The render-layering itself (override field wins; null inherits) is
// covered by the pure `renderAlertMessage` tests in dispatch.test.ts;
// here we only assert the lookup/suppress branch behaviour.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { dispatchAlert } from "./dispatch";

const ACTIVE_DEF = {
  key: "resupply_due",
  channels: ["email", "sms", "voice"],
  allowed_variables: ["first_name", "practice_name"],
  is_active: true,
};

const ACTIVE_GLOBAL_MSG = {
  subject: null,
  body_html: null,
  body_text: "Hi {{first_name}}",
  is_active: true,
};

beforeEach(() => {
  supabaseMock.reset();
});

afterEach(() => {
  supabaseMock.reset();
});

describe("dispatchAlert — override layering", () => {
  it("suppresses the alert when an override is is_active=false", async () => {
    stageSupabaseResponse("alert_definitions", "select", { data: ACTIVE_DEF });
    stageSupabaseResponse("alert_messages", "select", {
      data: ACTIVE_GLOBAL_MSG,
    });
    stageSupabaseResponse("alert_message_overrides", "select", {
      data: {
        subject: null,
        body_html: null,
        body_text: null,
        is_active: false,
      },
    });

    const outcome = await dispatchAlert({
      alertKey: "resupply_due",
      channel: "sms",
      patientId: "p_1",
    });
    expect(outcome.status).toBe("suppressed_for_patient");
  });

  it("degrades to the global when the override table errors (missing table)", async () => {
    stageSupabaseResponse("alert_definitions", "select", { data: ACTIVE_DEF });
    stageSupabaseResponse("alert_messages", "select", {
      data: ACTIVE_GLOBAL_MSG,
    });
    // Simulate "relation does not exist" — the dispatch path must NOT
    // throw; it swallows the override error and uses the global.
    stageSupabaseResponse("alert_message_overrides", "select", {
      error: { code: "42P01", message: "relation does not exist" },
    });
    // Patient lookup → not found, a clean early return that proves we
    // got past the override branch without throwing.
    stageSupabaseResponse("patients", "select", { data: null });

    const outcome = await dispatchAlert({
      alertKey: "resupply_due",
      channel: "sms",
      patientId: "p_missing",
    });
    expect(outcome.status).toBe("patient_not_found");
  });

  it("reports message_not_configured when the global message is inactive", async () => {
    stageSupabaseResponse("alert_definitions", "select", { data: ACTIVE_DEF });
    stageSupabaseResponse("alert_messages", "select", {
      data: { ...ACTIVE_GLOBAL_MSG, is_active: false },
    });
    stageSupabaseResponse("alert_message_overrides", "select", { data: null });

    const outcome = await dispatchAlert({
      alertKey: "resupply_due",
      channel: "sms",
      patientId: "p_1",
    });
    expect(outcome.status).toBe("message_not_configured");
  });
});
