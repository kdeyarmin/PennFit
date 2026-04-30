// Route tests for GET /dashboard/summary.
//
// Two parallel stubs:
//
// 1. drizzle `db.select()` (fluent stub from sms/inbound.test.ts) —
//    feeds the five COUNT(*) tile queries. We queue one
//    `[{ count }]` result per invocation in handler order:
//      activeConversations · awaitingAdmin · overdueEpisodes ·
//      fulfillmentsThisWeek · pausedPatients
//
// 2. `pool.query` (mock fn returned by `getDbPool().query`) — feeds
//    the `prescription.attachment.sweep` audit-row read in
//    `sweep-status.ts`. The helper uses raw SQL via `pool.query()`
//    rather than a drizzle `auditLog` import (architecture Rule 8 —
//    see the header in `sweep-status.ts`), so it bypasses the
//    drizzle stub entirely. Tests stage a single
//    `{ rows: [{ occurred_at, metadata }] }` shape per call.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const getAuthMock = vi.fn();
const getUserMock = vi.fn();
vi.mock("@clerk/express", () => ({
  getAuth: (...a: unknown[]) => getAuthMock(...a),
  clerkClient: {
    users: { getUser: (...a: unknown[]) => getUserMock(...a) },
  },
}));

function fluent(result: unknown) {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    leftJoin: () => obj,
    orderBy: () => obj,
    limit: () => obj,
    offset: () => obj,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}
