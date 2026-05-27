// Route tests for GET /dashboard/summary.
//
// Five `head: true` count probes (conversations × 2, episodes,
// fulfillments, patients) plus the sweep-status helper which reads
// the latest `prescription_attachment_sweep` run from
// resupply.worker_run_summary via the Supabase service-role client.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

import summaryRouter from "./summary";

const ALLOWED_EMAIL = "ops@penn.example.com";

function makeApp(): Express {
  const app = express();
  app.use("/resupply-api", summaryRouter);
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

// Stage the five count probes the route runs in parallel. Their
// order in `Promise.all` is:
//   1. conversations (active)
//   2. conversations (awaiting_admin)
//   3. episodes
//   4. fulfillments
//   5. patients
// `conversations` is queried twice — same table, same op, so the
// per-(table, op) FIFO queue consumes them in array order.
function stageCounts(counts: {
  activeConversations: number;
  awaitingAdmin: number;
  overdueEpisodes: number;
  fulfillmentsThisWeek: number;
  pausedPatients: number;
}): void {
  stageSupabaseResponse("conversations", "select", {
    data: null,
    count: counts.activeConversations,
  });
  stageSupabaseResponse("conversations", "select", {
    data: null,
    count: counts.awaitingAdmin,
  });
  stageSupabaseResponse("episodes", "select", {
    data: null,
    count: counts.overdueEpisodes,
  });
  stageSupabaseResponse("fulfillments", "select", {
    data: null,
    count: counts.fulfillmentsThisWeek,
  });
  stageSupabaseResponse("patients", "select", {
    data: null,
    count: counts.pausedPatients,
  });
}

describe("GET /dashboard/summary", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];

    process.env.NODE_ENV = "test";
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    mockAdmin.current = null;
    supabaseMock.reset();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns 401 with no session", async () => {
    const res = await request(makeApp()).get("/resupply-api/dashboard/summary");
    expect(res.status).toBe(401);
  });

  it("returns the five COUNT(*) values in the response body", async () => {
    stubVerifiedAdmin();
    stageCounts({
      activeConversations: 7,
      awaitingAdmin: 3,
      overdueEpisodes: 12,
      fulfillmentsThisWeek: 41,
      pausedPatients: 2,
    });
    // Sweep-status helper fetches from worker_run_summary via
    // .maybeSingle(); empty data → null sweep status.
    stageSupabaseResponse("worker_run_summary", "select", { data: null });

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
    // PostgREST can return `count: null` if the count header was
    // dropped; the route's `?? 0` coerces.
    stageSupabaseResponse("conversations", "select", {
      data: null,
      count: null,
    });
    stageSupabaseResponse("conversations", "select", {
      data: null,
      count: 1,
    });
    stageSupabaseResponse("episodes", "select", {
      data: null,
      count: null,
    });
    stageSupabaseResponse("fulfillments", "select", {
      data: null,
      count: null,
    });
    stageSupabaseResponse("patients", "select", {
      data: null,
      count: null,
    });
    stageSupabaseResponse("worker_run_summary", "select", { data: null });

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
    const ALL_ZERO_METADATA = {
      objects_scanned: 0,
      references_loaded: 0,
      orphans_deleted: 0,
      bytes_reclaimed: 0,
      orphans_too_young: 0,
      orphans_no_time_created: 0,
      delete_errors: 0,
      delete_404_idempotent: 0,
      recheck_saved: 0,
      non_attachment_skipped: 0,
    } as const;

    function stageZeroCounts(): void {
      stageCounts({
        activeConversations: 0,
        awaitingAdmin: 0,
        overdueEpisodes: 0,
        fulfillmentsThisWeek: 0,
        pausedPatients: 0,
      });
    }

    it("surfaces the latest sweep row with snake→camel mapping", async () => {
      stubVerifiedAdmin();
      stageZeroCounts();
      stageSupabaseResponse("worker_run_summary", "select", {
        data: {
          completed_at: "2026-04-26T03:13:42.000Z",
          counters: {
            objects_scanned: 1234,
            references_loaded: 1100,
            orphans_deleted: 7,
            bytes_reclaimed: 12_345_678,
            orphans_too_young: 3,
            orphans_no_time_created: 0,
            delete_errors: 0,
            delete_404_idempotent: 1,
            recheck_saved: 2,
            non_attachment_skipped: 5,
          },
        },
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
          bytesReclaimed: 12_345_678,
          orphansTooYoung: 3,
          orphansNoTimeCreated: 0,
          deleteErrors: 0,
          delete404Idempotent: 1,
          recheckSaved: 2,
          nonAttachmentSkipped: 5,
        },
      });
    });

    it("degrades to null when counters fail Zod validation", async () => {
      // Missing several required fields + one negative — strict
      // schema must reject and the route must NOT 500.
      stubVerifiedAdmin();
      stageZeroCounts();
      stageSupabaseResponse("worker_run_summary", "select", {
        data: {
          completed_at: "2026-04-26T03:13:42.000Z",
          counters: { objects_scanned: -1, garbage: "yes" },
        },
      });

      const res = await request(makeApp()).get(
        "/resupply-api/dashboard/summary",
      );
      expect(res.status).toBe(200);
      expect(res.body.prescriptionAttachmentSweep).toBeNull();
    });

    it("degrades to null when completed_at is missing/invalid", async () => {
      // Belt-and-suspenders: even if counters parse, an unparseable
      // completed_at must not let "Invalid Date" leak into the
      // response.
      stubVerifiedAdmin();
      stageZeroCounts();
      stageSupabaseResponse("worker_run_summary", "select", {
        data: { completed_at: null, counters: ALL_ZERO_METADATA },
      });

      const res = await request(makeApp()).get(
        "/resupply-api/dashboard/summary",
      );
      expect(res.status).toBe(200);
      expect(res.body.prescriptionAttachmentSweep).toBeNull();
    });

    it("normalises completed_at to a stable ISO string", async () => {
      // PostgREST returns timestamptz as an ISO string; the helper
      // round-trips through Date to normalise the format.
      stubVerifiedAdmin();
      stageZeroCounts();
      stageSupabaseResponse("worker_run_summary", "select", {
        data: {
          completed_at: "2026-04-26T03:13:42.000Z",
          counters: ALL_ZERO_METADATA,
        },
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
