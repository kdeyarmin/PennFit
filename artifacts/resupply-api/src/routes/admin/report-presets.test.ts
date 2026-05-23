// Tests for /admin/reports/presets — saved report shortcuts.
//
// Scope: only the code in routes/admin/report-presets.ts.
//   * GET    /admin/reports/presets
//   * POST   /admin/reports/presets
//   * DELETE /admin/reports/presets/:id

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

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit:
    () =>
    (
      _req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ) =>
      next(),
}));

import reportPresetsRouter from "./report-presets";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(reportPresetsRouter);
  return app;
}

function stubAdmin(userId = "u_admin_1") {
  mockAdmin.current = {
    userId,
    email: "ops@example.com",
    role: "admin",
  };
}

// Valid UUID v4 — zod's `.uuid()` enforces the variant bit
// (position 19 must be 8/9/a/b) so a "looks-like-a-uuid" string
// with all 5s fails parsing and the handler 404s before reaching
// the supabase mock.
const PRESET_ID = "11111111-1111-4111-8111-111111111111";

function makePresetRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PRESET_ID,
    user_id: "u_admin_1",
    name: "Monthly close — last month IIF",
    slug: "orders",
    format: "iif",
    range_kind: "preset",
    range_preset: "preset-last-month",
    range_from: null,
    range_to: null,
    recipient: null,
    created_at: "2026-05-01T10:00:00.000Z",
    updated_at: "2026-05-01T10:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

// ─── Auth guard ────────────────────────────────────────────────────────

describe("auth guard", () => {
  it("rejects unauthenticated GET with 401", async () => {
    const res = await request(makeApp()).get("/admin/reports/presets");
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated POST with 401", async () => {
    const res = await request(makeApp())
      .post("/admin/reports/presets")
      .send({});
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated DELETE with 401", async () => {
    const res = await request(makeApp()).delete(
      `/admin/reports/presets/${PRESET_ID}`,
    );
    expect(res.status).toBe(401);
  });
});

// ─── GET /admin/reports/presets ───────────────────────────────────────

describe("GET /admin/reports/presets", () => {
  it("returns the user's saved presets in API shape", async () => {
    stubAdmin();
    stageSupabaseResponse("report_presets", "select", {
      data: [makePresetRow()],
    });

    const res = await request(makeApp()).get("/admin/reports/presets");

    expect(res.status).toBe(200);
    expect(res.body.presets).toHaveLength(1);
    const p = res.body.presets[0];
    expect(p.id).toBe(PRESET_ID);
    expect(p.name).toBe("Monthly close — last month IIF");
    expect(p.slug).toBe("orders");
    expect(p.format).toBe("iif");
    expect(p.rangeKind).toBe("preset");
    expect(p.rangePreset).toBe("preset-last-month");
  });

  it("returns an empty list when the user has no presets", async () => {
    stubAdmin();
    stageSupabaseResponse("report_presets", "select", { data: [] });

    const res = await request(makeApp()).get("/admin/reports/presets");

    expect(res.status).toBe(200);
    expect(res.body.presets).toEqual([]);
  });
});

// ─── POST /admin/reports/presets ──────────────────────────────────────

