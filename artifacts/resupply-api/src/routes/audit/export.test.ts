// Route tests for GET /audit/export.csv.
//
// Covers: auth gating, query validation, well-formed CSV with
// header + data rows, RFC4180 escape (commas / quotes / newlines /
// nested JSON metadata), truncation footer, post-export audit log,
// and graceful handling when the post-export logAudit() throws.

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const queryQueue: Array<{ rows: unknown[] }> = [];
const poolQuery = vi.fn(async () => {
  return queryQueue.shift() ?? { rows: [] };
});

vi.mock("@workspace/resupply-db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-db")>(
      "@workspace/resupply-db",
    );
  return {
    ...actual,
    getDbPool: () => ({ query: poolQuery }) as never,
  };
});

// Typed as a permissive (...args[]) → Promise so callers can spread
// the express-attached audit args into it AND `.mock.calls[0]?.[0]`
// can index into the first call's first arg without TS complaining
// the tuple is empty.
const logAuditMock: Mock<(...args: unknown[]) => Promise<void>> = vi.fn(
  async (..._args: unknown[]): Promise<void> => undefined,
);
vi.mock("@workspace/resupply-audit", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-audit")>(
      "@workspace/resupply-audit",
    );
  return {
    ...actual,
    logAudit: (...a: unknown[]) => logAuditMock(...a),
  };
});

import exportRouter from "./export";

const ALLOWED_EMAIL = "ops@penn.example.com";
const AUDIT_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use("/resupply-api", exportRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "user_op",
    email: ALLOWED_EMAIL,
    role: "admin",
  };
}

const ENV_KEYS = ["RESUPPLY_ADMIN_EMAILS", "NODE_ENV"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

describe("GET /audit/export.csv", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = "test";
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    queryQueue.length = 0;
    mockAdmin.current = null;
    poolQuery.mockClear();
    logAuditMock.mockClear();
    logAuditMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns 401 with no session", async () => {    const res = await request(makeApp()).get(
      "/resupply-api/audit/export.csv",
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 invalid_query on bad since", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp()).get(
      "/resupply-api/audit/export.csv?since=nope",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("emits header + data rows + RFC4180 escape", async () => {
    stubVerifiedAdmin();
    queryQueue.push({
      rows: [
        {
          id: AUDIT_ID,
          occurred_at: new Date("2025-04-15T10:00:00Z"),
          operator_email: "ops@penn.example.com",
          operator_user_id: "user_op",
          action: "patient.view",
          target_table: "patients",
          target_id: "22222222-2222-4222-8222-222222222222",
          metadata: { source: "console", note: 'has "quote" and ,comma' },
          ip: "10.0.0.1",
          user_agent: "Mozilla/5.0",
        },
      ],
    });

    const res = await request(makeApp()).get(
      "/resupply-api/audit/export.csv",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(
      /attachment; filename="audit-export-/,
    );

    const lines = res.text.split("\r\n");
    // header + 1 row + trailing empty (from final \r\n)
    expect(lines[0]).toBe(
      "id,occurredAt,adminEmail,adminUserId,action,targetTable,targetId,ip,userAgent,metadataJson",
    );
    expect(lines[1]).toContain(AUDIT_ID);
    expect(lines[1]).toContain("patient.view");
    // metadata JSON contains both a comma and a quote, so it must
    // be wrapped in quotes with internal quotes doubled.
    expect(lines[1]).toMatch(/"\{""source"":""console"",""note"":""has \\""quote\\"" and ,comma""\}"/);
    // No truncation footer for a single-row result.
    expect(res.text).not.toContain("# truncated");
  });

  it("filters by action + targetTable + since", async () => {
    stubVerifiedAdmin();
    queryQueue.push({ rows: [] });
    const res = await request(makeApp()).get(
      "/resupply-api/audit/export.csv?action=patient&targetTable=patients&since=2025-01-01T00:00:00Z",
    );
    expect(res.status).toBe(200);
    const firstCall = poolQuery.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    // Wildcarded action, exact targetTable, parsed Date for since,
    // followed by the row-cap limit (50_000 + 1).
    expect(firstCall[1]).toEqual([
      "%patient%",
      "patients",
      new Date("2025-01-01T00:00:00Z"),
      50_001,
    ]);
  });

  it("appends a truncated footer when row-cap is exceeded", async () => {
    stubVerifiedAdmin();
    // Synthesise MAX_ROWS + 1 rows so the export logic notices
    // overflow. Use minimal row shape to keep the test fast.
    const rows = Array.from({ length: 50_001 }, (_, i) => ({
      id: `${i}`.padStart(36, "0"),
      occurred_at: new Date("2025-04-15T10:00:00Z"),
      operator_email: null,
      operator_user_id: null,
      action: "system.heartbeat",
      target_table: null,
      target_id: null,
      metadata: null,
      ip: null,
      user_agent: null,
    }));
    queryQueue.push({ rows });

    const res = await request(makeApp()).get(
      "/resupply-api/audit/export.csv",
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      "# truncated: more than 50000 rows matched",
    );
  });

  it("writes a post-export audit row with action audit.export.csv", async () => {
    stubVerifiedAdmin();
    queryQueue.push({ rows: [] });

    const res = await request(makeApp()).get(
      "/resupply-api/audit/export.csv?action=patient",
    );
    expect(res.status).toBe(200);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const arg = (logAuditMock.mock.calls[0]?.[0] ?? {}) as {
      action?: string;
      adminUserId?: string | null;
      adminEmail?: string | null;
      targetTable?: string | null;
      metadata?: Record<string, unknown>;
    };
    expect(arg.action).toBe("audit.export.csv");
    expect(arg.adminUserId).toBe("user_op");
    expect(arg.adminEmail).toBe(ALLOWED_EMAIL);
    expect(arg.targetTable).toBe("audit_log");
    expect(arg.metadata).toMatchObject({ count: 0, outcome: "complete" });
  });

  it("does not crash when the post-export audit log throws", async () => {
    stubVerifiedAdmin();
    queryQueue.push({ rows: [] });
    logAuditMock.mockRejectedValueOnce(new Error("audit insert failed"));

    const res = await request(makeApp()).get(
      "/resupply-api/audit/export.csv",
    );
    expect(res.status).toBe(200);
    // The CSV body still includes the header row.
    expect(res.text.startsWith("id,occurredAt,")).toBe(true);
  });
});
