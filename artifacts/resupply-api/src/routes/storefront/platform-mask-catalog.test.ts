// Tests for GET /api/platform/mask-catalog — the PUBLIC coverage stats the
// Breathe marketing site renders on /breathe/mask-fitting.
//
// Contract: no auth; per-manufacturer model counts aggregated from
// `mask_models`; PLATFORM rows only (`org_id IS NULL` — a tenant's private
// formulary additions never reach a public figure, directly or via a child
// count); aggregate-only (no slugs or model names); fail-soft to an empty
// roster (still 200) on a DB error.

import { describe, it, expect, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseFilterCalls,
  getSupabaseFilterCallsByInvocation,
  getSupabaseTouchedKeys,
  getSupabaseTouchedRpcFns,
  type CapturedFilterCall,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import platformMaskCatalogRouter from "./platform-mask-catalog";

function makeApp(): Express {
  const app = express();
  app.use(platformMaskCatalogRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
});

const MODEL_ROWS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    manufacturer: "ResMed",
    status: "current",
    interface_type: "full_face",
    updated_at: "2026-08-22T06:36:41.066Z",
    // Internal fields that must NOT appear in the public response.
    slug: "resmed-airfit-f20",
    model_name: "AirFit F20",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    manufacturer: "ResMed",
    status: "discontinued",
    interface_type: "nasal",
    updated_at: "2026-07-01T00:00:00.000Z",
    slug: "resmed-airfit-n10",
    model_name: "AirFit N10",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    manufacturer: "ResMed",
    status: "current",
    interface_type: "nasal",
    updated_at: "2026-06-01T00:00:00.000Z",
    slug: "resmed-airfit-n20",
    model_name: "AirFit N20",
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    manufacturer: "Fisher & Paykel",
    status: "current",
    interface_type: "nasal",
    updated_at: "2026-05-01T00:00:00.000Z",
    slug: "fisher-paykel-eson2",
    model_name: "Eson 2 Nasal",
  },
];

/**
 * The route pages the model read until a page comes back empty, so every
 * test that stages model rows must stage that terminating empty page too.
 */
function stageModels(rows: unknown[]): void {
  stageSupabaseResponse("mask_models", "select", { data: rows });
  stageSupabaseResponse("mask_models", "select", { data: [] });
}

function stageChildCounts(sizeVariants: number, components: number): void {
  stageSupabaseResponse("mask_size_variants", "select", {
    data: null,
    count: sizeVariants,
  });
  stageSupabaseResponse("mask_components", "select", {
    data: null,
    count: components,
  });
}

