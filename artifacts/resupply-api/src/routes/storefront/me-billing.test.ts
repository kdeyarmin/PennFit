// Route tests for the patient-portal billing surface.
//
// Coverage:
//   * GET /me/billing-statements is 401 without a shopCustomerId
//   * GET /me/billing-statements resolves the customer → patient
//     join, returns the shaped row list (NOT the raw snake_case
//     columns), and quietly returns an empty list when there's no
//     linked patient row
//   * GET /me/billing-statements/:id/pdf returns 404 when the
//     statement belongs to a different patient
//
// These are the patient-facing surfaces added in phase 3a; they
// must be PHI-safe (only the logged-in patient sees their own).

import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import meBillingRouter from "./me-billing";

const CUSTOMER_ID = "cust_abc123";
const PATIENT = "11111111-aaaa-4111-8111-aaaaaaaaaaaa";
const STATEMENT = "22222222-aaaa-4222-8222-aaaaaaaaaaaa";

/**
 * Tiny middleware that injects a shopCustomerId before the router
 * runs. The real one is the storefront's session middleware in
 * app.ts; we don't need its plumbing to test the route bodies.
 */
function makeApp(opts: { shopCustomerId?: string } = {}): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.shopCustomerId) {
      (req as unknown as { shopCustomerId?: string }).shopCustomerId =
        opts.shopCustomerId;
    }
    next();
  });
  app.use("/api", meBillingRouter);
  return app;
}

describe("/api/me/billing-statements", () => {
  beforeEach(() => {
    supabaseMock.reset();
  });

  it("401s without a shopCustomerId on the request", async () => {
    const res = await request(makeApp()).get("/api/me/billing-statements");
    expect(res.status).toBe(401);
  });

  it("returns an empty list when the customer has no linked patient row", async () => {
    // shop_customers row exists but the patient join misses (no
    // matching email_lower in patients).
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: CUSTOMER_ID, email_lower: "jo@example.com" },
    });
    stageSupabaseResponse("patients", "select", { data: null });

    const res = await request(
      makeApp({ shopCustomerId: CUSTOMER_ID }),
    ).get("/api/me/billing-statements");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ statements: [] });
  });

  it("shapes statement rows into camelCase and counts line items", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: CUSTOMER_ID, email_lower: "jo@example.com" },
    });
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT } });
    stageSupabaseResponse("patient_billing_statements", "select", {
      data: [
        {
          id: STATEMENT,
          total_patient_responsibility_cents: 12345,
          delivery_method: "email",
          delivered_at: "2026-05-15T10:00:00.000Z",
          created_at: "2026-05-15T09:55:00.000Z",
          line_items_json: [
            { claim_id: "c1" },
            { claim_id: "c2" },
            { claim_id: "c3" },
          ],
        },
      ],
    });

    const res = await request(
      makeApp({ shopCustomerId: CUSTOMER_ID }),
    ).get("/api/me/billing-statements");

    expect(res.status).toBe(200);
    expect(res.body.statements).toHaveLength(1);
    expect(res.body.statements[0]).toEqual({
      id: STATEMENT,
      totalPatientResponsibilityCents: 12345,
      lineItemCount: 3,
      deliveryMethod: "email",
      deliveredAt: "2026-05-15T10:00:00.000Z",
      createdAt: "2026-05-15T09:55:00.000Z",
    });
    // Crucially, the raw snake_case columns aren't passed through.
    expect(res.body.statements[0]).not.toHaveProperty("line_items_json");
    expect(res.body.statements[0]).not.toHaveProperty(
      "total_patient_responsibility_cents",
    );
  });
});

describe("/api/me/billing-statements/:id/pdf", () => {
  beforeEach(() => {
    supabaseMock.reset();
  });

  it("404s when the statement isn't owned by the requesting patient", async () => {
    // Customer + patient resolve fine, but the statement lookup
    // (scoped by patient_id) returns null — the row exists for a
    // different patient or doesn't exist at all.
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: CUSTOMER_ID, email_lower: "jo@example.com" },
    });
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT } });
    stageSupabaseResponse("patient_billing_statements", "select", {
      data: null,
    });

    const res = await request(
      makeApp({ shopCustomerId: CUSTOMER_ID }),
    ).get(`/api/me/billing-statements/${STATEMENT}/pdf`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("404s on an invalid UUID in the path (rejects without leaking shape)", async () => {
    const res = await request(
      makeApp({ shopCustomerId: CUSTOMER_ID }),
    ).get("/api/me/billing-statements/not-a-uuid/pdf");
    expect(res.status).toBe(404);
  });
});
