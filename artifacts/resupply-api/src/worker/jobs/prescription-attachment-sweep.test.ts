// Unit tests for the prescription-attachment PHI sweep core.
//
// The sweep handler is wired to live GCS + live Postgres in
// production. These tests pin the PURE decision logic — every I/O
// dependency is injected via the `SweepDeps` shape, so the suite
// runs without standing up a bucket or a pool. The boundary code
// (drizzle SELECT for referenced keys, `logAudit`, GCS list/delete)
// is exercised in the `resupply-check` integration sweep.
//
// Coverage matrix (see jobs/prescription-attachment-sweep.ts comments
// for the full algorithm):
//   * referenced object             → not deleted
//   * unreferenced + young          → not deleted, counted as "too young"
//   * unreferenced + old            → recheck → deleted, counted, audited
//   * unreferenced + old, race-saved by recheck → not deleted, counted
//   * delete returns "not_found"    → counted as idempotent success
//   * delete returns "error"        → counter reflects error, audit still emitted
//   * non-attachment object         → skipped, counted, not deleted
//   * empty bucket                  → audit row with zero counters
//   * missing timeCreated on orphan → SKIP-AND-WARN (changed from earlier
//                                     "delete" policy after architect review)
//   * non-default grace window      → respected
//   * pre-delete recheck never runs for healthy/young/no-tc paths
//
// Also covers `attachmentKeyForObjectName` because its mapping rule
// is the linchpin of the reference check (a wrong rule would either
// delete every healthy object or never delete anything).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_GRACE_MS,
  sweepOrphans,
  type AttachmentObject,
  type DeleteOutcome,
  type SweepCounters,
  type SweepDeps,
} from "./prescription-attachment-sweep.js";
import { attachmentKeyForObjectName } from "../lib/object-storage.js";

const NOW = new Date("2026-04-30T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function obj(
  objectName: string,
  ageHours: number | null,
): AttachmentObject {
  return {
    bucketName: "test-bucket",
    objectName,
    timeCreated:
      ageHours === null ? null : new Date(NOW.getTime() - ageHours * HOUR_MS),
  };
}

interface FakeOpts {
  objects?: AttachmentObject[];
  referenced?: string[];
  /** Per-object override of the pre-delete recheck. Defaults to the
   *  bulk-load Set semantics (recheck mirrors `referenced`). */
  rechecked?: Record<string, boolean>;
  /** Map of object-name → outcome the deleteObject fake should
   *  return. Default outcome is "ok". */
  deleteOutcomes?: Record<string, DeleteOutcome>;
  /** Make `attachmentKeyOf` return null for these object names. */
  unmatched?: string[];
  graceMs?: number;
  asOf?: Date;
}

function makeDeps(opts: FakeOpts = {}): {
  deps: SweepDeps;
  audited: SweepCounters[];
  deleted: Array<{ bucket: string; name: string }>;
  rechecks: string[];
} {
  const audited: SweepCounters[] = [];
  const deleted: Array<{ bucket: string; name: string }> = [];
  const rechecks: string[] = [];
  const referenced = new Set(opts.referenced ?? []);
  const unmatched = new Set(opts.unmatched ?? []);
  const deleteOutcomes = opts.deleteOutcomes ?? {};
  const recheckOverrides = opts.rechecked ?? {};

  // Mirror the real rule: bucket-listed `<prefix>/uploads/<id>`
  // → DB key `/objects/uploads/<id>`. The test omits a prefix
  // for brevity; objects come in as `uploads/<id>` directly.
  const keyOf = (name: string): string | null => {
    if (unmatched.has(name)) return null;
    if (!name.startsWith("uploads/")) return null;
    const tail = name.slice("uploads/".length);
    return tail ? `/objects/uploads/${tail}` : null;
  };

  const deps: SweepDeps = {
    asOf: opts.asOf ?? NOW,
    graceMs: opts.graceMs ?? DEFAULT_GRACE_MS,
    listObjects: async () => opts.objects ?? [],
    attachmentKeyOf: keyOf,
    loadReferencedKeys: async () => referenced,
    isStillReferenced: async (key) => {
      rechecks.push(key);
      if (Object.prototype.hasOwnProperty.call(recheckOverrides, key)) {
        return recheckOverrides[key];
      }
      return referenced.has(key);
    },
    deleteObject: async (bucket, name) => {
      const outcome = deleteOutcomes[name] ?? "ok";
      if (outcome === "ok") deleted.push({ bucket, name });
      return outcome;
    },
    audit: async (counters) => {
      audited.push({ ...counters });
    },
  };
  return { deps, audited, deleted, rechecks };
}