describe("GET /api/platform/mask-catalog", () => {
  it("aggregates per-manufacturer counts with a cache header", async () => {
    stageModels(MODEL_ROWS);
    stageChildCounts(301, 244);

    const res = await request(makeApp()).get("/platform/mask-catalog");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("max-age=300");
    // Biggest roster first.
    expect(res.body.manufacturers).toEqual([
      { name: "ResMed", models: 3, currentModels: 2 },
      { name: "Fisher & Paykel", models: 1, currentModels: 1 },
    ]);
    expect(res.body.totals).toEqual({
      manufacturers: 2,
      models: 4,
      currentModels: 3,
      discontinuedModels: 1,
      sizeVariants: 301,
      components: 244,
    });
    // Most recent `updated_at` across the roster — the marketing page's
    // "last updated" proof point.
    expect(res.body.lastUpdatedAt).toBe("2026-08-22T06:36:41.066Z");
  });

  it("breaks the roster down by interface type, biggest first", async () => {
    stageModels(MODEL_ROWS);
    stageChildCounts(301, 244);

    const res = await request(makeApp()).get("/platform/mask-catalog");

    expect(res.body.interfaceTypes).toEqual([
      { type: "nasal", models: 3 },
      { type: "full_face", models: 1 },
    ]);
  });

  it("counts PLATFORM rows only — never a tenant's private models", async () => {
    stageModels(MODEL_ROWS);
    stageChildCounts(301, 244);

    await request(makeApp()).get("/platform/mask-catalog");

    // The model read filters org_id IS NULL...
    expect(getSupabaseFilterCalls("mask_models", "select")).toContainEqual({
      verb: "is",
      args: ["org_id", null],
    });
    // ...and the child counts ride the same filter across the join, since
    // variants/components carry no org_id of their own.
    for (const table of ["mask_size_variants", "mask_components"] as const) {
      expect(getSupabaseFilterCalls(table, "select")).toContainEqual({
        verb: "is",
        args: ["mask_models.org_id", null],
      });
    }
  });

  it("never leaks model names, slugs, or any per-model detail", async () => {
    stageModels(MODEL_ROWS);
    stageChildCounts(301, 244);

    const res = await request(makeApp()).get("/platform/mask-catalog");
    const blob = JSON.stringify(res.body);

    expect(blob).not.toContain("resmed-airfit-f20");
    expect(blob).not.toContain("AirFit");
    expect(blob).not.toContain("Eson");
    // Row ids are read for the child-count fallback but are never published.
    for (const row of MODEL_ROWS) expect(blob).not.toContain(row.id);
  });

  it("falls back to an explicit id list when the join embed is rejected", async () => {
    stageModels(MODEL_ROWS);
    // First call (the embed) errors, second (the id list) succeeds.
    stageSupabaseResponse("mask_size_variants", "select", {
      error: { message: "could not find a relationship" },
    });
    stageSupabaseResponse("mask_size_variants", "select", {
      data: null,
      count: 301,
    });
    stageChildCounts(0, 244);

    const res = await request(makeApp()).get("/platform/mask-catalog");

    expect(res.status).toBe(200);
    expect(res.body.totals.sizeVariants).toBe(301);
    // The fallback is still scoped to platform models, by id.
    const filters = getSupabaseFilterCalls("mask_size_variants", "select");
    expect(filters).toContainEqual({
      verb: "in",
      args: ["mask_model_id", MODEL_ROWS.map((r) => r.id)],
    });
  });

  it("omits a child count (null) rather than printing a zero it can't stand behind", async () => {
    stageModels(MODEL_ROWS);
    // Both the embed and the id-list fallback fail.
    stageSupabaseResponse("mask_size_variants", "select", {
      error: { message: "boom" },
    });
    stageSupabaseResponse("mask_size_variants", "select", {
      error: { message: "boom again" },
    });
    stageSupabaseResponse("mask_components", "select", {
      data: null,
      count: 244,
    });

    const res = await request(makeApp()).get("/platform/mask-catalog");

    expect(res.status).toBe(200);
    expect(res.body.totals.sizeVariants).toBeNull();
    expect(res.body.totals.components).toBe(244);
    // The roster itself still renders.
    expect(res.body.totals.models).toBe(4);
  });

  it("fail-soft: returns an empty roster (200) when the read errors", async () => {
    stageSupabaseResponse("mask_models", "select", {
      error: { message: "boom" },
    });

    const res = await request(makeApp()).get("/platform/mask-catalog");

    expect(res.status).toBe(200);
    expect(res.body.manufacturers).toEqual([]);
    expect(res.body.totals.models).toBe(0);
    expect(res.body.totals.sizeVariants).toBeNull();
  });

  it("fail-soft: an empty catalog returns the empty roster, not a partial", async () => {
    stageModels([]);

    const res = await request(makeApp()).get("/platform/mask-catalog");

    expect(res.status).toBe(200);
    expect(res.body.manufacturers).toEqual([]);
    expect(res.body.interfaceTypes).toEqual([]);
    expect(res.body.lastUpdatedAt).toBeNull();
  });
});

