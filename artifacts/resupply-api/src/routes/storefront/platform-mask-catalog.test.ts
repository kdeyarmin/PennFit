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
    stageSupabaseResponse("mask_models", "select", { data: MODEL_ROWS });
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
    stageSupabaseResponse("mask_models", "select", { data: MODEL_ROWS });
    stageChildCounts(301, 244);

    const res = await request(makeApp()).get("/platform/mask-catalog");

    expect(res.body.interfaceTypes).toEqual([
      { type: "nasal", models: 3 },
      { type: "full_face", models: 1 },
    ]);
  });

  it("counts PLATFORM rows only — never a tenant's private models", async () => {
    stageSupabaseResponse("mask_models", "select", { data: MODEL_ROWS });
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
    stageSupabaseResponse("mask_models", "select", { data: MODEL_ROWS });
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
    stageSupabaseResponse("mask_models", "select", { data: MODEL_ROWS });
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
    stageSupabaseResponse("mask_models", "select", { data: MODEL_ROWS });
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
    stageSupabaseResponse("mask_models", "select", { data: [] });

    const res = await request(makeApp()).get("/platform/mask-catalog");

    expect(res.status).toBe(200);
    expect(res.body.manufacturers).toEqual([]);
    expect(res.body.interfaceTypes).toEqual([]);
    expect(res.body.lastUpdatedAt).toBeNull();
  });
});