describe("POST /admin/reports/presets", () => {
  it("creates a preset-range preset and returns 201", async () => {
    stubAdmin();
    stageSupabaseResponse("report_presets", "insert", {
      data: makePresetRow(),
    });

    const res = await request(makeApp())
      .post("/admin/reports/presets")
      .send({
        name: "Monthly close — last month IIF",
        slug: "orders",
        format: "iif",
        rangeKind: "preset",
        rangePreset: "preset-last-month",
      });

    expect(res.status).toBe(201);
    expect(res.body.preset.id).toBe(PRESET_ID);
    expect(res.body.preset.rangeKind).toBe("preset");
  });

  it("creates an absolute-range preset with rangeFrom/rangeTo", async () => {
    stubAdmin();
    stageSupabaseResponse("report_presets", "insert", {
      data: makePresetRow({
        range_kind: "absolute",
        range_preset: null,
        range_from: "2026-04-01",
        range_to: "2026-04-30",
      }),
    });

    const res = await request(makeApp())
      .post("/admin/reports/presets")
      .send({
        name: "April orders",
        slug: "orders",
        format: "csv",
        rangeKind: "absolute",
        rangeFrom: "2026-04-01",
        rangeTo: "2026-04-30",
      });

    expect(res.status).toBe(201);
    expect(res.body.preset.rangeKind).toBe("absolute");
    expect(res.body.preset.rangeFrom).toBe("2026-04-01");
    expect(res.body.preset.rangeTo).toBe("2026-04-30");
  });

  it("rejects invalid format with 400", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/reports/presets")
      .send({
        name: "X",
        slug: "orders",
        format: "xlsx", // not in the catalog
        rangeKind: "preset",
        rangePreset: "preset-7d",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("rejects absolute range with rangeFrom > rangeTo (400)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/reports/presets")
      .send({
        name: "Bad range",
        slug: "orders",
        format: "csv",
        rangeKind: "absolute",
        rangeFrom: "2026-04-30",
        rangeTo: "2026-04-01",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    const issues = res.body.issues as Array<{ path: string }>;
    expect(issues.some((i) => i.path === "rangeFrom")).toBe(true);
  });

  it("rejects mixing absolute + rangePreset (zod discriminated union)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/reports/presets")
      .send({
        name: "Hybrid",
        slug: "orders",
        format: "csv",
        rangeKind: "absolute",
        rangeFrom: "2026-04-01",
        rangeTo: "2026-04-30",
        rangePreset: "preset-last-month", // not allowed when absolute
      });
    expect(res.status).toBe(400);
  });

  it("accepts an optional recipient email and rejects malformed ones", async () => {
    stubAdmin();
    // Good email.
    stageSupabaseResponse("report_presets", "insert", {
      data: makePresetRow({ recipient: "accounting@example.com" }),
    });
    const goodRes = await request(makeApp())
      .post("/admin/reports/presets")
      .send({
        name: "M close",
        slug: "orders",
        format: "iif",
        rangeKind: "preset",
        rangePreset: "preset-last-month",
        recipient: "accounting@example.com",
      });
    expect(goodRes.status).toBe(201);
    expect(goodRes.body.preset.recipient).toBe("accounting@example.com");

    // Bad email.
    const badRes = await request(makeApp())
      .post("/admin/reports/presets")
      .send({
        name: "M close",
        slug: "orders",
        format: "iif",
        rangeKind: "preset",
        rangePreset: "preset-last-month",
        recipient: "not-an-email",
      });
    expect(badRes.status).toBe(400);
  });
});

// ─── DELETE /admin/reports/presets/:id ────────────────────────────────

describe("DELETE /admin/reports/presets/:id", () => {
  it("returns 204 when the preset is found + deleted", async () => {
    stubAdmin();
    stageSupabaseResponse("report_presets", "delete", {
      data: [{ id: PRESET_ID }],
    });

    const res = await request(makeApp()).delete(
      `/admin/reports/presets/${PRESET_ID}`,
    );

    expect(res.status).toBe(204);
  });

  it("returns 404 when the preset doesn't exist OR isn't owned by the caller", async () => {
    stubAdmin();
    // The mock returns an empty array from the .delete().select()
    // chain — same shape as Supabase would emit when the where
    // clause matched zero rows.
    stageSupabaseResponse("report_presets", "delete", { data: [] });

    const res = await request(makeApp()).delete(
      `/admin/reports/presets/${PRESET_ID}`,
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 404 on a non-UUID id (before any DB call)", async () => {
    stubAdmin();
    const res = await request(makeApp()).delete(
      "/admin/reports/presets/not-a-uuid",
    );
    expect(res.status).toBe(404);
  });
});