describe("sweepOrphans", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves referenced objects alone and skips the recheck for them", async () => {
    const { deps, audited, deleted, rechecks } = makeDeps({
      objects: [obj("uploads/aaa", 100), obj("uploads/bbb", 100)],
      referenced: ["/objects/uploads/aaa", "/objects/uploads/bbb"],
    });
    const counters = await sweepOrphans(deps);
    expect(deleted).toEqual([]);
    expect(rechecks).toEqual([]); // pre-delete recheck only fires for delete candidates
    expect(counters.objects_scanned).toBe(2);
    expect(counters.references_loaded).toBe(2);
    expect(counters.orphans_deleted).toBe(0);
    expect(counters.orphans_too_young).toBe(0);
    expect(counters.delete_errors).toBe(0);
    expect(counters.recheck_saved).toBe(0);
    expect(audited).toHaveLength(1);
    expect(audited[0]).toEqual(counters);
  });

  it("leaves orphans inside the grace window alone (no recheck)", async () => {
    const { deps, audited, deleted, rechecks } = makeDeps({
      // 1h old; default grace is 24h.
      objects: [obj("uploads/young", 1)],
      referenced: [],
    });
    const counters = await sweepOrphans(deps);
    expect(deleted).toEqual([]);
    expect(rechecks).toEqual([]);
    expect(counters.orphans_too_young).toBe(1);
    expect(counters.orphans_deleted).toBe(0);
    expect(audited[0]?.orphans_too_young).toBe(1);
  });

  it("deletes orphans older than the grace window after a clean recheck", async () => {
    const { deps, audited, deleted, rechecks } = makeDeps({
      objects: [
        obj("uploads/old1", 25), // just over 24h
        obj("uploads/old2", 24 * 7), // a week old
        obj("uploads/young", 2), // inside grace
        obj("uploads/healthy", 30), // referenced
      ],
      referenced: ["/objects/uploads/healthy"],
    });
    const counters = await sweepOrphans(deps);
    expect(deleted.map((d) => d.name).sort()).toEqual([
      "uploads/old1",
      "uploads/old2",
    ]);
    expect(rechecks.sort()).toEqual([
      "/objects/uploads/old1",
      "/objects/uploads/old2",
    ]);
    expect(counters.objects_scanned).toBe(4);
    expect(counters.references_loaded).toBe(1);
    expect(counters.orphans_deleted).toBe(2);
    expect(counters.orphans_too_young).toBe(1);
    expect(counters.delete_errors).toBe(0);
    expect(counters.recheck_saved).toBe(0);
    expect(counters.non_attachment_skipped).toBe(0);
    expect(counters.orphans_no_time_created).toBe(0);
    expect(audited).toHaveLength(1);
    expect(audited[0]).toEqual(counters);
  });

  it("pre-delete recheck saves a candidate that became referenced after Set load", async () => {
    const { deps, audited, deleted, rechecks } = makeDeps({
      objects: [obj("uploads/raced", 48)],
      // bulk Set load said unreferenced, but a finalize landed in the
      // race window — recheck override flips it.
      referenced: [],
      rechecked: { "/objects/uploads/raced": true },
    });
    const counters = await sweepOrphans(deps);
    expect(deleted).toEqual([]);
    expect(rechecks).toEqual(["/objects/uploads/raced"]);
    expect(counters.recheck_saved).toBe(1);
    expect(counters.orphans_deleted).toBe(0);
    expect(audited[0]?.recheck_saved).toBe(1);
  });

  it("counts delete errors, keeps sweeping, and still audits", async () => {
    const { deps, audited, deleted } = makeDeps({
      objects: [obj("uploads/old1", 48), obj("uploads/old2", 48)],
      referenced: [],
      deleteOutcomes: { "uploads/old1": "error" },
    });
    const counters = await sweepOrphans(deps);
    expect(deleted).toEqual([{ bucket: "test-bucket", name: "uploads/old2" }]);
    expect(counters.orphans_deleted).toBe(1);
    expect(counters.delete_errors).toBe(1);
    expect(counters.delete_404_idempotent).toBe(0);
    expect(audited).toHaveLength(1);
    expect(audited[0]?.delete_errors).toBe(1);
  });

  it("counts a 'not_found' delete as idempotent success, not an error", async () => {
    const { deps, audited, deleted } = makeDeps({
      objects: [obj("uploads/already-gone", 48)],
      referenced: [],
      deleteOutcomes: { "uploads/already-gone": "not_found" },
    });
    const counters = await sweepOrphans(deps);
    // 'not_found' deliberately does NOT push into `deleted` (the
    // fake mirrors GCS — nothing actually deleted because nothing
    // was there); the counter records the idempotent classification.
    expect(deleted).toEqual([]);
    expect(counters.delete_404_idempotent).toBe(1);
    expect(counters.orphans_deleted).toBe(0);
    expect(counters.delete_errors).toBe(0);
    expect(audited[0]?.delete_404_idempotent).toBe(1);
  });

  it("skips non-attachment objects but counts them", async () => {
    const { deps, audited, deleted, rechecks } = makeDeps({
      objects: [
        obj("uploads/old1", 48),
        obj("public/marketing.png", 48),
      ],
      referenced: [],
      unmatched: ["public/marketing.png"],
    });
    const counters = await sweepOrphans(deps);
    expect(deleted.map((d) => d.name)).toEqual(["uploads/old1"]);
    // Only the matched candidate triggers a recheck — the non-
    // attachment one is dropped before it ever becomes a delete
    // candidate.
    expect(rechecks).toEqual(["/objects/uploads/old1"]);
    expect(counters.non_attachment_skipped).toBe(1);
    expect(counters.orphans_deleted).toBe(1);
    expect(audited[0]?.non_attachment_skipped).toBe(1);
  });

  it("skip-and-warn for orphans missing timeCreated (no delete, no recheck)", async () => {
    const { deps, deleted, audited, rechecks } = makeDeps({
      objects: [obj("uploads/no-tc", null)],
      referenced: [],
    });
    const counters = await sweepOrphans(deps);
    expect(deleted).toEqual([]);
    expect(rechecks).toEqual([]);
    expect(counters.orphans_no_time_created).toBe(1);
    expect(counters.orphans_deleted).toBe(0);
    expect(audited[0]?.orphans_no_time_created).toBe(1);
  });

  it("emits an audit row even when the bucket is empty", async () => {
    const { deps, audited, deleted } = makeDeps({
      objects: [],
      referenced: ["/objects/uploads/whatever"],
    });
    const counters = await sweepOrphans(deps);
    expect(deleted).toEqual([]);
    expect(counters).toEqual({
      objects_scanned: 0,
      references_loaded: 1,
      orphans_deleted: 0,
      orphans_too_young: 0,
      orphans_no_time_created: 0,
      delete_errors: 0,
      delete_404_idempotent: 0,
      recheck_saved: 0,
      non_attachment_skipped: 0,
    });
    expect(audited).toHaveLength(1);
    expect(audited[0]).toEqual(counters);
  });

  it("respects a non-default grace window", async () => {
    const { deps, deleted, audited } = makeDeps({
      // 2h old, 1h grace → eligible for delete.
      objects: [obj("uploads/x", 2)],
      referenced: [],
      graceMs: HOUR_MS,
    });
    const counters = await sweepOrphans(deps);
    expect(deleted.map((d) => d.name)).toEqual(["uploads/x"]);
    expect(counters.orphans_deleted).toBe(1);
    expect(audited).toHaveLength(1);
  });
});

