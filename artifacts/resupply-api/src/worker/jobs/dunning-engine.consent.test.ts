// Dunning tick: where the ladder reads consent from.
//
// This job used to select `patients.communication_preferences`. That
// column is on `shop_customers`, so PostgREST answered 42703 and the
// `if (patientErr) throw patientErr` below it killed the tick — for the
// WHOLE org, on the first run that reached the send branch. Every
// patient with an outstanding balance stalled at whichever ladder step
// they were on, and the job reported it as a thrown tick rather than as
// a delivery problem.
//
// The sibling `dunning-engine.test.ts` stubs the Supabase client out
// entirely to test the flag gate, so it never reaches this branch. These
// tests stage the real reads instead.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseSelectColumns,
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => true),
}));

const sendStatementMessageMock = vi.hoisted(() =>
  vi.fn(async () => ({ kind: "sent" as const, reason: null })),
);
// `pickStatementChannel` is pure and lives in statement-send; it is left
// real so the prefs object this job resolves actually decides the
// channel, which is the behaviour under test.
vi.mock("../../lib/billing/statement-send", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../lib/billing/statement-send")
  >()),
  applyTenantStatementIdentity: vi.fn(async (_o: string, c: unknown) => c),
  readStatementMessagingConfig: vi.fn(() => ({})),
  sendStatementMessage: sendStatementMessageMock,
}));

import { runDunningTickForOrg } from "./dunning-engine";

const ORG = "00000000-0000-4000-8000-000000000001";
// 17:00Z is 13:00 America/New_York — inside the send window, so a
// quiet-hours skip cannot be mistaken for a consent skip.
const NOW = new Date("2026-06-16T17:00:00Z");

beforeEach(() => {
  supabaseMock.reset();
  sendStatementMessageMock.mockClear();
  sendStatementMessageMock.mockResolvedValue({ kind: "sent", reason: null });
});

/**
 * One patient, one due run at a step whose action is "send", with a
 * balance large enough to clear the minimum and no plan/autopay guard.
 */
function stageDueSend(opts: { prefsResponse?: Record<string, unknown> } = {}) {
  stageSupabaseResponse("patient_dunning_runs", "select", {
    data: [
      {
        id: "run-1",
        patient_id: "pat-1",
        current_step: "first_notice",
        next_action_at: "2026-06-10T00:00:00Z",
        opened_on: "2026-06-01",
      },
    ],
  });
  stageSupabaseResponse("insurance_claims", "select", {
    data: [{ patient_responsibility_cents: 25_000 }],
  });
  stageSupabaseResponse("patient_payment_plans", "select", { data: [] });
  stageSupabaseResponse("patient_autopay_authorizations", "select", {
    data: [],
  });
  stageSupabaseResponse("patients", "select", {
    data: {
      email: "sam@example.com",
      phone_e164: "+12155551234",
      portal_auth_user_id: null,
    },
  });
  stageSupabaseResponse(
    "shop_customers",
    "select",
    opts.prefsResponse ?? {
      data: { communication_preferences: { emailBillingStatements: true } },
    },
  );
}

describe("runDunningTickForOrg — where consent comes from", () => {
  it("does not ask patients for communication_preferences", async () => {
    // The regression itself. Asking for a column this table does not
    // have threw the tick for the entire org.
    stageDueSend();

    await runDunningTickForOrg(ORG, NOW);

    const selects = getSupabaseSelectColumns("patients");
    expect(selects.length).toBeGreaterThan(0);
    for (const cols of selects) {
      expect(cols).not.toContain("communication_preferences");
    }
    expect(selects.some((c) => c.includes("portal_auth_user_id"))).toBe(true);
  });

  it("reads consent from shop_customers and sends on the allowed channel", async () => {
    stageDueSend();

    const stats = await runDunningTickForOrg(ORG, NOW);

    expect(stats.sent).toBe(1);
    expect(sendStatementMessageMock).toHaveBeenCalledTimes(1);
    const joins = getSupabaseFilterCalls("shop_customers", "select")
      .filter((f) => f.verb === "eq" && f.args[0] !== "org_id")
      .map((f) => f.args[0]);
    expect(joins).toContain("email_lower");
  });

  it("skips without throwing when consent cannot be read", async () => {
    // The old code threw here, which took down every remaining run in
    // the tick. Skipping this one patient leaves the rest of the batch
    // to make progress, and leaves `next_action_at` alone so the next
    // tick retries.
    stageDueSend({ prefsResponse: { error: { message: "boom" } } });

    const stats = await runDunningTickForOrg(ORG, NOW);

    expect(stats.skipped).toBe(1);
    expect(stats.sent).toBe(0);
    expect(sendStatementMessageMock).not.toHaveBeenCalled();
  });

  it("does not advance the ladder on an unreadable consent record", async () => {
    // A skip that ADVANCED would walk a patient toward agency handoff on
    // the strength of a read we could not make.
    stageDueSend({ prefsResponse: { error: { message: "boom" } } });

    await runDunningTickForOrg(ORG, NOW);

    const stepWrites = getSupabaseFilterCalls("patient_dunning_runs", "update");
    expect(stepWrites).toEqual([]);
  });

  it("still duns a patient with no storefront account", async () => {
    // "No shop_customers row" is the common case and is not a refusal;
    // billing statements are ON by default.
    stageDueSend({ prefsResponse: { data: null } });

    const stats = await runDunningTickForOrg(ORG, NOW);

    expect(stats.sent).toBe(1);
  });
});
