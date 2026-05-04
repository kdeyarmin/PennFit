// Route tests for GET /patients/export.csv.
//
// We mock both the db (via drizzle) and the `decrypt` helper. The
// real `decrypt` reads pgcrypto-encrypted bytea; in tests we just
// have it pass-through the input as a string so we can assert the
// CSV cells without spinning up Postgres.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const selectQueue: unknown[] = [];
function fluentSelect(rows: unknown): unknown {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    orderBy: () => obj,
    limit: () => obj,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return obj;
}
const dbStub = {
  select: vi.fn(() => fluentSelect(selectQueue.shift() ?? [])),
  insert: vi.fn(() => {
    const obj: Record<string, unknown> = {
      values: () => obj,
      onConflictDoUpdate: () => obj,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve),
    };
    return obj;
  }),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

// Pass-through `decrypt`: in tests the "encrypted" column is a string
// the test fixture provided directly. Mocking here keeps the test
// hermetic from pgcrypto.
vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return {
    ...actual,
    getDbPool: () => ({}) as never,
    decrypt: (v: unknown) => (v == null ? null : String(v)),
  };
});

const logAuditMock = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

import exportCsvRouter, { EXPORT_COLUMNS } from "./export-csv";

const ALLOWED_EMAIL = "ops@penn.example.com";

function makeApp(): Express {
  const app = express();
  app.use("/resupply-api", exportCsvRouter);
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

// Drizzle returns one object per `.select({alias: ...})` row. Our
// route aliases decrypted columns as `firstName/lastName/...`, so
// the fake rows mirror the post-SELECT shape (decryption already
// applied, mock just hands back the plaintext values directly).
function fakeRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    pacwareId: "PAC-1",
    firstName: "Ada",
    lastName: "Lovelace",
    dateOfBirth: "1815-12-10",
    phoneE164: "+14155551212",
    email: "ada@example.com",
    status: "active",
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-02T00:00:00Z"),
    ...overrides,
  };
}

describe("GET /patients/export.csv", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    process.env.NODE_ENV = "test";
    mockAdmin.current = null;
    selectQueue.length = 0;
    logAuditMock.mockClear();
    dbStub.select.mockClear();
    stubVerifiedAdmin();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns text/csv with the documented header row", async () => {
    selectQueue.push([fakeRow()]);

    const res = await request(makeApp()).get(
      "/resupply-api/patients/export.csv",
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-disposition"]).toMatch(/patients-export\.csv/);
    const lines = res.text.trim().split("\n");
    expect(lines[0]).toBe(EXPORT_COLUMNS.join(","));
    expect(lines[1]).toContain("PAC-1");
    expect(lines[1]).toContain("Ada");
    expect(lines[1]).toContain("Lovelace");
    expect(res.headers["x-truncated"]).toBeUndefined();
  });

  it("CSV-escapes commas and quotes in decrypted PHI cells", async () => {
    selectQueue.push([fakeRow({ lastName: 'O"Brien, Sr.' })]);
    const res = await request(makeApp()).get(
      "/resupply-api/patients/export.csv",
    );
    expect(res.status).toBe(200);
    // The cell should be wrapped in quotes and embedded quotes
    // doubled per RFC 4180.
    expect(res.text).toContain('"O""Brien, Sr."');
  });

  it("sets X-Truncated when the row count exceeds the cap", async () => {
    // Build 5001 rows: triggers truncation. We cheat by using the
    // same skeleton row 5001 times — id repetition is fine for this
    // assertion since we're testing the header, not row content.
    const rows = Array.from({ length: 5001 }, (_, i) =>
      fakeRow({ pacwareId: `PAC-${i}` }),
    );
    selectQueue.push(rows);
    const res = await request(makeApp()).get(
      "/resupply-api/patients/export.csv",
    );
    expect(res.status).toBe(200);
    expect(res.headers["x-truncated"]).toBe("true");
    // Header + 5000 capped rows.
    const lines = res.text.trim().split("\n");
    expect(lines).toHaveLength(5001);
  });

  it("audits the export with row count and filter shape (no PHI)", async () => {
    selectQueue.push([fakeRow(), fakeRow({ pacwareId: "PAC-2" })]);
    await request(makeApp()).get(
      "/resupply-api/patients/export.csv?status=paused&search=Smith",
    );
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const calls = logAuditMock.mock.calls as unknown as Array<
      [{ action: string; metadata: Record<string, unknown> }]
    >;
    const arg = calls[0][0];
    expect(arg.action).toBe("patient.export.csv");
    expect(arg.metadata.row_count).toBe(2);
    expect(arg.metadata.status_filter).toBe("paused");
    expect(arg.metadata.search_filter_present).toBe(true);
    // Search string itself must NOT land in metadata.
    expect(JSON.stringify(arg.metadata)).not.toContain("Smith");
  });

  it("rejects unauthenticated callers with 401", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp()).get(
      "/resupply-api/patients/export.csv",
    );
    expect(res.status).toBe(401);
  });

  it("rejects invalid status filter with 400", async () => {
    const res = await request(makeApp()).get(
      "/resupply-api/patients/export.csv?status=archived",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });
});
