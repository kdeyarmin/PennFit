// Route tests for /admin/billing/prior-auth-queue.
//
// Coverage:
//   * 401 when unauthenticated
//   * groups the parallel queries into the right five buckets and
//     stamps daysToTarget / daysToExpiry on each row
//   * counts mirror the bucket lengths
//   * 400 on out-of-range expiringWithinDays
//
// The route fires five parallel queries against `prior_authorizations`
// with different filters; the mock returns them in FIFO order so the
// happy-path test stages five `select` responses in the same order the
// route awaits them (atRisk → missed → awaiting → expiring → drafts).

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

import priorAuthQueueRouter from "./prior-auth-queue";

const PATIENT = "11111111-aaaa-4111-8111-aaaaaaaaaaaa";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", priorAuthQueueRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "user_op",
    email: "ops@penn.example.com",
    role: "admin",
  };
}

function paRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "row-" + Math.random().toString(36).slice(2, 10),
    patient_id: PATIENT,
    payer_name: "UPMC for You",
    hcpcs_code: "E0601",
    status: "submitted",
    auth_number: null,
    submitted_at: "2026-05-15T10:00:00.000Z",
    decision_at: null,
    approved_through: null,
    mco_sla_status: null,
    mco_sla_target_date: null,
    created_at: "2026-05-14T10:00:00.000Z",
    updated_at: "2026-05-15T10:00:00.000Z",
    ...over,
  };
}

describe("/admin/billing/prior-auth-queue", () => {
  beforeEach(() => {
    supabaseMock.reset();
    mockAdmin.current = null;
  });

  // Belt-and-braces cleanup: restore any Date.now / fake-timer
  // setup that a thrown assertion might have leaked.
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("401s when no admin session", async () => {
    const res = await request(makeApp()).get(
      "/resupply-api/admin/billing/prior-auth-queue",
    );
    expect(res.status).toBe(401);
  });

  it("groups rows into atRisk / missed / awaiting / expiringSoon / drafts", async () => {
    stubVerifiedAdmin();
    // Stage queries in the order the route awaits them via Promise.all:
    //   atRisk, missed, awaiting, expiringSoon, drafts
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [
        paRow({
          id: "atrisk-1",
          mco_sla_status: "at_risk",
          mco_sla_target_date: "2026-05-22",
        }),
      ],
    });
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [
        paRow({
          id: "missed-1",
          mco_sla_status: "missed",
          mco_sla_target_date: "2026-05-10",
        }),
      ],
    });
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [paRow({ id: "await-1", mco_sla_status: null })],
    });
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [
        paRow({
          id: "expiring-1",
          status: "approved",
          approved_through: "2026-06-01",
          submitted_at: "2026-04-15T10:00:00.000Z",
          decision_at: "2026-04-20T10:00:00.000Z",
        }),
      ],
    });
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [
        paRow({
          id: "draft-1",
          status: "draft",
          submitted_at: null,
        }),
      ],
    });

    const res = await request(makeApp()).get(
      "/resupply-api/admin/billing/prior-auth-queue",
    );

    expect(res.status).toBe(200);
    expect(res.body.atRisk).toHaveLength(1);
    expect(res.body.atRisk[0].id).toBe("atrisk-1");
    expect(res.body.missed[0].id).toBe("missed-1");
    expect(res.body.awaiting[0].id).toBe("await-1");
    expect(res.body.expiringSoon[0].id).toBe("expiring-1");
    expect(res.body.drafts[0].id).toBe("draft-1");
    expect(res.body.counts).toEqual({
      atRisk: 1,
      missed: 1,
      awaiting: 1,
      expiringSoon: 1,
      drafts: 1,
    });
    expect(res.body.expiringWithinDays).toBe(30);
    // expiringSoon row carries a numeric daysToExpiry off the date.
    expect(typeof res.body.expiringSoon[0].daysToExpiry).toBe("number");
  });

  it("400s with field-level issues when expiringWithinDays is out of range", async () => {
    stubVerifiedAdmin();

    const res = await request(makeApp()).get(
      "/resupply-api/admin/billing/prior-auth-queue?expiringWithinDays=999",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues[0].path).toContain("expiringWithinDays");
  });

  it("daysToTarget is deterministic across clock-times within a UTC day (regression: was Math.round)", async () => {
    // The historical bug was that daysBetween used Math.round, so
    // the same (now, target) pair could flip between adjacent
    // integer day counts depending on whether the route ran at
    // 8am vs 4pm. The fix uses floor for future targets and ceil
    // for past targets, both of which are time-of-day invariant
    // within the source UTC day.
    //
    // Mock Date.now() directly rather than vi.useFakeTimers() —
    // the latter mocks setImmediate/setTimeout which would deadlock
    // supertest's HTTP plumbing. Targeted Date.now spy is what the
    // route actually reads.
    stubVerifiedAdmin();
    const target = "2026-05-25";

    async function runAt(nowIso: string): Promise<number | null> {
      const fixedNow = new Date(nowIso).getTime();
      const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
      try {
        stageSupabaseResponse("prior_authorizations", "select", {
          data: [
            paRow({
              id: "atrisk-deterministic",
              mco_sla_status: "at_risk",
              mco_sla_target_date: target,
            }),
          ],
        });
        stageSupabaseResponse("prior_authorizations", "select", { data: [] });
        stageSupabaseResponse("prior_authorizations", "select", { data: [] });
        stageSupabaseResponse("prior_authorizations", "select", { data: [] });
        stageSupabaseResponse("prior_authorizations", "select", { data: [] });
        const res = await request(makeApp()).get(
          "/resupply-api/admin/billing/prior-auth-queue",
        );
        expect(res.status).toBe(200);
        return res.body.atRisk[0].daysToTarget;
      } finally {
        dateNowSpy.mockRestore();
      }
    }

    const morning = await runAt("2026-05-20T08:00:00.000Z");
    supabaseMock.reset();
    mockAdmin.current = {
      userId: "user_op",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const afternoon = await runAt("2026-05-20T16:00:00.000Z");
    expect(morning).toBe(afternoon);
    expect(typeof morning).toBe("number");
  });
});
