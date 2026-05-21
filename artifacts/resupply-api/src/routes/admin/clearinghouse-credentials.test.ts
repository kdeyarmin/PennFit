// Tests for clearinghouse-credentials route — requirePermission middleware wiring.
//
// Scope: only the routes changed in this PR.
//   GET /admin/clearinghouse-credentials       → requirePermission("admin.tools.manage")
//   GET /admin/clearinghouse-credentials/:id   → requirePermission("admin.tools.manage")
//   GET /admin/clearinghouse-inbound-files     → requirePermission("admin.tools.manage")
//
// Routes NOT changed (requireAdminOnly still in place) are not under test here:
//   POST  /admin/clearinghouse-credentials
//   PATCH /admin/clearinghouse-credentials/:id
//   POST  /admin/clearinghouse-credentials/:id/test
//   POST  /admin/office-ally/poll-now
//
// Strategy:
//   - 401 gate: no session → 401.
//   - Permission gate: "agent" role maps to customer_service_rep which does NOT
//     carry admin.tools.manage → 403 with error "permission_denied".
//   - Admin / supervisor role (super_admin or admin effective bucket) carries
//     admin.tools.manage → handler proceeds.
//   - Happy-path responses verified against staged Supabase data.

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

// ── Supabase mock ────────────────────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── Auth mock ────────────────────────────────────────────────────────────────
const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// ── adminRateLimit mock ──────────────────────────────────────────────────────
const rateLimitBlocked = vi.hoisted(() => ({ current: false }));
const adminRateLimitSpy = vi.hoisted(() =>
  vi.fn<
    (opts: { name: string; preset?: string }) => (
      req: import("express").Request,
      res: import("express").Response,
      next: import("express").NextFunction,
    ) => void
  >((opts) => (_req, res, next) => {
    if (rateLimitBlocked.current) {
      res.status(429).json({
        error: "too_many_requests",
        limiter: opts.name,
        retryAfterSeconds: 3600,
        message: "Too many requests, please try again later.",
      });
      return;
    }
    next();
  }),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: adminRateLimitSpy,
}));

// ── Audit mock ───────────────────────────────────────────────────────────────
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

// ── External integrations mocked (not under test here) ───────────────────────
vi.mock("@workspace/resupply-integrations-office-ally", () => ({
  listOutboundFiles: vi.fn(async () => ({ ok: true, files: [] })),
}));

vi.mock("../../worker/jobs/office-ally-inbound-poll", () => ({
  runOfficeAllyInboundPoll: vi.fn(async () => ({ processed: 0 })),
}));

vi.mock("../../lib/billing/identity-resolver", () => ({
  resolveClearinghouse: vi.fn(async () => ({ config: null, source: "none", row: null })),
}));

import clearinghouseCredentialsRouter from "./clearinghouse-credentials";

const CRED_ID = "00000000-0000-4000-8000-000000000011";

// A minimal DB row that satisfies `rowToApi` field mapping.
const fakeRow = {
  id: CRED_ID,
  slug: "test-ch",
  display_name: "Test Clearinghouse",
  usage_indicator: "P",
  sftp_host: "sftp.test.example.com",
  sftp_port: 22,
  sftp_username: "sftp_user",
  private_key_path: "/keys/test.pem",
  known_hosts_path: "/keys/known_hosts",
  remote_inbox_dir: "inbound",
  remote_outbound_dir: "outbound",
  remote_archive_dir: null,
  etin: "ETIN001",
  submitter_organization_name: null,
  contact_name: null,
  contact_phone_e164: null,
  is_active: true,
  last_polled_at: null,
  notes: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(clearinghouseCredentialsRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
    role: "admin",
  };
}

function stubAgent() {
  mockAdmin.current = {
    userId: "u_agent_1",
    email: "agent@example.com",
    role: "agent",
    // agent → customer_service_rep effective role, which lacks admin.tools.manage
  };
}

