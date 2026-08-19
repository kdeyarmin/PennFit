// loadFitAdjustments — the #22b closed loop's live-path loader.
//
// What matters here:
//  1. The key translation: outcomes carry mask_models.id (uuid), the
//     engine looks up fitAdjustments[mask.slug]. A multiplier must come
//     back keyed by slug, and only for masks in the session's catalog.
//  2. Fail-soft: a database failure returns {} (neutral), never throws —
//     a fitting must not be lost to the tuning signal being unavailable.
//  3. The per-org cache actually short-circuits the second read.
//  4. The degraded/static catalog (ids are slugs, not uuids) resolves no
//     matches and stays neutral rather than mis-keying.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  /** Rows returned for mask_fit_outcomes, in newest-first order. */
  rows: [] as Array<{ mask_id: string | null; fit_outcome: string }>,
  /** When set, every read resolves with this error. */
  error: null as { message: string } | null,
  /** Number of .range() calls observed (one per page). */
  reads: 0,
}));

vi.mock("@workspace/resupply-db", () => {
  const builder = () => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const method of [
      "select",
      "not",
      "order",
      "eq",
      "neq",
      "or",
      "limit",
    ]) {
      chain[method] = () => self();
    }
    chain.range = async (from: number, to: number) => {
      db.reads += 1;
      if (db.error) return { data: null, error: db.error };
      return { data: db.rows.slice(from, to + 1), error: null };
    };
    return chain;
  };
  return {
    getOrgScopedClient: vi.fn(() => ({
      from: () => builder(),
      raw: () => ({ schema: () => ({ from: () => builder() }) }),
    })),
  };
});

import { invalidateFitAdjustments, loadFitAdjustments } from "./catalog-store";
import type { CatalogMask } from "./types";

const MASK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function mask(id: string, slug: string): CatalogMask {
  return { id, slug } as CatalogMask;
}

function outcomeRows(
  maskId: string,
  counts: { good: number; leaking: number; uncomfortable: number },
) {
  return [
    ...Array.from({ length: counts.good }, () => ({
      mask_id: maskId,
      fit_outcome: "good",
    })),
    ...Array.from({ length: counts.leaking }, () => ({
      mask_id: maskId,
      fit_outcome: "leaking",
    })),
    ...Array.from({ length: counts.uncomfortable }, () => ({
      mask_id: maskId,
      fit_outcome: "uncomfortable",
    })),
  ];
}

let orgSeq = 0;
/** A fresh org per test so the module-level cache never bleeds across. */
function freshOrg(): string {
  orgSeq += 1;
  return `00000000-0000-4000-8000-${String(orgSeq).padStart(12, "0")}`;
}

beforeEach(() => {
  db.rows = [];
  db.error = null;
  db.reads = 0;
});

afterEach(() => {
  invalidateFitAdjustments();
});

describe("loadFitAdjustments", () => {
  it("maps uuid-keyed multipliers onto catalog slugs", async () => {
    db.rows = outcomeRows(MASK_ID, { good: 12, leaking: 0, uncomfortable: 0 });
    const out = await loadFitAdjustments(freshOrg(), [
      mask(MASK_ID, "resmed-airfit-p10"),
    ]);
    // 12 all-good outcomes → sealScore 1 → 1 + 0.15, keyed by SLUG.
    expect(out).toEqual({ "resmed-airfit-p10": 1.15 });
  });

  it("stays neutral (omits the key) below minSamples", async () => {
    db.rows = outcomeRows(MASK_ID, { good: 5, leaking: 0, uncomfortable: 0 });
    const out = await loadFitAdjustments(freshOrg(), [
      mask(MASK_ID, "resmed-airfit-p10"),
    ]);
    expect(out).toEqual({});
  });

  it("never returns a multiplier for a mask outside the catalog", async () => {
    db.rows = [
      ...outcomeRows(MASK_ID, { good: 12, leaking: 0, uncomfortable: 0 }),
      ...outcomeRows(OTHER_ID, { good: 0, leaking: 12, uncomfortable: 0 }),
    ];
    const out = await loadFitAdjustments(freshOrg(), [
      mask(MASK_ID, "in-catalog"),
    ]);
    expect(Object.keys(out)).toEqual(["in-catalog"]);
  });

  it("resolves no matches against the degraded static catalog (slug ids)", async () => {
    db.rows = outcomeRows(MASK_ID, { good: 12, leaking: 0, uncomfortable: 0 });
    // Static-catalog masks use the slug AS the id — no uuid ever matches.
    const out = await loadFitAdjustments(freshOrg(), [
      mask("resmed-airfit-f20", "resmed-airfit-f20"),
    ]);
    expect(out).toEqual({});
  });

  it("fails soft to neutral on a database error", async () => {
    db.error = { message: "connection refused" };
    const out = await loadFitAdjustments(freshOrg(), [
      mask(MASK_ID, "resmed-airfit-p10"),
    ]);
    expect(out).toEqual({});
  });

  it("serves the second read from cache", async () => {
    db.rows = outcomeRows(MASK_ID, { good: 12, leaking: 0, uncomfortable: 0 });
    const org = freshOrg();
    const catalog = [mask(MASK_ID, "resmed-airfit-p10")];
    await loadFitAdjustments(org, catalog);
    const readsAfterFirst = db.reads;
    const again = await loadFitAdjustments(org, catalog);
    expect(db.reads).toBe(readsAfterFirst);
    expect(again).toEqual({ "resmed-airfit-p10": 1.15 });
  });

  it("re-reads after invalidation", async () => {
    db.rows = outcomeRows(MASK_ID, { good: 12, leaking: 0, uncomfortable: 0 });
    const org = freshOrg();
    const catalog = [mask(MASK_ID, "resmed-airfit-p10")];
    await loadFitAdjustments(org, catalog);
    const readsAfterFirst = db.reads;
    invalidateFitAdjustments(org);
    await loadFitAdjustments(org, catalog);
    expect(db.reads).toBeGreaterThan(readsAfterFirst);
  });

  it("pages past the first 1000 rows", async () => {
    // 1000 leaking + 200 good for the same mask. A single unpaged read
    // would see only the first 1000 (all leaking) and tally the wrong
    // seal score; paging sees all 1200.
    db.rows = [
      ...outcomeRows(MASK_ID, { good: 0, leaking: 1000, uncomfortable: 0 }),
      ...outcomeRows(MASK_ID, { good: 200, leaking: 0, uncomfortable: 0 }),
    ];
    const out = await loadFitAdjustments(freshOrg(), [
      mask(MASK_ID, "resmed-airfit-p10"),
    ]);
    // sealScore = (200 - 1000) / 1200 = -0.6667 → 1 - 0.6667*0.15 = 0.9
    expect(out["resmed-airfit-p10"]).toBeCloseTo(0.9, 3);
    expect(db.reads).toBeGreaterThan(1);
  });
});
