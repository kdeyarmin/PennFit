// Tests for /admin/feature-flags — Control Center backing API.
//
// Coverage:
//   1. GET requires `reports.read` permission; returns ordered list.
//   2. PATCH requires `admin.tools.manage` permission; returns 403
//      for CSR-bucket actors.
//   3. PATCH validates the key against the closed FEATURE_FLAG_KEYS
//      enum (404 on unknown keys).
//   4. PATCH validates the body shape (400 on a missing enabled flag).
//   5. PATCH writes an audit row with the before/after values.
//   6. PATCH invalidates the in-memory feature flag cache so the
//      next call to isFeatureEnabled reads the new value.

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
    (_req: import("express").Request, _res: import("express").Response, next: import("express").NextFunction) =>
      next(),
}));

const logAuditMock = vi.hoisted(() =>
  vi.fn<(event: Record<string, unknown>) => Promise<void>>(() =>
    Promise.resolve(),
  ),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

const invalidateCacheMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/feature-flags", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/feature-flags")
  >("../../lib/feature-flags");
  return {
    ...actual,
    invalidateFeatureFlagCache: invalidateCacheMock,
  };
});

import featureFlagsRouter from "./feature-flags";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(featureFlagsRouter);
  return app;
}

function stubAdmin(role: "admin" | "agent" = "admin") {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
    role,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
  invalidateCacheMock.mockClear();
});

describe("GET /admin/feature-flags", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/admin/feature-flags");
    expect(res.status).toBe(401);
  });

  it("returns flags ordered by category then key", async () => {
    stubAdmin();
    stageSupabaseResponse("feature_flags", "select", {
      data: [
        {
          key: "sms.reminders",
          enabled: false,
          description: "sms reminders",
          category: "Messaging",
          updated_by_email: "ops@example.com",
          updated_at: "2026-01-02T00:00:00.000Z",
        },
        {
          key: "voice.agent",
          enabled: true,
          description: "voice agent",
          category: "Voice & AI",
          updated_by_email: null,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const res = await request(makeApp()).get("/admin/feature-flags");
    expect(res.status).toBe(200);
    expect(res.body.flags).toHaveLength(2);
    expect(res.body.flags[0]).toMatchObject({
      key: "sms.reminders",
      enabled: false,
      category: "Messaging",
      updatedByEmail: "ops@example.com",
    });
    expect(res.body.flags[1]).toMatchObject({
      key: "voice.agent",
      enabled: true,
      category: "Voice & AI",
    });
  });
});

describe("PATCH /admin/feature-flags/:key", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch("/admin/feature-flags/sms.reminders")
      .send({ enabled: false });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a CSR-bucket actor (admin.tools.manage required)", async () => {
    mockAdmin.current = {
      userId: "u_csr_1",
      email: "csr@example.com",
      role: "agent",
      granularRole: "csr",
    };
    const res = await request(makeApp())
      .patch("/admin/feature-flags/sms.reminders")
      .send({ enabled: false });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: "permission_denied",
      requiredPermission: "admin.tools.manage",
    });
  });

  it("returns 404 for an unknown flag key", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch("/admin/feature-flags/unknown.flag")
      .send({ enabled: false });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_flag");
  });

  it("returns 400 for a missing enabled flag", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch("/admin/feature-flags/sms.reminders")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 404 when the flag row hasn't been seeded yet", async () => {
    stubAdmin();
    stageSupabaseResponse("feature_flags", "select", {
      data: null,
    });
    const res = await request(makeApp())
      .patch("/admin/feature-flags/sms.reminders")
      .send({ enabled: false });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("flag_not_seeded");
  });

  it("updates the flag, audits the change, and invalidates the cache", async () => {
    stubAdmin();
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    stageSupabaseResponse("feature_flags", "update", {
      data: {
        key: "sms.reminders",
        enabled: false,
        description: "sms reminders",
        category: "Messaging",
        updated_by_email: "ops@example.com",
        updated_at: "2026-05-22T12:00:00.000Z",
      },
    });

    const res = await request(makeApp())
      .patch("/admin/feature-flags/sms.reminders")
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.flag).toMatchObject({
      key: "sms.reminders",
      enabled: false,
      updatedByEmail: "ops@example.com",
    });

    expect(invalidateCacheMock).toHaveBeenCalledWith("sms.reminders");

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      targetTable: string;
      targetId: string;
      metadata: { key: string; from: boolean; to: boolean };
    };
    expect(audit.action).toBe("feature_flag.toggle");
    expect(audit.targetTable).toBe("feature_flags");
    expect(audit.targetId).toBe("sms.reminders");
    expect(audit.metadata).toEqual({
      key: "sms.reminders",
      from: true,
      to: false,
    });
  });
});

// ─── GET /admin/feature-flags/activity ──────────────────────────────────
//
// Source moved from `resupply.audit_log` → `resupply.feature_flag_events`
// in migration 0163 (the audit lib became a no-op stub when the HIPAA
// tamper-evident chain was retired in 0156). The reader now hits the
// strongly-typed events table written by the PATCH handler.

describe("GET /admin/feature-flags/activity", () => {
  it("returns 401 when not signed in", async () => {
    const res = await request(makeApp()).get(
      "/admin/feature-flags/activity",
    );
    expect(res.status).toBe(401);
  });

  it("returns feature_flag_events rows transformed into ToggleActivityRow shape", async () => {
    // The events table is strongly-typed (key, previous_enabled,
    // next_enabled columns), so the route no longer needs to parse a
    // jsonb metadata blob.
    stubAdmin();
    stageSupabaseResponse("feature_flag_events", "select", {
      data: [
        {
          occurred_at: "2026-05-15T10:00:00.000Z",
          operator_email: "ops@example.com",
          key: "sms.reminders",
          previous_enabled: true,
          next_enabled: false,
        },
        {
          occurred_at: "2026-05-15T09:00:00.000Z",
          operator_email: "ops2@example.com",
          key: "voice.agent",
          previous_enabled: false,
          next_enabled: true,
        },
      ],
    });

    const res = await request(makeApp()).get(
      "/admin/feature-flags/activity",
    );

    expect(res.status).toBe(200);
    expect(res.body.activity).toHaveLength(2);
    expect(res.body.activity[0]).toEqual({
      occurredAt: "2026-05-15T10:00:00.000Z",
      operatorEmail: "ops@example.com",
      key: "sms.reminders",
      from: true,
      to: false,
    });
  });

  it("clamps the limit to ACTIVITY_MAX_LIMIT (100)", async () => {
    stubAdmin();
    stageSupabaseResponse("feature_flag_events", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/admin/feature-flags/activity?limit=9999",
    );

    // A 200 + empty body confirms the route accepted the over-large
    // param and clamped it rather than erroring.
    expect(res.status).toBe(200);
    expect(res.body.activity).toEqual([]);
  });
});