function stubSupervisor() {
  mockAdmin.current = {
    userId: "u_supervisor_1",
    email: "supervisor@example.com",
    role: "admin", // coarse role
    granularRole: "supervisor", // → admin effective role → has admin.tools.manage
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  rateLimitBlocked.current = false;
  supabaseMock.reset();
});

// ── GET /admin/clearinghouse-credentials ──────────────────────────────────────

describe("GET /admin/clearinghouse-credentials — requirePermission('admin.tools.manage')", () => {
  it("returns 401 when no admin session is present", async () => {
    const res = await request(makeApp()).get("/admin/clearinghouse-credentials");
    expect(res.status).toBe(401);
  });

  it("returns 403 for an agent (customer_service_rep lacks admin.tools.manage)", async () => {
    stubAgent();
    const res = await request(makeApp()).get("/admin/clearinghouse-credentials");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("permission_denied");
    expect(res.body.requiredPermission).toBe("admin.tools.manage");
  });

  it("returns 200 for an admin (super_admin carries admin.tools.manage)", async () => {
    stubAdmin();
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: [fakeRow],
    });
    const res = await request(makeApp()).get("/admin/clearinghouse-credentials");
    expect(res.status).toBe(200);
    expect(res.body.clearinghouses).toBeInstanceOf(Array);
    expect(res.body.clearinghouses[0].id).toBe(CRED_ID);
    expect(res.body.clearinghouses[0].slug).toBe("test-ch");
  });

  it("returns 200 for a supervisor (admin effective role carries admin.tools.manage)", async () => {
    stubSupervisor();
    stageSupabaseResponse("clearinghouse_credentials", "select", { data: [] });
    const res = await request(makeApp()).get("/admin/clearinghouse-credentials");
    expect(res.status).toBe(200);
    expect(res.body.clearinghouses).toEqual([]);
  });

  it("returns empty list when no credentials exist", async () => {
    stubAdmin();
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: null,
    });
    const res = await request(makeApp()).get("/admin/clearinghouse-credentials");
    expect(res.status).toBe(200);
    expect(res.body.clearinghouses).toEqual([]);
  });

  it("response shape contains expected camelCase fields", async () => {
    stubAdmin();
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: [fakeRow],
    });
    const res = await request(makeApp()).get("/admin/clearinghouse-credentials");
    const ch = res.body.clearinghouses[0];
    expect(ch).toHaveProperty("displayName", "Test Clearinghouse");
    expect(ch).toHaveProperty("usageIndicator", "P");
    expect(ch).toHaveProperty("sftpHost", "sftp.test.example.com");
    expect(ch).toHaveProperty("isActive", true);
  });
});

// ── GET /admin/clearinghouse-credentials/:id ──────────────────────────────────

