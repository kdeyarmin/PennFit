// Route tests for /admin/analytics/fitter-outcomes.
//
// The cohort math is unit-tested in @workspace/resupply-domain; what is
// tested here is the sourcing layer — that rows map onto the report's
// inputs correctly, that a capped read is REPORTED as capped rather than
// rendering as a clean rate, and that unrecognised enum values degrade
// safely instead of inventing a bucket or throwing.

import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
// `mask_fit_outcomes.mask_id` holds the recommendation engine's string id
// (see data/maskCatalog.ts), NOT a uuid — the catalog's matching column is
// `mask_models.slug`. Using a realistic value here is the point: the
// earlier uuid fixture made a broken id-vs-slug join look correct.
const MASK_A = "resmed-airfit-f20";
const MASK_MODEL_UUID = "11111111-1111-4111-8111-111111111111";

vi.mock("../../middlewares/requireAdmin", () => ({
  requireAdmin: (
    req: Record<string, unknown>,
    _res: unknown,
    next: () => void,
  ) => {
    req.orgId = ORG_ID;
    next();
  },
  requirePermission:
    () => (req: Record<string, unknown>, _s: unknown, next: () => void) => {
      req.orgId = ORG_ID;
      next();
    },
}));
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminReadRateLimiter: (_r: unknown, _s: unknown, next: () => void) => next(),
}));

const supabaseMock = installSupabaseMock();

import fitterOutcomesRouter from "./analytics-fitter-outcomes";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(fitterOutcomesRouter);
  return app;
}

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    created_at: "2026-08-01T00:00:00Z",
    entry_point: "remote_link",
    outcome: "high_confidence",
    scan_quality_grade: "good",
    degraded: false,
    primary_mask_model_id: MASK_A,
    override_mask_model_id: null,
    override_reason: null,
    ordered_mask_model_id: MASK_A,
    reviewed_at: null,
    dispensed_at: null,
    ...over,
  };
}

beforeEach(() => supabaseMock.reset());

describe("GET /admin/analytics/fitter-outcomes", () => {
  it("rolls sessions and fit surveys into a report", async () => {
    stageSupabaseResponse("fit_sessions", "select", {
      data: [sessionRow(), sessionRow({ id: "s2", entry_point: "in_office" })],
    });
    stageSupabaseResponse("mask_fit_outcomes", "select", {
      data: [
        { mask_id: MASK_A, fit_outcome: "good" },
        { mask_id: MASK_A, fit_outcome: "leaking" },
      ],
    });
    stageSupabaseResponse("mask_models", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/admin/analytics/fitter-outcomes?days=30",
    );

    expect(res.status).toBe(200);
    expect(res.body.window.days).toBe(30);
    expect(res.body.report.sessions.total).toBe(2);
    expect(res.body.report.sessions.byEntryPoint.in_office).toBe(1);
    expect(res.body.report.refit.responses).toBe(2);
    expect(res.body.report.refit.refitRate).toBeCloseTo(0.5);
  });

  it("reports null rates on an empty tenant rather than a perfect score", async () => {
    stageSupabaseResponse("fit_sessions", "select", { data: [] });
    stageSupabaseResponse("mask_fit_outcomes", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/admin/analytics/fitter-outcomes",
    );

    expect(res.status).toBe(200);
    expect(res.body.report.refit.refitRate).toBeNull();
    expect(res.body.report.acceptance.acceptanceRate).toBeNull();
    expect(res.body.truncated).toEqual({ sessions: false, outcomes: false });
  });

  it("drops an unrecognised verdict instead of counting it as a good fit", async () => {
    // Bucketing an unknown verdict as "good" would understate the very
    // number this page exists to report.
    stageSupabaseResponse("fit_sessions", "select", { data: [] });
    stageSupabaseResponse("mask_fit_outcomes", "select", {
      data: [
        { mask_id: MASK_A, fit_outcome: "leaking" },
        { mask_id: MASK_A, fit_outcome: "banana" },
      ],
    });

    const res = await request(makeApp()).get(
      "/admin/analytics/fitter-outcomes",
    );

    expect(res.status).toBe(200);
    expect(res.body.report.refit.responses).toBe(1);
    expect(res.body.report.refit.refitRate).toBe(1);
  });

  it("falls back to a known entry point on a stray value", async () => {
    stageSupabaseResponse("fit_sessions", "select", {
      data: [sessionRow({ entry_point: "carrier_pigeon" })],
    });
    stageSupabaseResponse("mask_fit_outcomes", "select", { data: [] });
    stageSupabaseResponse("mask_models", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/admin/analytics/fitter-outcomes",
    );

    expect(res.status).toBe(200);
    expect(res.body.report.sessions.total).toBe(1);
    expect(res.body.report.sessions.byEntryPoint.remote_link).toBe(1);
  });

  it("resolves mask display names for the per-mask table", async () => {
    stageSupabaseResponse("fit_sessions", "select", { data: [] });
    stageSupabaseResponse("mask_fit_outcomes", "select", {
      data: Array.from({ length: 10 }, () => ({
        mask_id: MASK_A,
        fit_outcome: "leaking",
      })),
    });
    stageSupabaseResponse("mask_models", "select", {
      data: [
        {
          id: MASK_MODEL_UUID,
          slug: MASK_A,
          manufacturer: "ResMed",
          model_name: "AirFit N20",
        },
      ],
    });

    const res = await request(makeApp()).get(
      "/admin/analytics/fitter-outcomes",
    );

    expect(res.status).toBe(200);
    expect(res.body.report.refit.byMask).toHaveLength(1);
    expect(res.body.report.refit.byMask[0].maskLabel).toBe("ResMed AirFit N20");
  });

  it("keeps reading past a full page instead of stopping at the cap", async () => {
    // PostgREST returns at most max_rows (1000) per request. Treating a
    // full page as the complete window would compute every rate from the
    // newest 1000 rows while reporting the period as complete.
    const fullPage = Array.from({ length: 1000 }, (_, i) =>
      sessionRow({
        id: `s${i}`,
      }),
    );
    stageSupabaseResponse("fit_sessions", "select", { data: fullPage });
    stageSupabaseResponse("fit_sessions", "select", {
      data: [sessionRow({ id: "s-last" })],
    });
    stageSupabaseResponse("mask_fit_outcomes", "select", { data: [] });
    stageSupabaseResponse("mask_models", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/admin/analytics/fitter-outcomes",
    );

    expect(res.status).toBe(200);
    expect(res.body.report.sessions.total).toBe(1001);
    expect(res.body.truncated.sessions).toBe(false);
  });

  it("400s on an out-of-range window", async () => {
    const res = await request(makeApp()).get(
      "/admin/analytics/fitter-outcomes?days=99999",
    );
    expect(res.status).toBe(400);
  });

  it("surfaces a query failure rather than reporting an empty period", async () => {
    // A failed read that rendered as "no fittings" would be the worst
    // possible outcome for a page whose job is measuring coverage.
    stageSupabaseResponse("fit_sessions", "select", {
      error: { message: "boom" },
    });
    stageSupabaseResponse("mask_fit_outcomes", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/admin/analytics/fitter-outcomes",
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("query_failed");
  });
});