const selectQueue: unknown[] = [];
const dbStub = {
  select: vi.fn(() => fluent(selectQueue.shift() ?? [])),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

const poolQuery = vi.fn();
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

import summaryRouter from "./summary";

const ALLOWED_EMAIL = "ops@penn.example.com";

function makeApp(): Express {
  const app = express();
  app.use("/resupply-api", summaryRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  getAuthMock.mockReturnValue({ userId: "user_op" });
  getUserMock.mockResolvedValue({
    primaryEmailAddressId: "eml_1",
    emailAddresses: [
      {
        id: "eml_1",
        emailAddress: ALLOWED_EMAIL,
        verification: { status: "verified" },
      },
    ],
  });
}

const ENV_KEYS = ["RESUPPLY_ADMIN_EMAILS", "NODE_ENV"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

describe("GET /dashboard/summary", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = "test";
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    selectQueue.length = 0;
    getAuthMock.mockReset();
    getUserMock.mockReset();
    dbStub.select.mockClear();
    poolQuery.mockReset();
    // Default: no sweep audit row. Tests that care about the sweep
    // slot override this with `poolQuery.mockResolvedValueOnce(...)`.
    poolQuery.mockResolvedValue({ rows: [] });
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns 401 with no Clerk session", async () => {
    getAuthMock.mockReturnValue({ userId: null });
    const res = await request(makeApp()).get("/resupply-api/dashboard/summary");
    expect(res.status).toBe(401);
  });

  it("returns the five COUNT(*) values in the response body", async () => {
    stubVerifiedAdmin();
    selectQueue.push([{ count: 7 }]); // activeConversations
    selectQueue.push([{ count: 3 }]); // awaitingAdmin
    selectQueue.push([{ count: 12 }]); // overdueEpisodes
    selectQueue.push([{ count: 41 }]); // fulfillmentsThisWeek
    selectQueue.push([{ count: 2 }]); // pausedPatients
    // poolQuery default ({ rows: [] }) → no sweep row → null

    const res = await request(makeApp()).get("/resupply-api/dashboard/summary");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      activeConversations: 7,
      awaitingAdmin: 3,
      overdueEpisodes: 12,
      fulfillmentsThisWeek: 41,
      pausedPatients: 2,
      prescriptionAttachmentSweep: null,
    });
  });

  it("defaults a missing count row to 0", async () => {
    stubVerifiedAdmin();
    selectQueue.push([]);
    selectQueue.push([{ count: 1 }]);
    selectQueue.push([]);
    selectQueue.push([]);
    selectQueue.push([]);

    const res = await request(makeApp()).get("/resupply-api/dashboard/summary");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      activeConversations: 0,
      awaitingAdmin: 1,
      overdueEpisodes: 0,
      fulfillmentsThisWeek: 0,
      pausedPatients: 0,
      prescriptionAttachmentSweep: null,
    });
  });

  describe("prescriptionAttachmentSweep field", () => {
    // These tests focus on the sweep-status slot. The five COUNT(*)
    // tiles aren't the subject — queue five empty `select()` results
    // up front so the handler runs cleanly through them, then stage
    // the sweep `pool.query()` result via `mockResolvedValueOnce`.
    function queueZeroCounts(): void {
      for (let i = 0; i < 5; i += 1) selectQueue.push([]);
    }

    const ALL_ZERO_METADATA = {
      objects_scanned: 0,
      references_loaded: 0,
      orphans_deleted: 0,
      orphans_too_young: 0,
      orphans_no_time_created: 0,
      delete_errors: 0,
      delete_404_idempotent: 0,
      recheck_saved: 0,
      non_attachment_skipped: 0,
    } as const;

    it("issues a parameterised SELECT against resupply.audit_log", async () => {
      // Lock the SQL shape: anything else (raw substitution, missing
      // ORDER BY, missing LIMIT) would let us silently surface a stale
      // row or, worse, all sweep rows ever.
      stubVerifiedAdmin();
      queueZeroCounts();
      poolQuery.mockResolvedValueOnce({ rows: [] });

      await request(makeApp()).get("/resupply-api/dashboard/summary");

      expect(poolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = poolQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/FROM\s+resupply\.audit_log/);
      expect(sql).toMatch(/WHERE\s+action\s*=\s*\$1/);
      expect(sql).toMatch(/ORDER BY\s+occurred_at\s+DESC/);
      expect(sql).toMatch(/LIMIT 1/);
      expect(params).toEqual(["prescription.attachment.sweep"]);
    });

    it("surfaces the latest sweep row with snake→camel mapping", async () => {
      stubVerifiedAdmin();
      queueZeroCounts();
      poolQuery.mockResolvedValueOnce({
        rows: [
          {
            occurred_at: new Date("2026-04-26T03:13:42.000Z"),
            metadata: {
              objects_scanned: 1234,
              references_loaded: 1100,
              orphans_deleted: 7,
              orphans_too_young: 3,
              orphans_no_time_created: 0,
              delete_errors: 0,
              delete_404_idempotent: 1,
              recheck_saved: 2,
              non_attachment_skipped: 5,
            },
          },
        ],
      });

      const res = await request(makeApp()).get(
        "/resupply-api/dashboard/summary",
      );
      expect(res.status).toBe(200);
      expect(res.body.prescriptionAttachmentSweep).toEqual({
        lastRunAt: "2026-04-26T03:13:42.000Z",
        counters: {
          objectsScanned: 1234,
          referencesLoaded: 1100,
          orphansDeleted: 7,
          orphansTooYoung: 3,
          orphansNoTimeCreated: 0,
          deleteErrors: 0,
          delete404Idempotent: 1,
          recheckSaved: 2,
          nonAttachmentSkipped: 5,
        },
      });
    });

    it("degrades to null when metadata fails Zod validation", async () => {
      // Missing several required fields + one negative — strict
      // schema must reject and the route must NOT 500.
      stubVerifiedAdmin();
      queueZeroCounts();
      poolQuery.mockResolvedValueOnce({
        rows: [
          {
            occurred_at: new Date("2026-04-26T03:13:42.000Z"),
            metadata: { objects_scanned: -1, garbage: "yes" },
          },
        ],
      });

      const res = await request(makeApp()).get(
        "/resupply-api/dashboard/summary",
      );
      expect(res.status).toBe(200);
      expect(res.body.prescriptionAttachmentSweep).toBeNull();
    });

    it("degrades to null when occurred_at is missing/invalid", async () => {
      // Belt-and-suspenders: even if metadata parses, an
      // unparseable occurred_at must not let "Invalid Date" leak
      // into the response.
      stubVerifiedAdmin();
      queueZeroCounts();
      poolQuery.mockResolvedValueOnce({
        rows: [{ occurred_at: null, metadata: ALL_ZERO_METADATA }],
      });

      const res = await request(makeApp()).get(
        "/resupply-api/dashboard/summary",
      );
      expect(res.status).toBe(200);
      expect(res.body.prescriptionAttachmentSweep).toBeNull();
    });

    it("coerces a string occurred_at into an ISO date-time", async () => {
      // The pg driver normally hands timestamptz back as a Date, but
      // some pool configurations / mocks return it as a string. The
      // helper must produce a stable ISO string either way.
      stubVerifiedAdmin();
      queueZeroCounts();
      poolQuery.mockResolvedValueOnce({
        rows: [
          {
            occurred_at: "2026-04-26T03:13:42.000Z",
            metadata: ALL_ZERO_METADATA,
          },
        ],
      });

      const res = await request(makeApp()).get(
        "/resupply-api/dashboard/summary",
      );
      expect(res.status).toBe(200);
      expect(res.body.prescriptionAttachmentSweep?.lastRunAt).toBe(
        "2026-04-26T03:13:42.000Z",
      );
    });
  });
});
