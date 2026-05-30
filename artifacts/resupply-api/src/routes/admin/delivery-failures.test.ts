// Tests for routes/admin/delivery-failures.ts — sinceDays NaN guard (this PR).
//
// PR change: the old single-expression computation
//   `Math.min(Math.max(1, Number(req.query.sinceDays ?? DEFAULT_DAYS_BACK)), 90)`
// did not guard against non-finite inputs. `Number("NaN")` is `NaN`, and
// `Math.min(Math.max(1, NaN), 90)` propagates NaN into `Date.now() - NaN * ms`
// which also produces NaN, making the `.gte("created_at", NaN)` filter nonsensical.
// The new code wraps the computation in `Number.isFinite(...)` and falls back to
// DEFAULT_DAYS_BACK (14) when the input is not finite.
//
// Coverage:
//   1. Structural source check: `Number.isFinite` is present.
//   2. Pure replicated-logic tests: all boundary / edge cases for sinceDays.
//   3. Route-level tests (supertest): NaN / Infinity / missing / clamping.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "delivery-failures.ts"), "utf8");

// ── Supabase mock (module-scoped) ─────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── Auth mock ─────────────────────────────────────────────────────────────────
const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import deliveryFailuresRouter from "./delivery-failures";

// Admin context with `reports.read` permission (supervisor has that).
const REPORTS_READER: MockAdminCtx = {
  userId: "u_sup_1",
  email: "sup@penn.example.com",
  role: "agent",
  granularRole: "supervisor",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(deliveryFailuresRouter);
  return app;
}

function stubAdmin(ctx: MockAdminCtx = REPORTS_READER) {
  mockAdmin.current = ctx;
}

