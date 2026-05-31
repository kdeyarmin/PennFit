// Route tests for GET /admin/reports/therapy-usage
//
// Coverage:
//   1. Auth: 401 when not signed in, 403 when lacking reports.read.
//   2. Query validation: invalid groupBy, days out of range.
//   3. Default params: groupBy=provider, days=30 applied when missing.
//   4. patient grouping: no extra DB reads, de-identified labels.
//   5. provider grouping: reads prescriptions + providers, sublabel from NPI.
//   6. manufacturer grouping: reads equipment_assets.
//   7. Unattributed bucket: patient with no prescriptions → Unattributed group.
//   8. Response shape: windowDays, generatedAt, grouping, summary, groups.

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

// ── Supabase mock (module-scoped) ─────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── Auth mock ─────────────────────────────────────────────────────────────────
const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import therapyUsageReportRouter from "./therapy-usage-report";

// supervisor → has reports.read
const REPORTS_READER: MockAdminCtx = {
  userId: "u_sup_1",
  email: "sup@penn.example.com",
  role: "agent",
  granularRole: "supervisor",
};

// fulfillment → does NOT have reports.read in RBAC phase B+
const NO_REPORTS_READER: MockAdminCtx = {
  userId: "u_agent_1",
  email: "agent@penn.example.com",
  role: "agent",
  granularRole: "fulfillment",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(therapyUsageReportRouter);
  return app;
}

function stubAdmin(ctx: MockAdminCtx = REPORTS_READER) {
  mockAdmin.current = ctx;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe("GET /admin/reports/therapy-usage — auth", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=provider&days=30",
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when the admin lacks reports.read", async () => {
    mockAdmin.current = NO_REPORTS_READER;
    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=provider&days=30",
    );
    expect(res.status).toBe(403);
  });
});

// ─── Query validation ─────────────────────────────────────────────────────────

describe("GET /admin/reports/therapy-usage — query validation", () => {
  it("returns 400 on an invalid groupBy value", async () => {
    stubAdmin();
    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=garbage&days=30",
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });

  it("returns 400 when days=0 (below minimum of 1)", async () => {
    stubAdmin();
    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=provider&days=0",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when days=366 (above maximum of 365)", async () => {
    stubAdmin();
    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=provider&days=366",
    );
    expect(res.status).toBe(400);
  });

  it("accepts days=365 (at the maximum)", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [],
      error: null,
    });
    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=provider&days=365",
    );
    expect(res.status).toBe(200);
  });

  it("accepts days=1 (at the minimum)", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [],
      error: null,
    });
    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=provider&days=1",
    );
    expect(res.status).toBe(200);
  });
});

// ─── Default params ───────────────────────────────────────────────────────────

describe("GET /admin/reports/therapy-usage — default parameters", () => {
  it("uses groupBy=provider by default", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [],
      error: null,
    });
    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?days=30",
    );
    expect(res.status).toBe(200);
    expect(res.body.grouping).toBe("provider");
  });

  it("uses days=30 by default", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [],
      error: null,
    });
    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=provider",
    );
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
  });

  it("returns 200 with no query params (all defaults)", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [],
      error: null,
    });
    const res = await request(makeApp()).get("/admin/reports/therapy-usage");
    expect(res.status).toBe(200);
    expect(res.body.grouping).toBe("provider");
    expect(res.body.windowDays).toBe(30);
  });
});

// ─── Response shape ───────────────────────────────────────────────────────────

describe("GET /admin/reports/therapy-usage — response shape", () => {
  it("returns windowDays, generatedAt, grouping, summary, groups", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [],
      error: null,
    });
    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=patient&days=60",
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("windowDays", 60);
    expect(res.body).toHaveProperty("generatedAt");
    expect(res.body).toHaveProperty("grouping", "patient");
    expect(res.body).toHaveProperty("summary");
    expect(res.body).toHaveProperty("groups");
    expect(Array.isArray(res.body.groups)).toBe(true);
  });

  it("summary includes patientCount, avgUsageHours, cmsCompliantPatients", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [],
      error: null,
    });
    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=patient&days=30",
    );
    expect(res.status).toBe(200);
    expect(res.body.summary).toHaveProperty("patientCount");
    expect(res.body.summary).toHaveProperty("avgUsageHours");
    expect(res.body.summary).toHaveProperty("cmsCompliantPatients");
    expect(res.body.summary).toHaveProperty("cmsComplianceRate");
  });

  it("generatedAt is an ISO datetime string", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [],
      error: null,
    });
    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=patient&days=30",
    );
    expect(res.status).toBe(200);
    expect(new Date(res.body.generatedAt).getTime()).not.toBeNaN();
  });
});

