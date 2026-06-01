// Tests for /admin/billing/timely-filing (Biller #36) — the pure
// worklist builder + the HTTP route.

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

import billingTimelyFilingRouter, {
  buildTimelyFilingWorklist,
} from "./billing-timely-filing";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "biller@penn.example.com",
  role: "admin",
};
// rt (clinician bucket) lacks reports.read → 403.
const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(billingTimelyFilingRouter);
  return app;
}

function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("buildTimelyFilingWorklist (pure)", () => {
  const asOf = "2026-05-31T12:00:00Z";

  it("ranks most-urgent first and sinks unknown-window claims to the bottom", () => {
    const { rows, counts } = buildTimelyFilingWorklist(
      [
        {
          id: "ok",
          patientId: "p",
          payerName: "Aetna",
          status: "submitted",
          dateOfService: "2026-05-01",
          totalBilledCents: 1000,
          filingWindowDays: 90, // deadline ~2026-07-30 → ~60 days
        },
        {
          id: "unknown",
          patientId: "p",
          payerName: null,
          status: "draft",
          dateOfService: "2026-05-01",
          totalBilledCents: null,
          filingWindowDays: null, // no window → unknown
        },
        {
          id: "overdue",
          patientId: "p",
          payerName: "UHC",
          status: "draft",
          dateOfService: "2026-01-01",
          totalBilledCents: 2000,
          filingWindowDays: 90, // deadline 2026-04-01 → past due
        },
        {
          id: "due_soon",
          patientId: "p",
          payerName: "Cigna",
          status: "submitted",
          dateOfService: "2026-03-15",
          totalBilledCents: 3000,
          filingWindowDays: 90, // deadline 2026-06-13 → 13 days
        },
      ],
      { asOf },
    );

    expect(rows.map((r) => r.id)).toEqual([
      "overdue",
      "due_soon",
      "ok",
      "unknown",
    ]);
    expect(rows[0]?.filingStatus).toBe("overdue");
    expect(rows[0]!.daysRemaining!).toBeLessThan(0);
    const dueSoon = rows.find((r) => r.id === "due_soon");
    expect(dueSoon?.filingStatus).toBe("due_soon");
    expect(dueSoon?.daysRemaining).toBe(13);
    expect(rows[3]).toMatchObject({
      id: "unknown",
      filingStatus: "unknown",
      daysRemaining: null,
      deadline: null,
    });
    expect(counts).toEqual({
      overdue: 1,
      dueSoon: 1,
      ok: 1,
      unknown: 1,
      total: 4,
    });
  });

  it("treats a zero / negative window as unknown (never a fabricated deadline)", () => {
    const { rows, counts } = buildTimelyFilingWorklist([
      {
        id: "z",
        patientId: "p",
        payerName: "X",
        status: "draft",
        dateOfService: "2026-01-01",
        totalBilledCents: 0,
        filingWindowDays: 0,
      },
    ]);
    expect(rows[0]?.filingStatus).toBe("unknown");
    expect(rows[0]?.deadline).toBeNull();
    expect(counts.unknown).toBe(1);
  });
});

describe("GET /admin/billing/timely-filing", () => {
  it("401s without admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/billing/timely-filing")).status,
    ).toBe(401);
  });

  it("403s for a role without reports.read (rt)", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp()).get("/admin/billing/timely-filing");
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("reports.read");
  });

  it("returns ranked claims + bucket counts, resolving the per-payer window", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          id: "c_ok",
          patient_id: "p1",
          payer_name: "Aetna",
          status: "submitted",
          date_of_service: daysAgoIso(5),
          total_billed_cents: 1000,
          payer_profile_id: "pay_90",
        },
        {
          id: "c_overdue",
          patient_id: "p2",
          payer_name: "UHC",
          status: "draft",
          date_of_service: daysAgoIso(120),
          total_billed_cents: 2000,
          payer_profile_id: "pay_90",
        },
        {
          id: "c_unknown",
          patient_id: "p3",
          payer_name: "Self-pay",
          status: "draft",
          date_of_service: daysAgoIso(5),
          total_billed_cents: 500,
          payer_profile_id: null,
        },
      ],
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: [{ id: "pay_90", timely_filing_days: 90 }],
    });

    const res = await request(makeApp()).get("/admin/billing/timely-filing");
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({
      overdue: 1,
      dueSoon: 0,
      ok: 1,
      unknown: 1,
      total: 3,
    });
    // Most-urgent first; unknown last.
    expect(res.body.claims[0].id).toBe("c_overdue");
    expect(res.body.claims[0].filingStatus).toBe("overdue");
    expect(res.body.claims[res.body.claims.length - 1].id).toBe("c_unknown");
    expect(res.body.claims[res.body.claims.length - 1].filingStatus).toBe(
      "unknown",
    );
  });

  it("filters to a single status bucket when asked", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          id: "c_overdue",
          patient_id: "p2",
          payer_name: "UHC",
          status: "draft",
          date_of_service: daysAgoIso(120),
          total_billed_cents: 2000,
          payer_profile_id: "pay_90",
        },
        {
          id: "c_ok",
          patient_id: "p1",
          payer_name: "Aetna",
          status: "submitted",
          date_of_service: daysAgoIso(5),
          total_billed_cents: 1000,
          payer_profile_id: "pay_90",
        },
      ],
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: [{ id: "pay_90", timely_filing_days: 90 }],
    });

    const res = await request(makeApp()).get(
      "/admin/billing/timely-filing?status=overdue",
    );
    expect(res.status).toBe(200);
    expect(res.body.claims).toHaveLength(1);
    expect(res.body.claims[0].id).toBe("c_overdue");
    // counts still reflect the full worklist, not the filtered view.
    expect(res.body.counts.total).toBe(2);
  });
});
