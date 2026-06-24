// Regression guard (structural source check): the nightly therapy-sync
// scan MUST keyset-bound and rotate by staleness. The previous unpaginated
// read truncated at PostgREST's ~1000-row cap in an arbitrary order, so the
// same ~1000 active links were synced every night and the rest never were.
// Ordering by last_synced_at (nulls first) rotates coverage across nights;
// the per-run limit keeps the throttled fetch loop within the job lease. A
// behavioural test would need a paged Supabase mock plus adapter stubs;
// pin the invariants cheaply, like the dedup / IDOR source checks elsewhere
// in this tree.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { integrationSnapshotSchema } from "@workspace/resupply-integrations";

import { normalizeSnapshotForPersistence } from "./therapy-integrations-nightly-sync";

const SRC = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "therapy-integrations-nightly-sync.ts",
  ),
  "utf8",
);

describe("therapy nightly-sync — bounded, rotating scan", () => {
  it("does not use a raw high .limit() that PostgREST would silently cap", () => {
    expect(SRC).not.toContain(".limit(5000)");
  });

  it("rotates by least-recently-synced (last_synced_at, nulls first)", () => {
    expect(SRC).toContain(
      '.order("last_synced_at", { ascending: true, nullsFirst: true })',
    );
  });

  it("bounds the scan to one page per run", () => {
    expect(SRC).toContain(".limit(MAX_LINKS_PER_RUN)");
  });

  it("stamps last_synced_at on a schema-validation failure (no rotation starvation)", () => {
    // The validation-failure branch must stamp the link (mirroring the
    // fetch-error branch) so a persistently malformed payload can't keep
    // sorting to the front of every night's page.
    expect(SRC).toContain("snapshot_failed_schema_validation");
  });

  it("stamps links skipped for a missing / unavailable adapter so they rotate", () => {
    expect(SRC).toContain("stampLinkSkipped(supabase, link.id");
    expect(SRC).toContain('"adapter_missing"');
    expect(SRC).toContain('"adapter_unavailable"');
  });

  it("scopes the integration-health counter per tenant (not a global key)", () => {
    // A global key lets a healthy tenant reset a failing tenant's
    // consecutive-failure counter across the forEachActiveOrg fan-out.
    expect(SRC).toContain(
      "const healthKey = `${THERAPY_NIGHTLY_SYNC_JOB}:${orgId}`",
    );
    expect(SRC).toContain("recordIntegrationFailure(\n      healthKey,");
    expect(SRC).toContain("recordIntegrationSuccess(healthKey)");
  });
});

describe("normalizeSnapshotForPersistence — per-night resilience", () => {
  const baseSnapshot = {
    source: "resmed_airview",
    partnerPatientId: "pp1",
    settings: null,
    compliance: null,
    supplies: [],
  };

  it("salvages a snapshot with quirky nights instead of dropping everything", () => {
    const raw = {
      ...baseSnapshot,
      recentNights: [
        // ISO timestamp date + fractional minutes + negative leak.
        {
          nightDate: "2026-01-15T08:00:00Z",
          usageMinutes: 245.7,
          ahi: 3.2,
          leakRateLMin: -5,
          pressureP95Cmh2o: 9.4,
        },
        // unsalvageable date -> this night (only) is dropped
        { nightDate: "not-a-date", usageMinutes: 100 },
        // already clean
        {
          nightDate: "2026-01-16",
          usageMinutes: 300,
          ahi: null,
          leakRateLMin: null,
          pressureP95Cmh2o: null,
        },
      ],
    };
    const normalized = normalizeSnapshotForPersistence(raw);
    // The whole snapshot now passes schema validation (was all-or-nothing).
    const parsed = integrationSnapshotSchema.safeParse(normalized);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.recentNights).toHaveLength(2);
    expect(parsed.data.recentNights[0]).toMatchObject({
      nightDate: "2026-01-15",
      usageMinutes: 246, // rounded
      leakRateLMin: null, // negative -> null, not a misleading 0
    });
    expect(parsed.data.recentNights[1]!.nightDate).toBe("2026-01-16");
  });

  it("salvages a supply line with a full ISO timestamp instead of dropping the whole snapshot", () => {
    const raw = {
      ...baseSnapshot,
      recentNights: [
        {
          nightDate: "2026-01-16",
          usageMinutes: 300,
          ahi: null,
          leakRateLMin: null,
          pressureP95Cmh2o: null,
        },
      ],
      supplies: [
        // Vendor returns a timestamped date — would fail the strict
        // `^\d{4}-\d{2}-\d{2}$` regex and nuke the entire snapshot.
        {
          category: "mask",
          description: "AirFit P10",
          lastReplacedDate: "2025-12-01T00:00:00Z",
          nextEligibleDate: "2026-06-01",
        },
        // Non-date garbage -> coerced to null (the field is nullable).
        {
          category: "filter",
          description: "Disposable filter",
          lastReplacedDate: "whenever",
          nextEligibleDate: null,
        },
      ],
    };
    const normalized = normalizeSnapshotForPersistence(raw);
    const parsed = integrationSnapshotSchema.safeParse(normalized);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // Every valid night survived alongside the salvaged supplies.
    expect(parsed.data.recentNights).toHaveLength(1);
    expect(parsed.data.supplies).toHaveLength(2);
    expect(parsed.data.supplies[0]).toMatchObject({
      category: "mask",
      lastReplacedDate: "2025-12-01", // ISO timestamp -> date
      nextEligibleDate: "2026-06-01",
    });
    expect(parsed.data.supplies[1]!.lastReplacedDate).toBeNull(); // unsalvageable -> null
  });

  it("drops only a supply line whose category is unusable, keeping the rest", () => {
    const raw = {
      ...baseSnapshot,
      recentNights: [],
      supplies: [
        { category: "not-a-real-category", description: "junk", lastReplacedDate: null, nextEligibleDate: null },
        { category: "tubing", description: "Standard tube", lastReplacedDate: null, nextEligibleDate: null },
      ],
    };
    const normalized = normalizeSnapshotForPersistence(raw);
    const parsed = integrationSnapshotSchema.safeParse(normalized);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.supplies).toHaveLength(1);
    expect(parsed.data.supplies[0]!.category).toBe("tubing");
  });

  it("leaves a snapshot without recentNights untouched", () => {
    const snap = { ...baseSnapshot };
    expect(normalizeSnapshotForPersistence(snap)).toEqual(snap);
  });

  it("returns non-object input unchanged", () => {
    expect(normalizeSnapshotForPersistence(null)).toBeNull();
    expect(normalizeSnapshotForPersistence("x")).toBe("x");
  });
});
