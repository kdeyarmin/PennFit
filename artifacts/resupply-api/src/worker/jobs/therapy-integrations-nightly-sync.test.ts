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

  it("leaves a snapshot without recentNights untouched", () => {
    const snap = { ...baseSnapshot };
    expect(normalizeSnapshotForPersistence(snap)).toEqual(snap);
  });

  it("returns non-object input unchanged", () => {
    expect(normalizeSnapshotForPersistence(null)).toBeNull();
    expect(normalizeSnapshotForPersistence("x")).toBe("x");
  });
});
