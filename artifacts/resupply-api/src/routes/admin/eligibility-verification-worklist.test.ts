// Tests for /admin/billing/eligibility-verification-worklist (Biller #31)
// — the pure ranking core + the HTTP route.

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

import eligibilityVerificationWorklistRouter, {
  buildVerificationWorklist,
  type CoverageInput,
} from "./eligibility-verification-worklist";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "biller@penn.example.com",
  role: "admin",
};
const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(eligibilityVerificationWorklistRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("buildVerificationWorklist (pure)", () => {
  const asOf = "2026-05-31T00:00:00Z";

  it("classifies + ranks terminating_soon > never_verified > stale > ok", () => {
    const coverages: CoverageInput[] = [
      {
        id: "ok",
        patientId: "p",
        rank: "primary",
        payerName: "Aetna",
        memberIdTail: "1234",
        verifiedAt: "2026-05-20", // 11 days ago < 30 → ok
        terminationDate: null,
      },
      {
        id: "stale",
        patientId: "p",
        rank: "primary",
        payerName: "UHC",
        memberIdTail: "5678",
        verifiedAt: "2026-01-01", // ~150 days ago → stale
        terminationDate: null,
      },
      {
        id: "never",
        patientId: "p",
        rank: "secondary",
        payerName: "Cigna",
        memberIdTail: null,
        verifiedAt: null, // → never_verified
        terminationDate: null,
      },
      {
        id: "terming",
        patientId: "p",
        rank: "primary",
        payerName: "Humana",
        memberIdTail: "9999",
        verifiedAt: "2026-05-29", // fresh, but…
        terminationDate: "2026-06-10", // 10 days out → terminating_soon
      },
    ];
    const { items, counts } = buildVerificationWorklist(coverages, { asOf });

    expect(items.map((i) => i.id)).toEqual(["terming", "never", "stale", "ok"]);
    const terming = items[0]!;
    expect(terming.status).toBe("terminating_soon");
    expect(terming.daysUntilTermination).toBe(10);
    const stale = items.find((i) => i.id === "stale")!;
    expect(stale.status).toBe("stale");
    expect(stale.daysSinceVerified).toBeGreaterThan(30);

    expect(counts).toEqual({
      neverVerified: 1,
      terminatingSoon: 1,
      stale: 1,
      ok: 1,
      total: 4,
    });
  });

  it("respects a custom staleDays threshold", () => {
    const { items } = buildVerificationWorklist(
      [
        {
          id: "c",
          patientId: "p",
          rank: "primary",
          payerName: "X",
          memberIdTail: null,
          verifiedAt: "2026-05-20", // 11 days ago
          terminationDate: null,
        },
      ],
      { asOf, staleDays: 7 }, // 11 > 7 → stale now
    );
    expect(items[0]!.status).toBe("stale");
  });
});

describe("GET /admin/billing/eligibility-verification-worklist", () => {
  it("401s without admin", async () => {
    expect(
      (
        await request(makeApp()).get(
          "/admin/billing/eligibility-verification-worklist",
        )
      ).status,
    ).toBe(401);
  });

  it("403s for a role without reports.read (rt)", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp()).get(
      "/admin/billing/eligibility-verification-worklist",
    );
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("reports.read");
  });

  it("returns only actionable rows by default and masks the member id", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("insurance_coverages", "select", {
      data: [
        {
          id: "never",
          patient_id: "p1",
          rank: "primary",
          payer_name: "Cigna",
          member_id: "ABC123456789",
          verified_at: null,
          termination_date: null,
        },
        {
          id: "ok",
          patient_id: "p2",
          rank: "primary",
          payer_name: "Aetna",
          member_id: "ZZZ000011112222",
          verified_at: new Date().toISOString(),
          termination_date: null,
        },
      ],
    });

    const res = await request(makeApp()).get(
      "/admin/billing/eligibility-verification-worklist",
    );
    expect(res.status).toBe(200);
    // ok row filtered out of items by default; counts still include it.
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe("never");
    expect(res.body.items[0].memberIdTail).toBe("6789"); // last 4 only
    expect(JSON.stringify(res.body)).not.toContain("ABC123456789");
    expect(res.body.counts.total).toBe(2);
    expect(res.body.counts.ok).toBe(1);
  });
});