describe("GET /admin/clearinghouse-credentials/:id — requirePermission('admin.tools.manage')", () => {
  it("returns 401 when no admin session is present", async () => {
    const res = await request(makeApp()).get(
      `/admin/clearinghouse-credentials/${CRED_ID}`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 for an agent (customer_service_rep lacks admin.tools.manage)", async () => {
    stubAgent();
    const res = await request(makeApp()).get(
      `/admin/clearinghouse-credentials/${CRED_ID}`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("permission_denied");
    expect(res.body.requiredPermission).toBe("admin.tools.manage");
  });

  it("returns 404 for a non-UUID id", async () => {
    stubAdmin();
    const res = await request(makeApp()).get(
      "/admin/clearinghouse-credentials/not-a-uuid",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 404 when credential is not found in the database", async () => {
    stubAdmin();
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: null,
    });
    const res = await request(makeApp()).get(
      `/admin/clearinghouse-credentials/${CRED_ID}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 200 with credential data for an admin", async () => {
    stubAdmin();
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: fakeRow,
    });
    const res = await request(makeApp()).get(
      `/admin/clearinghouse-credentials/${CRED_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.clearinghouse.id).toBe(CRED_ID);
    expect(res.body.clearinghouse.slug).toBe("test-ch");
  });

  it("returns 200 for a supervisor (admin effective role carries admin.tools.manage)", async () => {
    stubSupervisor();
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: fakeRow,
    });
    const res = await request(makeApp()).get(
      `/admin/clearinghouse-credentials/${CRED_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.clearinghouse.id).toBe(CRED_ID);
  });
});

// ── GET /admin/clearinghouse-inbound-files ────────────────────────────────────

describe("GET /admin/clearinghouse-inbound-files — requirePermission('admin.tools.manage')", () => {
  it("returns 401 when no admin session is present", async () => {
    const res = await request(makeApp()).get(
      "/admin/clearinghouse-inbound-files",
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 for an agent (customer_service_rep lacks admin.tools.manage)", async () => {
    stubAgent();
    const res = await request(makeApp()).get(
      "/admin/clearinghouse-inbound-files",
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("permission_denied");
    expect(res.body.requiredPermission).toBe("admin.tools.manage");
  });

  it("returns 200 with empty files list when admin requests", async () => {
    stubAdmin();
    stageSupabaseResponse("clearinghouse_inbound_files", "select", {
      data: [],
    });
    const res = await request(makeApp()).get(
      "/admin/clearinghouse-inbound-files",
    );
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([]);
  });

  it("returns 200 for a supervisor with file data", async () => {
    stubSupervisor();
    const fakeFile = {
      id: "00000000-0000-4000-8000-000000000099",
      clearinghouse_id: CRED_ID,
      remote_path: "/inbound/test.835",
      file_name: "test.835",
      file_sha256: "abc123",
      file_size_bytes: 1024,
      file_kind: "835",
      parse_summary_json: null,
      dispatch_status: "dispatched",
      applied_to_era_file_id: null,
      applied_to_submission_id: null,
      error_message: null,
      downloaded_at: "2026-01-01T00:00:00.000Z",
      dispatched_at: "2026-01-01T01:00:00.000Z",
    };
    stageSupabaseResponse("clearinghouse_inbound_files", "select", {
      data: [fakeFile],
    });
    const res = await request(makeApp()).get(
      "/admin/clearinghouse-inbound-files",
    );
    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].id).toBe(fakeFile.id);
    expect(res.body.files[0].fileKind).toBe("835");
    expect(res.body.files[0].dispatchStatus).toBe("dispatched");
  });

  it("returns empty list when no files exist", async () => {
    stubAdmin();
    stageSupabaseResponse("clearinghouse_inbound_files", "select", {
      data: null,
    });
    const res = await request(makeApp()).get(
      "/admin/clearinghouse-inbound-files",
    );
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([]);
  });

  it("accepts valid fileKind query filter", async () => {
    stubAdmin();
    stageSupabaseResponse("clearinghouse_inbound_files", "select", {
      data: [],
    });
    const res = await request(makeApp()).get(
      "/admin/clearinghouse-inbound-files?fileKind=835",
    );
    expect(res.status).toBe(200);
  });

  it("accepts valid dispatchStatus query filter", async () => {
    stubAdmin();
    stageSupabaseResponse("clearinghouse_inbound_files", "select", {
      data: [],
    });
    const res = await request(makeApp()).get(
      "/admin/clearinghouse-inbound-files?dispatchStatus=pending",
    );
    expect(res.status).toBe(200);
  });

  it("ignores unknown fileKind filter values (no SQL injection risk)", async () => {
    stubAdmin();
    stageSupabaseResponse("clearinghouse_inbound_files", "select", {
      data: [],
    });
    // An unrecognized file_kind should be silently ignored (the filter
    // is only applied when the value is in the allowed set).
    const res = await request(makeApp()).get(
      "/admin/clearinghouse-inbound-files?fileKind=unknown_kind",
    );
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([]);
  });
});