describe("GET /api/platform/mask-catalog — paging and cache posture", () => {
  it("walks every page of the model catalog, not just the first", async () => {
    // A server-side row cap returns a short page; the walk must continue
    // until a page comes back empty rather than stopping at the first one.
    stageSupabaseResponse("mask_models", "select", { data: MODEL_ROWS });
    stageSupabaseResponse("mask_models", "select", {
      data: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          manufacturer: "Sleepnet",
          status: "current",
          interface_type: "nasal",
          updated_at: "2026-08-23T00:00:00.000Z",
        },
      ],
    });
    stageSupabaseResponse("mask_models", "select", { data: [] });
    stageChildCounts(248, 244);

    const res = await request(makeApp()).get("/platform/mask-catalog");

    expect(res.body.totals.models).toBe(5);
    expect(res.body.totals.manufacturers).toBe(3);
    // The page-2 row also wins the freshness comparison.
    expect(res.body.lastUpdatedAt).toBe("2026-08-23T00:00:00.000Z");
  });

  it("orders the paged read so rows can't repeat or be skipped", async () => {
    stageModels(MODEL_ROWS);
    stageChildCounts(248, 244);

    await request(makeApp()).get("/platform/mask-catalog");

    expect(getSupabaseFilterCalls("mask_models", "select")).toContainEqual({
      verb: "order",
      args: ["id"],
    });
  });

  it("counts only size variants that carry a millimetre band", async () => {
    stageModels(MODEL_ROWS);
    stageChildCounts(248, 244);

    await request(makeApp()).get("/platform/mask-catalog");

    // The seed holds dimensionless rows (tube-up frames); counting them
    // would overstate the "with millimetre bands" label the page prints.
    const variantFilters = getSupabaseFilterCalls(
      "mask_size_variants",
      "select",
    );
    const or = variantFilters.find((c) => c.verb === "or");
    expect(or).toBeDefined();
    expect(String(or!.args[0])).toContain("nose_width_min_mm.not.is.null");
    expect(String(or!.args[0])).toContain("nostril_width_max_mm.not.is.null");
    // Components have no equivalent qualifier — every one is HCPCS-coded.
    expect(
      getSupabaseFilterCalls("mask_components", "select").some(
        (c) => c.verb === "or",
      ),
    ).toBe(false);
  });

  it("caches the fail-soft response briefly so an outage isn't amplified", async () => {
    stageSupabaseResponse("mask_models", "select", {
      error: { message: "boom" },
    });

    const res = await request(makeApp()).get("/platform/mask-catalog");

    expect(res.status).toBe(200);
    // Short, not the success path's 5 minutes: shed load during an incident
    // without pinning an empty roster once the DB recovers.
    expect(res.headers["cache-control"]).toContain("max-age=30");
  });

  it("caches an empty catalog the same way", async () => {
    stageModels([]);

    const res = await request(makeApp()).get("/platform/mask-catalog");

    expect(res.headers["cache-control"]).toContain("max-age=30");
  });
});

