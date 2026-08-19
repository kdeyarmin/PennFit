// loadFitAdjustments — the #22b closed loop's live-path loader.
//
// What matters here:
//  1. The key vocabulary: `mask_fit_outcomes.mask_id` carries the engine
//     SLUG (migration 0203), which is also what the engine looks up
//     (`fitAdjustments[mask.slug]`) — so the catalog pass is a FILTER
//     (never a multiplier for a mask outside the session's catalog), with
//     the model uuid accepted as a defensive fallback key.
//  2. One vote per order: re-answers of the same survey link must not
//     stack now that the signal steers live rankings.
//  3. Fail-soft: a database failure returns {} (neutral), never throws —
//     a fitting must not be lost to the tuning signal being unavailable.
//  4. The per-org cache actually short-circuits the second read.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockRow = {
  order_id: string | null;
  mask_id: string | null;
  fit_outcome: string;
};

const db = vi.hoisted(() => ({
  /** Rows returned for mask_fit_outcomes, in newest-first order. */
  rows: [] as MockRow[],
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
const SLUG = "resmed-airfit-p10";
const OTHER_SLUG = "not-in-catalog";

function mask(id: string, slug: string): CatalogMask {
  return { id, slug } as CatalogMask;
}

let orderSeq = 0;
/** Each generated row gets its OWN order — one vote each, like real
 *  distinct patients. Tests for the dedupe pass explicit order ids. */
function outcomeRows(
  maskKey: string,
  counts: { good: number; leaking: number; uncomfortable: number },
): MockRow[] {
  const row = (fit_outcome: string): MockRow => {
    orderSeq += 1;
    return {
      order_id: `00000000-0000-4000-9000-${String(orderSeq).padStart(12, "0")}`,
      mask_id: maskKey,
      fit_outcome,
    };
  };
  return [
    ...Array.from({ length: counts.good }, () => row("good")),
    ...Array.from({ length: counts.leaking }, () => row("leaking")),
    ...Array.from({ length: counts.uncomfortable }, () => row("uncomfortable")),
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
  it("applies slug-keyed outcomes (the 0203 vocabulary) to the matching catalog mask", async () => {
    db.rows = outcomeRows(SLUG, { good: 12, leaking: 0, uncomfortable: 0 });
    const out = await loadFitAdjustments(freshOrg(), [mask(MASK_ID, SLUG)]);
    // 12 all-good outcomes → sealScore 1 → 1 + 0.15, keyed by SLUG.
    expect(out).toEqual({ [SLUG]: 1.15 });
  });

  it("accepts uuid-keyed outcomes as the defensive fallback", async () => {
    db.rows = outcomeRows(MASK_ID, { good: 12, leaking: 0, uncomfortable: 0 });
    const out = await loadFitAdjustments(freshOrg(), [mask(MASK_ID, SLUG)]);
    expect(out).toEqual({ [SLUG]: 1.15 });
  });

  it("stays neutral (omits the key) below minSamples", async () => {
    db.rows = outcomeRows(SLUG, { good: 5, leaking: 0, uncomfortable: 0 });
    const out = await loadFitAdjustments(freshOrg(), [mask(MASK_ID, SLUG)]);
    expect(out).toEqual({});
  });

  it("never returns a multiplier for a mask outside the catalog", async () => {
    db.rows = [
      ...outcomeRows(SLUG, { good: 12, leaking: 0, uncomfortable: 0 }),
      ...outcomeRows(OTHER_SLUG, { good: 0, leaking: 12, uncomfortable: 0 }),
    ];
    const out = await loadFitAdjustments(freshOrg(), [mask(MASK_ID, SLUG)]);
    expect(Object.keys(out)).toEqual([SLUG]);
  });

  it("counts only the LATEST outcome per order (re-answers don't stack)", async () => {
    // Eleven rows, but ten of them are the SAME order re-answered — one
    // replayed survey link must never clear minSamples on its own now
    // that the signal steers live rankings.
    const sameOrder = "11111111-1111-4111-8111-111111111111";
    db.rows = [
      // Newest-first: the latest word on the replayed order is "good".
      ...Array.from({ length: 10 }, () => ({
        order_id: sameOrder,
        mask_id: SLUG,
        fit_outcome: "good",
      })),
      ...outcomeRows(SLUG, { good: 1, leaking: 0, uncomfortable: 0 }),
    ];
    const out = await loadFitAdjustments(freshOrg(), [mask(MASK_ID, SLUG)]);
    // 2 distinct orders < minSamples (10) → neutral.
    expect(out).toEqual({});
  });

  it("fails soft to neutral on a database error", async () => {
    db.error = { message: "connection refused" };
    const out = await loadFitAdjustments(freshOrg(), [mask(MASK_ID, SLUG)]);
    expect(out).toEqual({});
  });

  it("serves the second read from cache", async () => {
    db.rows = outcomeRows(SLUG, { good: 12, leaking: 0, uncomfortable: 0 });
    const org = freshOrg();
    const catalog = [mask(MASK_ID, SLUG)];
    await loadFitAdjustments(org, catalog);
    const readsAfterFirst = db.reads;
    const again = await loadFitAdjustments(org, catalog);
    expect(db.reads).toBe(readsAfterFirst);
    expect(again).toEqual({ [SLUG]: 1.15 });
  });

  it("re-reads after invalidation", async () => {
    db.rows = outcomeRows(SLUG, { good: 12, leaking: 0, uncomfortable: 0 });
    const org = freshOrg();
    const catalog = [mask(MASK_ID, SLUG)];
    await loadFitAdjustments(org, catalog);
    const readsAfterFirst = db.reads;
    invalidateFitAdjustments(org);
    await loadFitAdjustments(org, catalog);
    expect(db.reads).toBeGreaterThan(readsAfterFirst);
  });

  it("pages past the first 1000 rows", async () => {
    // 1000 leaking + 200 good (all distinct orders) for the same mask. A
    // single unpaged read would see only the first 1000 (all leaking) and
    // tally the wrong seal score; paging sees all 1200.
    db.rows = [
      ...outcomeRows(SLUG, { good: 0, leaking: 1000, uncomfortable: 0 }),
      ...outcomeRows(SLUG, { good: 200, leaking: 0, uncomfortable: 0 }),
    ];
    const out = await loadFitAdjustments(freshOrg(), [mask(MASK_ID, SLUG)]);
    // sealScore = (200 - 1000) / 1200 = -0.6667 → 1 - 0.6667*0.15 = 0.9
    expect(out[SLUG]).toBeCloseTo(0.9, 3);
    expect(db.reads).toBeGreaterThan(1);
  });
});
