// Guard tests for buildProductionSweepDeps' DB-touching closures.
//
// Why a separate file
// -------------------
// The main sweep suite (prescription-attachment-sweep.test.ts) tests
// `sweepOrphans` against an injected `SweepDeps` and never touches
// Supabase. Mocking the data layer there would change every test's
// boundary. This file installs the shared Supabase mock and asserts
// ONLY that `loadReferencedKeys` and `isStillReferenced` query both
// writers (`prescriptions` AND `message_attachments`) — i.e. that
// the Task #50 widening doesn't silently drift back to a single-
// table query during a future refactor.
//
// What we don't test here
// -----------------------
// The actual SQL PostgREST issues (column projections, WHERE shape)
// — that's exercised by the `resupply-check` integration sweep which
// hits a real Postgres. This file is a query-shape guard, not an
// integration test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

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

describe("buildProductionSweepDeps — query widening guard (Task #50)", () => {
  beforeEach(() => {
    supabaseMock.reset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loadReferencedKeys SELECTs from BOTH prescriptions and message_attachments", async () => {
    // Both writers resolve to empty arrays — the test cares about the
    // table set the closure touches, not the data it returns.
    stageSupabaseResponse("prescriptions", "select", { data: [] });
    stageSupabaseResponse("message_attachments", "select", { data: [] });

    const deps = buildProductionSweepDeps(new Date(), 24 * 3600 * 1000);
    const result = await deps.loadReferencedKeys();
    expect(result.size).toBe(0);
    // Sanity: both writers must be queried — exactly two SELECTs.
    expect(getSupabaseCallCount("prescriptions", "select")).toBe(1);
    expect(getSupabaseCallCount("message_attachments", "select")).toBe(1);
  });

  it("isStillReferenced rechecks BOTH tables before authorising delete", async () => {
    // The pre-delete recheck uses head:true count probes; the
    // PostgREST envelope is `{ data: null, count: N }`.
    stageSupabaseResponse("prescriptions", "select", {
      data: null,
      count: 0,
    });
    stageSupabaseResponse("message_attachments", "select", {
      data: null,
      count: 0,
    });

    const deps = buildProductionSweepDeps(new Date(), 24 * 3600 * 1000);
    const ref = await deps.isStillReferenced("/objects/uploads/abc");
    // Both probes returned count=0, so the recheck reports "not
    // referenced" — but we still want to see both tables touched so
    // a future refactor can't silently drop the message-attachments
    // half of the union.
    expect(ref).toBe(false);
    expect(getSupabaseCallCount("prescriptions", "select")).toBe(1);
    expect(getSupabaseCallCount("message_attachments", "select")).toBe(1);
  });
});