describe("attachmentKeyForObjectName", () => {
  it("returns the /objects/uploads/<id> key for an attachment object", () => {
    const env = { PRIVATE_OBJECT_DIR: "/test-bucket/.private" };
    expect(
      attachmentKeyForObjectName(".private/uploads/abc-uuid", env),
    ).toBe("/objects/uploads/abc-uuid");
  });

  it("returns null for objects outside the uploads/ prefix", () => {
    const env = { PRIVATE_OBJECT_DIR: "/test-bucket/.private" };
    expect(
      attachmentKeyForObjectName(".private/other/abc", env),
    ).toBeNull();
  });

  it("returns null for the bare uploads/ prefix with no id", () => {
    const env = { PRIVATE_OBJECT_DIR: "/test-bucket/.private" };
    expect(attachmentKeyForObjectName(".private/uploads/", env)).toBeNull();
  });

  it("works when PRIVATE_OBJECT_DIR has no entity prefix (bucket-only)", () => {
    const env = { PRIVATE_OBJECT_DIR: "/bucket-only" };
    expect(
      attachmentKeyForObjectName("uploads/xyz", env),
    ).toBe("/objects/uploads/xyz");
    expect(
      attachmentKeyForObjectName("other/xyz", env),
    ).toBeNull();
  });

  it("throws when PRIVATE_OBJECT_DIR is unset", () => {
    expect(() => attachmentKeyForObjectName("uploads/x", {})).toThrow(
      /PRIVATE_OBJECT_DIR not set/,
    );
  });
});
