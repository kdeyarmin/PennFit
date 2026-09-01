// What a connector's `consecutive_failures` counts.
//
// The number drives an operator-facing badge and the `degraded` ->
// `failing` promotion at three. Both stop meaning anything if it counts
// answers that were never failures — and `not_found` / `no_data` are
// defined in the shared vocabulary as the vendor answering SUCCESSFULLY
// and having nothing for that patient. `indicatesUnhealthyConnector` says
// so, and the status branch already honoured it while the counter did
// not, so a roster containing three patients the vendor has never heard
// of quietly armed the next real error to jump straight to `failing`.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationSource } from "@workspace/resupply-integrations";

const ORG = "11111111-1111-4111-8111-111111111111";
const SOURCE = "resmed_airview" as IntegrationSource;

interface Written {
  op: "insert" | "update";
  payload: Record<string, unknown>;
}

const { db } = vi.hoisted(() => ({
  db: {
    existing: null as Record<string, unknown> | null,
    writes: [] as Written[],
  },
}));

vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: () => ({
    from: () => {
      const self: Record<string, unknown> = {
        select: () => self,
        eq: () => self,
        limit: () => self,
        maybeSingle: () => Promise.resolve({ data: db.existing, error: null }),
        insert: (payload: Record<string, unknown>) => {
          db.writes.push({ op: "insert", payload });
          return Promise.resolve({ error: null });
        },
        update: (payload: Record<string, unknown>) => {
          db.writes.push({ op: "update", payload });
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
      return self;
    },
  }),
}));

const { recordSyncOutcome } = await import("./connector-status");

/** The one number under test, from the write the call produced. */
function writtenFailures(): unknown {
  return db.writes.at(-1)?.payload.consecutive_failures;
}

function writtenStatus(): unknown {
  return db.writes.at(-1)?.payload.status;
}

beforeEach(() => {
  db.existing = null;
  db.writes = [];
});

describe("recordSyncOutcome — consecutive_failures", () => {
  it("does not count `not_found`, which is the vendor answering", async () => {
    db.existing = { status: "live_validated", consecutive_failures: 2 };
    await recordSyncOutcome({
      orgId: ORG,
      source: SOURCE,
      ok: false,
      errorCategory: "not_found",
    });
    expect(writtenFailures()).toBe(2);
  });

  it("does not count `no_data` either", async () => {
    db.existing = { status: "live_validated", consecutive_failures: 0 };
    await recordSyncOutcome({
      orgId: ORG,
      source: SOURCE,
      ok: false,
      errorCategory: "no_data",
    });
    expect(writtenFailures()).toBe(0);
  });

  it("leaves the STATUS alone for a healthy category, as it always did", async () => {
    db.existing = { status: "live_validated", consecutive_failures: 0 };
    await recordSyncOutcome({
      orgId: ORG,
      source: SOURCE,
      ok: false,
      errorCategory: "not_found",
    });
    expect(writtenStatus()).toBe("live_validated");
  });

  it("counts a real failure", async () => {
    db.existing = { status: "live_validated", consecutive_failures: 2 };
    await recordSyncOutcome({
      orgId: ORG,
      source: SOURCE,
      ok: false,
      errorCategory: "server_error",
    });
    expect(writtenFailures()).toBe(3);
    expect(writtenStatus()).toBe("failing");
  });

  it("counts an UNCLASSIFIED failure — an unknown answer is not a healthy one", async () => {
    db.existing = { status: "live_validated", consecutive_failures: 0 };
    await recordSyncOutcome({ orgId: ORG, source: SOURCE, ok: false });
    expect(writtenFailures()).toBe(1);
  });

  it("does not let a run of no-data answers arm the next real error", async () => {
    // Three patients the vendor has never heard of, then one genuine 5xx.
    // The 5xx is the FIRST failure, so the connector goes `degraded`, not
    // straight to `failing`.
    db.existing = { status: "live_validated", consecutive_failures: 0 };
    for (let i = 0; i < 3; i++) {
      await recordSyncOutcome({
        orgId: ORG,
        source: SOURCE,
        ok: false,
        errorCategory: "not_found",
      });
    }
    expect(writtenFailures()).toBe(0);
    await recordSyncOutcome({
      orgId: ORG,
      source: SOURCE,
      ok: false,
      errorCategory: "server_error",
    });
    expect(writtenFailures()).toBe(1);
    expect(writtenStatus()).toBe("degraded");
  });

  it("clears the counter on a clean sync", async () => {
    db.existing = { status: "live_validated", consecutive_failures: 4 };
    await recordSyncOutcome({ orgId: ORG, source: SOURCE, ok: true });
    expect(writtenFailures()).toBe(0);
  });

  it("never promotes an unvalidated connector to live_validated", async () => {
    // A sync that happens to succeed is not the deliberate, attributed
    // validation an operator ran and kept evidence for.
    db.existing = { status: "unvalidated", consecutive_failures: 0 };
    await recordSyncOutcome({ orgId: ORG, source: SOURCE, ok: true });
    expect(writtenStatus()).toBe("unvalidated");
  });
});