// Stage the three Supabase reads the route makes (messages, conversations,
// patients). Passing empty arrays is sufficient when we only care about the
// `sinceDays` field in the response.
function stageEmptyResponses() {
  stageSupabaseResponse("messages", "select", { data: [], error: null });
  // No conversation or patient lookups when messages is empty.
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

// ---------------------------------------------------------------------------
// Structural source checks
// ---------------------------------------------------------------------------
describe("delivery-failures.ts — sinceDays NaN guard (source check)", () => {
  it("uses Number.isFinite to guard the sinceDays computation", () => {
    expect(SRC).toContain("Number.isFinite(rawSinceDays)");
  });

  it("falls back to DEFAULT_DAYS_BACK for non-finite values", () => {
    // The fallback branch must reference the DEFAULT_DAYS_BACK constant.
    const guardIdx = SRC.indexOf("Number.isFinite(rawSinceDays)");
    expect(guardIdx).toBeGreaterThan(-1);
    const guardBlock = SRC.slice(guardIdx, guardIdx + 120);
    expect(guardBlock).toContain("DEFAULT_DAYS_BACK");
  });

  it("no longer uses the bare single-expression form that propagated NaN", () => {
    // The old pattern: `Math.min(Math.max(1, Number(req.query.sinceDays ...)), 90)`
    // on a single line without a finite guard. We verify the new two-step form.
    expect(SRC).toContain("const rawSinceDays =");
    expect(SRC).toContain("const sinceDays = Number.isFinite");
  });
});

// ---------------------------------------------------------------------------
// Pure replicated logic tests — sinceDays guard
// ---------------------------------------------------------------------------
// Replicate the exact computation from the route to document and guard every
// branch in isolation, without needing a running HTTP server.

const DEFAULT_DAYS_BACK = 14;

function computeSinceDays(queryValue: string | undefined): number {
  // Mirrors the route: a missing, empty, or blank value uses the
  // default (Number("") is 0, which would otherwise clamp to 1).
  const rawSinceDays =
    typeof queryValue === "string" && queryValue.trim() !== ""
      ? Number(queryValue)
      : NaN;
  return Number.isFinite(rawSinceDays)
    ? Math.min(Math.max(1, rawSinceDays), 90)
    : DEFAULT_DAYS_BACK;
}

describe("delivery-failures.ts — sinceDays computation (replicated pure logic)", () => {
  it("uses DEFAULT_DAYS_BACK (14) when no query param is supplied", () => {
    expect(computeSinceDays(undefined)).toBe(14);
  });

  it("returns the supplied integer when it is within [1, 90]", () => {
    expect(computeSinceDays("30")).toBe(30);
    expect(computeSinceDays("1")).toBe(1);
    expect(computeSinceDays("90")).toBe(90);
  });

  it("clamps values below 1 to 1", () => {
    expect(computeSinceDays("0")).toBe(1);
    expect(computeSinceDays("-10")).toBe(1);
  });

  it("clamps values above 90 to 90", () => {
    expect(computeSinceDays("91")).toBe(90);
    expect(computeSinceDays("9999")).toBe(90);
  });

  it("falls back to DEFAULT_DAYS_BACK when the query string is 'NaN'", () => {
    // The old code: Number.isNaN path would have propagated NaN.
    expect(computeSinceDays("NaN")).toBe(14);
  });

  it("falls back to DEFAULT_DAYS_BACK for Infinity", () => {
    expect(computeSinceDays("Infinity")).toBe(14);
  });

  it("falls back to DEFAULT_DAYS_BACK for -Infinity", () => {
    expect(computeSinceDays("-Infinity")).toBe(14);
  });

  it("falls back to DEFAULT_DAYS_BACK for non-numeric strings", () => {
    expect(computeSinceDays("abc")).toBe(14);
    expect(computeSinceDays("")).toBe(14);
  });

  it("accepts fractional values and applies clamping (float stays in range)", () => {
    expect(computeSinceDays("7.5")).toBe(7.5);
  });
});

// ---------------------------------------------------------------------------
// Route-level tests — sinceDays query param handling
// ---------------------------------------------------------------------------
describe("GET /admin/delivery-failures — sinceDays query param (route)", () => {
  it("401s when no session is present", async () => {
    const res = await request(makeApp()).get("/admin/delivery-failures");
    expect(res.status).toBe(401);
  });

  it("returns 200 with sinceDays=14 when no query param is supplied", async () => {
    stubAdmin();
    stageEmptyResponses();
    const res = await request(makeApp()).get("/admin/delivery-failures");
    expect(res.status).toBe(200);
    expect(res.body.sinceDays).toBe(14);
  });

  it("returns 200 with sinceDays=14 when sinceDays=NaN is supplied (NaN guard)", async () => {
    // This is the key regression: the old code propagated NaN into the query.
    stubAdmin();
    stageEmptyResponses();
    const res = await request(makeApp()).get(
      "/admin/delivery-failures?sinceDays=NaN",
    );
    expect(res.status).toBe(200);
    expect(res.body.sinceDays).toBe(14);
  });

  it("returns 200 with sinceDays=14 when sinceDays=Infinity is supplied", async () => {
    stubAdmin();
    stageEmptyResponses();
    const res = await request(makeApp()).get(
      "/admin/delivery-failures?sinceDays=Infinity",
    );
    expect(res.status).toBe(200);
    expect(res.body.sinceDays).toBe(14);
  });

  it("returns 200 with sinceDays=30 when sinceDays=30 is supplied", async () => {
    stubAdmin();
    stageEmptyResponses();
    const res = await request(makeApp()).get(
      "/admin/delivery-failures?sinceDays=30",
    );
    expect(res.status).toBe(200);
    expect(res.body.sinceDays).toBe(30);
  });

  it("clamps sinceDays=0 to 1", async () => {
    stubAdmin();
    stageEmptyResponses();
    const res = await request(makeApp()).get(
      "/admin/delivery-failures?sinceDays=0",
    );
    expect(res.status).toBe(200);
    expect(res.body.sinceDays).toBe(1);
  });

  it("clamps sinceDays=999 to 90", async () => {
    stubAdmin();
    stageEmptyResponses();
    const res = await request(makeApp()).get(
      "/admin/delivery-failures?sinceDays=999",
    );
    expect(res.status).toBe(200);
    expect(res.body.sinceDays).toBe(90);
  });

  it("response shape includes messageEvents array and auditEvents array", async () => {
    stubAdmin();
    stageEmptyResponses();
    const res = await request(makeApp()).get("/admin/delivery-failures");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.messageEvents)).toBe(true);
    expect(Array.isArray(res.body.auditEvents)).toBe(true);
    expect(res.body.auditEventsUnavailable).toBe(true);
  });

  it("response counts.auditFailures is null (audit stream retired)", async () => {
    stubAdmin();
    stageEmptyResponses();
    const res = await request(makeApp()).get("/admin/delivery-failures");
    expect(res.status).toBe(200);
    expect(res.body.counts.auditFailures).toBeNull();
  });
});
