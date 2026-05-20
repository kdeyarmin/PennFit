// Route tests for routes/storefront/me-claims.ts
//
// PR change:
//   GET /me/billing-balance previously returned { totalOpenCents: 0, claimCount: 0 }
//   when no patient record was linked to the authenticated customer. It now returns
//   { totalOpenCents: 0, claimCount: 0, claims: [] } to keep the response shape
//   consistent with the linked-patient path that does return a `claims` array.
//
// Coverage matrix:
//   GET /me/billing-balance — unauthenticated (401), no patient link (returns claims:[]),
//                             linked patient (aggregates balances + returns claim list).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// Silence the logger so test output is clean.
vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import meClaimsRouter from "./me-claims";

const CUSTOMER_ID = "cust-alice-001";
const PATIENT_ID = "aaaaaaaa-0000-0000-0000-000000000001";

function makeApp(customerId: string | null = CUSTOMER_ID): Express {
  const app = express();
  app.use(express.json());
  // Inject shopCustomerId directly, mirroring how requireSignedIn middleware
  // would attach it in production.
  app.use((req, _res, next) => {
    if (customerId !== null) {
      (req as unknown as Record<string, unknown>).shopCustomerId = customerId;
    }
    next();
  });
  app.use("/resupply-api", meClaimsRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
});

// ===========================================================================
// GET /me/billing-balance — authentication guard
// ===========================================================================
describe("GET /me/billing-balance — authentication", () => {
  it("returns 401 when no shopCustomerId is attached", async () => {
    const res = await request(makeApp(null)).get(
      "/resupply-api/me/billing-balance",
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("sign_in_required");
  });
});

// ===========================================================================
// GET /me/billing-balance — no patient link (PR change)
// ===========================================================================
describe("GET /me/billing-balance — no linked patient (PR change)", () => {
  it("returns 200 with { totalOpenCents: 0, claimCount: 0, claims: [] } when no shop_customer row exists", async () => {
    // resolvePatientForCustomer: shop_customers lookup returns null.
    stageSupabaseResponse("shop_customers", "select", { data: null });

    const res = await request(makeApp()).get(
      "/resupply-api/me/billing-balance",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalOpenCents: 0,
      claimCount: 0,
      claims: [],
    });
  });

  it("includes the claims array (not just totalOpenCents + claimCount) — schema consistency", async () => {
    stageSupabaseResponse("shop_customers", "select", { data: null });

    const res = await request(makeApp()).get(
      "/resupply-api/me/billing-balance",
    );

    expect(res.status).toBe(200);
    // The PR change: `claims` key must be present.
    expect(res.body).toHaveProperty("claims");
    expect(Array.isArray(res.body.claims)).toBe(true);
  });

  it("returns an empty claims array (not undefined, not null)", async () => {
    stageSupabaseResponse("shop_customers", "select", { data: null });

    const res = await request(makeApp()).get(
      "/resupply-api/me/billing-balance",
    );

    expect(res.body.claims).toEqual([]);
  });

  it("returns 200 with zero-balance + claims:[] when customer exists but patient lookup returns null", async () => {
    // shop_customers found, but no matching patient.
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: CUSTOMER_ID, email_lower: "alice@example.com" },
    });
    stageSupabaseResponse("patients", "select", { data: null });

    const res = await request(makeApp()).get(
      "/resupply-api/me/billing-balance",
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalOpenCents: 0,
      claimCount: 0,
      claims: [],
    });
  });

  it("regression: totalOpenCents is 0 (not undefined) in the no-link path", async () => {
    stageSupabaseResponse("shop_customers", "select", { data: null });

    const res = await request(makeApp()).get(
      "/resupply-api/me/billing-balance",
    );

    expect(typeof res.body.totalOpenCents).toBe("number");
    expect(res.body.totalOpenCents).toBe(0);
  });

  it("regression: claimCount is 0 (not undefined) in the no-link path", async () => {
    stageSupabaseResponse("shop_customers", "select", { data: null });

    const res = await request(makeApp()).get(
      "/resupply-api/me/billing-balance",
    );

    expect(typeof res.body.claimCount).toBe("number");
    expect(res.body.claimCount).toBe(0);
  });
});

// ===========================================================================
// GET /me/billing-balance — linked patient with open claims
// ===========================================================================
describe("GET /me/billing-balance — linked patient with open claims", () => {
  function stubLinkedPatient() {
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: CUSTOMER_ID, email_lower: "alice@example.com" },
    });
    stageSupabaseResponse("patients", "select", {
      data: { id: PATIENT_ID },
    });
  }

  it("returns the aggregated totalOpenCents for the patient's open claims", async () => {
    stubLinkedPatient();
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          id: "claim-1",
          payer_name: "Aetna",
          date_of_service: "2026-01-15",
          patient_responsibility_cents: 3000,
        },
        {
          id: "claim-2",
          payer_name: "BCBS",
          date_of_service: "2026-02-10",
          patient_responsibility_cents: 1500,
        },
      ],
    });

    const res = await request(makeApp()).get(
      "/resupply-api/me/billing-balance",
    );

    expect(res.status).toBe(200);
    expect(res.body.totalOpenCents).toBe(4500);
    expect(res.body.claimCount).toBe(2);
  });

  it("returns the claims array with the expected shape", async () => {
    stubLinkedPatient();
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          id: "claim-1",
          payer_name: "Aetna",
          date_of_service: "2026-01-15",
          patient_responsibility_cents: 3000,
        },
      ],
    });

    const res = await request(makeApp()).get(
      "/resupply-api/me/billing-balance",
    );

    expect(res.status).toBe(200);
    expect(res.body.claims).toHaveLength(1);
    expect(res.body.claims[0]).toMatchObject({
      id: "claim-1",
      payerName: "Aetna",
      dateOfService: "2026-01-15",
      patientResponsibilityCents: 3000,
    });
  });

  it("returns an empty claims array and zero totals when no open claims exist", async () => {
    stubLinkedPatient();
    stageSupabaseResponse("insurance_claims", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/resupply-api/me/billing-balance",
    );

    expect(res.status).toBe(200);
    expect(res.body.totalOpenCents).toBe(0);
    expect(res.body.claimCount).toBe(0);
    expect(res.body.claims).toEqual([]);
  });
});