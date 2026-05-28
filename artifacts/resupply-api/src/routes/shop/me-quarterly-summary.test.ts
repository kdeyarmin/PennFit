// Route tests for GET /shop/me/quarterly-summary.
//
// Coverage:
//   * 401 without sign-in
//   * 403 when no email present (patient_not_linked)
//   * 403 when patient lookup misses
//   * Returns text/html by default
//   * Returns JSON shape when format=json query param is set
//   * Calls the build helper with a 90-day window

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInProfile,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: {
    current: null as null | string | MockSignedInProfile,
  },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

const buildQuarterlySummaryMock = vi.hoisted(() =>
  vi.fn(() => ({
    html: "<html><body>Q Summary</body></html>",
    fields: {
      patientName: "Test Patient",
      nightsRecorded: 0,
      avgUsageHours: null,
      avgAhi: null,
      avgLeakLMin: null,
      compliantNights: null,
      complianceRate: null,
    },
  })),
);
vi.mock("../../lib/therapy-summary/build-quarterly-html", () => ({
  buildQuarterlySummary: buildQuarterlySummaryMock,
}));

import qsRouter from "./me-quarterly-summary";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(qsRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  buildQuarterlySummaryMock.mockClear();
  supabaseMock.reset();
});

describe("GET /shop/me/quarterly-summary", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/quarterly-summary");
    expect(res.status).toBe(401);
  });

  it("403s when no email present", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp()).get("/shop/me/quarterly-summary");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("patient_not_linked");
  });

  it("403s when patient lookup misses", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp()).get("/shop/me/quarterly-summary");
    expect(res.status).toBe(403);
  });

  it("returns text/html by default", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: "p_1",
          legal_first_name: "Alice",
          legal_last_name: "Patient",
          date_of_birth: "1970-01-01",
        },
      ],
    });
    stageSupabaseResponse("patient_therapy_nights", "select", { data: [] });

    const res = await request(makeApp()).get("/shop/me/quarterly-summary");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("Q Summary");
    expect(buildQuarterlySummaryMock).toHaveBeenCalledTimes(1);
    const args = buildQuarterlySummaryMock.mock.calls[0]?.[0] as {
      patient: { id: string };
      windowStart: string;
      windowEnd: string;
    };
    expect(args.patient.id).toBe("p_1");
    expect(args.windowStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(args.windowEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const start = new Date(`${args.windowStart}T00:00:00.000Z`);
    const end = new Date(`${args.windowEnd}T00:00:00.000Z`);
    const spanDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    expect([89, 90]).toContain(spanDays); // inclusive/exclusive boundary tolerance
  });

  it("returns JSON fields when ?format=json", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: "p_1",
          legal_first_name: "Alice",
          legal_last_name: "Patient",
          date_of_birth: "1970-01-01",
        },
      ],
    });
    stageSupabaseResponse("patient_therapy_nights", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/shop/me/quarterly-summary?format=json",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.fields.patientName).toBe("Test Patient");
  });
});
