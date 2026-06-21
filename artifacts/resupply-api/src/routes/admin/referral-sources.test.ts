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
  stageSupabaseRpcResponse,
  getSupabaseRpcArgs,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

import referralSourcesRouter from "./referral-sources";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(referralSourcesRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/referrals/scorecard", () => {
  it("401 unauthenticated", async () => {
    const res = await request(makeApp()).get("/admin/referrals/scorecard");
    expect(res.status).toBe(401);
  });

  it("returns mapped scorecard rows and passes p_org_id + window", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("referral_source_scorecard", {
      data: [
        {
          provider_id: "prov-1",
          provider_name: "Dr. Sleep",
          practice_name: "Sleep Clinic",
          npi: "1234567890",
          claim_count: "12",
          patient_count: "8",
          claims_since: "3",
          paid_cents: "45000",
          last_activity_on: "2026-06-01",
        },
      ],
    });
    const res = await request(makeApp()).get(
      "/admin/referrals/scorecard?sinceDays=30",
    );
    expect(res.status).toBe(200);
    expect(res.body.sinceDays).toBe(30);
    expect(res.body.sources).toHaveLength(1);
    // bigint-as-string is coerced to number for the client
    expect(res.body.sources[0]).toMatchObject({
      providerId: "prov-1",
      claimCount: 12,
      patientCount: 8,
      claimsSince: 3,
      paidCents: 45000,
      lastActivityOn: "2026-06-01",
    });
    const args = getSupabaseRpcArgs("referral_source_scorecard")[0] as {
      p_org_id: string;
      p_since: string;
    };
    expect(args.p_org_id).toBeTruthy();
    expect(typeof args.p_since).toBe("string");
  });

  it("400 on an out-of-range window", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/referrals/scorecard?sinceDays=9999",
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/providers/:id/referral-activity", () => {
  it("returns the org-scoped activity log", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("referral_source_activity", "select", {
      data: [
        {
          id: "act-1",
          provider_id: "11111111-1111-4111-8111-111111111111",
          activity_type: "visit",
          occurred_on: "2026-06-10",
          summary: "Dropped off brochures",
          next_action: "Follow up in 2 weeks",
          created_by_email: "rep@penn.example.com",
          created_at: "2026-06-10T12:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get(
      "/admin/providers/11111111-1111-4111-8111-111111111111/referral-activity",
    );
    expect(res.status).toBe(200);
    expect(res.body.activity).toHaveLength(1);
    expect(res.body.activity[0].activityType).toBe("visit");
  });

  it("400 on a non-uuid provider id", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/providers/not-a-uuid/referral-activity",
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/providers/:id/referral-activity", () => {
  const PID = "11111111-1111-4111-8111-111111111111";

  it("logs a rep touch when the provider exists", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("providers", "select", { data: { id: PID } });
    stageSupabaseResponse("referral_source_activity", "insert", {
      data: { id: "act-new", occurred_on: "2026-06-21" },
    });
    const res = await request(makeApp())
      .post(`/admin/providers/${PID}/referral-activity`)
      .send({ activityType: "call", summary: "Quarterly check-in call" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("act-new");
    const writes = supabaseMock.writePayloads(
      "referral_source_activity",
      "insert",
    )[0] as Record<string, unknown>;
    expect(writes.provider_id).toBe(PID);
    expect(writes.activity_type).toBe("call");
  });

  it("404 when the provider does not exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("providers", "select", { data: null });
    const res = await request(makeApp())
      .post(`/admin/providers/${PID}/referral-activity`)
      .send({ summary: "Visit" });
    expect(res.status).toBe(404);
  });

  it("400 on an empty summary", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/providers/${PID}/referral-activity`)
      .send({ summary: "" });
    expect(res.status).toBe(400);
  });
});