// ─── patient grouping ─────────────────────────────────────────────────────────

describe("GET /admin/reports/therapy-usage — groupBy=patient", () => {
  it("returns one group per patient with a de-identified label", async () => {
    stubAdmin();
    const patientId = "abc12345-0000-0000-0000-000000000000";
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        {
          patient_id: patientId,
          usage_minutes: 300,
          ahi: 3,
          leak_rate_l_min: 5,
        },
      ],
      error: null,
    });

    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=patient&days=30",
    );

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    const group = res.body.groups[0];
    // De-identified: first 8 chars uppercased, prefixed with "Patient "
    expect(group.label).toBe("Patient ABC12345");
    // Must not contain a raw UUID
    expect(group.label).not.toContain("-");
  });

  it("does NOT query prescriptions or equipment_assets for patient grouping", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        {
          patient_id: "p1-0000-0000-0000-000000000000",
          usage_minutes: 240,
          ahi: null,
          leak_rate_l_min: null,
        },
      ],
      error: null,
    });

    await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=patient&days=30",
    );

    // No prescriptions or equipment_assets reads expected.
    expect(supabaseMock.callCount("prescriptions", "select")).toBe(0);
    expect(supabaseMock.callCount("equipment_assets", "select")).toBe(0);
  });

  it("returns empty groups when no therapy nights exist", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [],
      error: null,
    });

    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=patient&days=30",
    );

    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
    expect(res.body.summary.patientCount).toBe(0);
  });
});

// ─── provider grouping ────────────────────────────────────────────────────────

describe("GET /admin/reports/therapy-usage — groupBy=provider", () => {
  it("queries patient_therapy_nights, prescriptions, and providers", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        {
          patient_id: "patient-1",
          usage_minutes: 300,
          ahi: null,
          leak_rate_l_min: null,
        },
      ],
      error: null,
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: [{ patient_id: "patient-1", provider_id: "provider-1" }],
      error: null,
    });
    stageSupabaseResponse("providers", "select", {
      data: [
        {
          id: "provider-1",
          legal_name: "Dr. Smith",
          npi: "1234567890",
          practice_name: "Smith Clinic",
        },
      ],
      error: null,
    });

    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=provider&days=30",
    );

    expect(res.status).toBe(200);
    expect(supabaseMock.callCount("patient_therapy_nights", "select")).toBe(1);
    expect(supabaseMock.callCount("prescriptions", "select")).toBe(1);
    expect(supabaseMock.callCount("providers", "select")).toBe(1);
  });

  it("builds the provider label from legal_name and sublabel from NPI + practice", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        {
          patient_id: "patient-1",
          usage_minutes: 300,
          ahi: null,
          leak_rate_l_min: null,
        },
      ],
      error: null,
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: [{ patient_id: "patient-1", provider_id: "provider-1" }],
      error: null,
    });
    stageSupabaseResponse("providers", "select", {
      data: [
        {
          id: "provider-1",
          legal_name: "Dr. Jane Doe",
          npi: "9876543210",
          practice_name: "Doe Sleep Center",
        },
      ],
      error: null,
    });

    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=provider&days=30",
    );

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    const group = res.body.groups[0];
    expect(group.label).toBe("Dr. Jane Doe");
    expect(group.sublabel).toContain("NPI 9876543210");
    expect(group.sublabel).toContain("Doe Sleep Center");
  });

  it("falls back to 'Unattributed' group for patients with no prescriptions", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        {
          patient_id: "patient-no-rx",
          usage_minutes: 300,
          ahi: null,
          leak_rate_l_min: null,
        },
      ],
      error: null,
    });
    // prescriptions returns nothing for this patient
    stageSupabaseResponse("prescriptions", "select", {
      data: [],
      error: null,
    });

    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=provider&days=30",
    );

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].label).toBe("Unattributed");
    expect(res.body.groups[0].sublabel).toBe("No prescriber on file");
  });

  it("does NOT query equipment_assets for provider grouping", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [],
      error: null,
    });

    await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=provider&days=30",
    );

    expect(supabaseMock.callCount("equipment_assets", "select")).toBe(0);
  });
});

