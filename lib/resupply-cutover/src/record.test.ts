// The cutover record's state machine.
//
// `resolveReadinessState` is what the console renders and what the
// enable path consults. Four states, not two: a tenant nobody has
// assessed and a tenant that failed are different problems, and a clean
// pass from March is not a clean pass. Every case below is a decision an
// operator would otherwise have to make from a shrug.

import { describe, expect, it, vi } from "vitest";

import {
  READINESS_TTL_DAYS,
  hasFreshReadyAssessment,
  resolveReadinessState,
  type CutoverRecord,
} from "./record";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function record(overrides: Partial<CutoverRecord> = {}): CutoverRecord {
  return {
    id: "rec_1",
    orgId: "org_1",
    flagKey: "resupply.due_at_authoritative",
    action: "evaluate",
    previousValue: false,
    newValue: null,
    readinessStatus: "ready",
    report: {},
    evidenceId: "OPS-1234",
    rollbackReason: null,
    actorEmail: "ops@example.com",
    evaluatedAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("resolveReadinessState", () => {
  it("is not_evaluated when no assessment has ever run", () => {
    expect(resolveReadinessState(null, NOW)).toEqual({
      state: "not_evaluated",
      ageDays: null,
    });
  });

  it("is ready for a clean assessment inside the freshness window", () => {
    const yesterday = new Date(NOW.getTime() - DAY_MS).toISOString();
    expect(
      resolveReadinessState(record({ evaluatedAt: yesterday }), NOW),
    ).toEqual({ state: "ready", ageDays: 1 });
  });

  it("is still ready on the last day of the window", () => {
    const at = new Date(
      NOW.getTime() - READINESS_TTL_DAYS * DAY_MS,
    ).toISOString();
    expect(resolveReadinessState(record({ evaluatedAt: at }), NOW).state).toBe(
      "ready",
    );
  });

  it("expires the day after the window", () => {
    const at = new Date(
      NOW.getTime() - (READINESS_TTL_DAYS + 1) * DAY_MS,
    ).toISOString();
    const resolved = resolveReadinessState(record({ evaluatedAt: at }), NOW);
    expect(resolved.state).toBe("validation_expired");
    expect(resolved.ageDays).toBe(READINESS_TTL_DAYS + 1);
  });

  it("keeps a blocked verdict blocked however old it is", () => {
    // Age can turn a pass into an unknown. It must never turn a failure
    // into one — that would let a stale failure read as "just re-run it".
    const at = new Date(NOW.getTime() - 400 * DAY_MS).toISOString();
    expect(
      resolveReadinessState(
        record({ readinessStatus: "blocked", evaluatedAt: at }),
        NOW,
      ).state,
    ).toBe("blocked");
  });

  it("treats an errored assessment as blocked, not as unevaluated", () => {
    expect(
      resolveReadinessState(record({ readinessStatus: "error" }), NOW).state,
    ).toBe("blocked");
  });

  it("refuses to imply freshness from an unparseable timestamp", () => {
    expect(
      resolveReadinessState(record({ evaluatedAt: "not-a-date" }), NOW),
    ).toEqual({ state: "not_evaluated", ageDays: null });
  });

  it("does not treat a rollback as an authorisation to re-enable", () => {
    // A rollback is recorded with readiness_status `blocked` precisely so
    // the next enable cannot find a stale `ready` behind it.
    expect(
      resolveReadinessState(
        record({
          action: "rollback",
          readinessStatus: "blocked",
          rollbackReason: "reminders firing early for override patients",
        }),
        NOW,
      ).state,
    ).toBe("blocked");
  });
});

describe("hasFreshReadyAssessment", () => {
  it("fails CLOSED when the history cannot be read", async () => {
    // A readiness gate that cannot read its own history must not
    // conclude "go ahead".
    vi.resetModules();
    vi.doMock("@workspace/resupply-db", () => ({
      getOrgScopedClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: () =>
                    Promise.reject(new Error("postgrest unreachable")),
                }),
              }),
            }),
          }),
        }),
      }),
    }));
    const mod = await import("./record");
    const result = await mod.hasFreshReadyAssessment(
      "org_1",
      "resupply.due_at_authoritative",
      NOW,
    );
    expect(result).toMatchObject({ ok: false, state: "not_evaluated" });
    vi.doUnmock("@workspace/resupply-db");
    vi.resetModules();
  });

  it("is exported for the enable path to consult", () => {
    expect(typeof hasFreshReadyAssessment).toBe("function");
  });
});