describe("tenancy — EVERY read is platform-scoped, not just the first", () => {
  // Why this block exists.
  //
  // This file is on the EXCLUDES allowlist in
  // scripts/check-tenant-isolation.sh, so the CI guard that would otherwise
  // fail the build on an unscoped getSupabaseServiceRoleClient() read here is
  // deliberately off — and it is off for the whole FILE, permanently,
  // including reads nobody has written yet. The exemption is only worth as
  // much as the assertion standing in for it.
  //
  // The `toContainEqual` check above is not that assertion. It proves SOME
  // read carried the tenancy filter, against a filter log the mock flattens
  // across every invocation. Add a second, unfiltered `mask_models` read to
  // this route tomorrow and it still passes — the first read's filter is
  // still somewhere in the flattened array — while the CI guard stays silent
  // because the file is allowlisted. That is the gap these close: they fail
  // if ANY query this route issues is missing its scope.

  /**
   * Does one invocation constrain itself to PLATFORM rows?
   *
   * Three legitimate shapes, matching the three reads the route makes:
   *   * `.is("org_id", null)`               — mask_models carries org_id itself
   *   * `.is("mask_models.org_id", null)`   — child tables, across the !inner join
   *   * `.in("mask_model_id", platformIds)` — the id-list fallback, whose ids
   *     are derived from the already-platform-filtered model rows
   */
  function scopedToPlatform(call: CapturedFilterCall[]): boolean {
    return call.some(
      (c) =>
        (c.verb === "is" &&
          (c.args[0] === "org_id" || c.args[0] === "mask_models.org_id") &&
          c.args[1] === null) ||
        (c.verb === "in" && c.args[0] === "mask_model_id"),
    );
  }

  /** Assert the invariant across every invocation, naming any that fails. */
  function expectEveryReadScoped(table: string): void {
    const calls = getSupabaseFilterCallsByInvocation(table, "select");
    expect(calls.length).toBeGreaterThan(0);
    const unscoped = calls
      .map((call, i) => ({ i, call }))
      .filter(({ call }) => !scopedToPlatform(call));
    expect(
      unscoped.map(
        ({ i, call }) => `${table} read #${i + 1}: ${JSON.stringify(call)}`,
      ),
    ).toEqual([]);
  }

  it("scopes every page of the model read, not just the first", async () => {
    // Three invocations: two data pages and the terminating empty page. A
    // filter applied only to page one would leak a tenant's private models
    // into the public total from page two onward.
    stageSupabaseResponse("mask_models", "select", { data: MODEL_ROWS });
    stageSupabaseResponse("mask_models", "select", {
      data: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          manufacturer: "Sleepnet",
          status: "current",
          interface_type: "nasal",
          updated_at: "2026-08-23T00:00:00.000Z",
        },
      ],
    });
    stageSupabaseResponse("mask_models", "select", { data: [] });
    stageChildCounts(248, 244);

    await request(makeApp()).get("/platform/mask-catalog");

    expect(
      getSupabaseFilterCallsByInvocation("mask_models", "select"),
    ).toHaveLength(3);
    expectEveryReadScoped("mask_models");
  });

  it("scopes every child-count read on the embed path", async () => {
    stageModels(MODEL_ROWS);
    stageChildCounts(301, 244);

    await request(makeApp()).get("/platform/mask-catalog");

    expectEveryReadScoped("mask_size_variants");
    expectEveryReadScoped("mask_components");
  });

  it("scopes the fallback read too when the embed is rejected", async () => {
    // Two invocations on the variants table: the embed that errors, and the
    // id-list fallback. BOTH must be scoped — the fallback is the one that
    // actually produces the published number.
    stageModels(MODEL_ROWS);
    stageSupabaseResponse("mask_size_variants", "select", {
      error: { message: "could not find a relationship" },
    });
    stageSupabaseResponse("mask_size_variants", "select", {
      data: null,
      count: 301,
    });
    stageChildCounts(0, 244);

    await request(makeApp()).get("/platform/mask-catalog");

    const calls = getSupabaseFilterCallsByInvocation(
      "mask_size_variants",
      "select",
    );
    expect(calls).toHaveLength(2);
    expectEveryReadScoped("mask_size_variants");
    // And the fallback's id list is the platform roster — not an unbounded
    // or tenant-inclusive set.
    const ids = calls[1].find((c) => c.verb === "in")?.args[1];
    expect(ids).toEqual(MODEL_ROWS.map((r) => r.id));
  });

  it("reads exactly three tables — the complete set, not a sample", async () => {
    // A read the route is not supposed to make is the other way an exempted
    // file drifts: the guard would have caught a new unscoped table here.
    //
    // Asserted as SET EQUALITY over everything the route touched, not as a
    // denylist of tables we happened to think of. A denylist cannot fail for
    // a table nobody named — and since an unstaged call resolves to a
    // success envelope, a stray read from, say, `prescriptions` would
    // neither throw nor be looked at. This fails on any table not listed.
    stageModels(MODEL_ROWS);
    stageChildCounts(301, 244);

    await request(makeApp()).get("/platform/mask-catalog");

    expect(getSupabaseTouchedKeys()).toEqual([
      "mask_components.select",
      "mask_models.select",
      "mask_size_variants.select",
    ]);
    // Reads only — no insert/update/upsert/delete from a public endpoint —
    // is implied by the `.select` suffix on every key above. An RPC would
    // bypass the table log entirely, so pin that surface as empty too.
    expect(getSupabaseTouchedRpcFns()).toEqual([]);

    // ...and each of the three is platform-scoped on every invocation.
    for (const table of [
      "mask_models",
      "mask_size_variants",
      "mask_components",
    ]) {
      expectEveryReadScoped(table);
    }
  });
});