// ─── manufacturer grouping ────────────────────────────────────────────────────

describe("GET /admin/reports/therapy-usage — groupBy=manufacturer", () => {
  it("queries patient_therapy_nights and equipment_assets", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        {
          patient_id: "patient-1",
          usage_minutes: 300,
          ahi: 3,
          leak_rate_l_min: 5,
        },
      ],
      error: null,
    });
    stageSupabaseResponse("equipment_assets", "select", {
      data: [{ patient_id: "patient-1", manufacturer: "ResMed" }],
      error: null,
    });

    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=manufacturer&days=30",
    );

    expect(res.status).toBe(200);
    expect(supabaseMock.callCount("patient_therapy_nights", "select")).toBe(1);
    expect(supabaseMock.callCount("equipment_assets", "select")).toBe(1);
  });

  it("groups nights by manufacturer name as key and label", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        {
          patient_id: "patient-1",
          usage_minutes: 300,
          ahi: null,
          leak_rate_l_min: null,
        },
      ],
      error: null,
    });
    stageSupabaseResponse("equipment_assets", "select", {
      data: [{ patient_id: "patient-1", manufacturer: "Philips" }],
      error: null,
    });

    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=manufacturer&days=30",
    );

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].label).toBe("Philips");
    expect(res.body.groups[0].key).toBe("Philips");
  });

  it("falls back to 'Unattributed' group for patients with no equipment on file", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        {
          patient_id: "patient-no-device",
          usage_minutes: 300,
          ahi: null,
          leak_rate_l_min: null,
        },
      ],
      error: null,
    });
    stageSupabaseResponse("equipment_assets", "select", {
      data: [],
      error: null,
    });

    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=manufacturer&days=30",
    );

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].label).toBe("Unattributed");
    expect(res.body.groups[0].sublabel).toBe("No device on file");
  });

  it("does NOT query prescriptions for manufacturer grouping", async () => {
    stubAdmin();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [],
      error: null,
    });
    stageSupabaseResponse("equipment_assets", "select", {
      data: [],
      error: null,
    });

    await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=manufacturer&days=30",
    );

    expect(supabaseMock.callCount("prescriptions", "select")).toBe(0);
  });
});

// ─── Aggregation correctness (light integration check) ────────────────────────

describe("GET /admin/reports/therapy-usage — aggregation via real aggregator", () => {
  it("counts CMS-compliant patients (≥240 min on ≥70% of nights) in summary", async () => {
    stubAdmin();
    // 3 nights for patient-A: 2 nights ≥ 240 min (67% < 70% → NOT compliant).
    // 4 nights for patient-B: 3 nights ≥ 240 min (75% ≥ 70% → compliant).
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        { patient_id: "patient-A", usage_minutes: 300, ahi: null, leak_rate_l_min: null },
        { patient_id: "patient-A", usage_minutes: 300, ahi: null, leak_rate_l_min: null },
        { patient_id: "patient-A", usage_minutes: 60, ahi: null, leak_rate_l_min: null },
        { patient_id: "patient-B", usage_minutes: 300, ahi: null, leak_rate_l_min: null },
        { patient_id: "patient-B", usage_minutes: 300, ahi: null, leak_rate_l_min: null },
        { patient_id: "patient-B", usage_minutes: 300, ahi: null, leak_rate_l_min: null },
        { patient_id: "patient-B", usage_minutes: 60, ahi: null, leak_rate_l_min: null },
      ],
      error: null,
    });

    const res = await request(makeApp()).get(
      "/admin/reports/therapy-usage?groupBy=patient&days=30",
    );

    expect(res.status).toBe(200);
    expect(res.body.summary.patientCount).toBe(2);
    expect(res.body.summary.cmsCompliantPatients).toBe(1);
  });
});
