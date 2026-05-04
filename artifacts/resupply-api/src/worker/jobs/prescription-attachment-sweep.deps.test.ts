// Guard tests for buildProductionSweepDeps' DB-touching closures.
//
// Why a separate file
// -------------------
// The main sweep suite (prescription-attachment-sweep.test.ts) tests
// `sweepOrphans` against an injected `SweepDeps` and never touches
// drizzle/pg. Mocking drizzle there would change every test's
// boundary. This file hoists a tiny drizzle stub and asserts ONLY
// that `loadReferencedKeys` and `isStillReferenced` query both
// writers (`prescriptions` AND `message_attachments`) — i.e. that
// the Task #50 widening doesn't silently drift back to a single-
// table query during a future refactor.
//
// What we don't test here
// -----------------------
// The actual SQL drizzle compiles to (column projections, WHERE
// shape) — that's exercised by the `resupply-check` integration
// sweep which hits a real Postgres. This file is a query-shape
// guard, not an integration test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fromCalls: unknown[] = [];
const dbStub = {
  select: vi.fn(() => ({
    from: (table: unknown) => {
      fromCalls.push(table);
      const chain: Record<string, unknown> = {
        where: () => chain,
        limit: () =>
          // Resolve to empty rows by default; individual tests below
          // override per-table by inspecting the recorded `fromCalls`.
          Promise.resolve([]),
        then: (
          resolve: (v: unknown) => unknown,
          reject: (e: unknown) => unknown,
        ) => Promise.resolve([]).then(resolve, reject),
      };
      return chain;
    },
  })),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

const poolQuery = vi.fn();
vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return {
    ...actual,
    getDbPool: () => ({ query: poolQuery }) as never,
  };
});

// The shim's GCS calls aren't exercised here; stub them out so the
// production deps factory is callable with no live bucket.
vi.mock("../lib/object-storage.js", () => ({
  listAttachmentObjects: async () => [],
  attachmentKeyForObjectName: () => null,
  deleteAttachmentObject: async () => undefined,
  getPrivateObjectLocation: () => ({
    bucketName: "test-bucket",
    entityPrefix: "",
  }),
}));

// `logAudit` writes to a real audit_log table in production; stub it.
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

// Imported AFTER the mocks so the module picks up the stubs.
import { buildProductionSweepDeps } from "./prescription-attachment-sweep.js";
import { prescriptions, messageAttachments } from "@workspace/resupply-db";

describe("buildProductionSweepDeps — query widening guard (Task #50)", () => {
  beforeEach(() => {
    fromCalls.length = 0;
    dbStub.select.mockClear();
    poolQuery.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loadReferencedKeys SELECTs from BOTH prescriptions and message_attachments", async () => {
    const deps = buildProductionSweepDeps(new Date(), 24 * 3600 * 1000);
    const result = await deps.loadReferencedKeys();
    // Empty Set because both stubs resolve to [], but the table set
    // recorded by `.from()` is the actual subject under test.
    expect(result.size).toBe(0);
    expect(fromCalls).toContain(prescriptions);
    expect(fromCalls).toContain(messageAttachments);
    // Sanity: both writers must be queried — exactly two SELECTs.
    expect(dbStub.select).toHaveBeenCalledTimes(2);
  });

  it("isStillReferenced rechecks BOTH tables before authorising delete", async () => {
    const deps = buildProductionSweepDeps(new Date(), 24 * 3600 * 1000);
    const ref = await deps.isStillReferenced("/objects/uploads/abc");
    // Both stubs resolve to [], so the recheck reports "not
    // referenced" — but we still want to see both tables touched so
    // a future refactor can't silently drop the message-attachments
    // half of the union.
    expect(ref).toBe(false);
    expect(fromCalls).toContain(prescriptions);
    expect(fromCalls).toContain(messageAttachments);
    expect(dbStub.select).toHaveBeenCalledTimes(2);
  });
});
