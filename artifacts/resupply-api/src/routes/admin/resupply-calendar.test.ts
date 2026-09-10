import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  makeRequireAdminMock,
  MOCK_ORG_ID,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse as stage,
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";
const db = installSupabaseMock();
const { admin, entitlement, authoritative } = vi.hoisted(() => ({
  admin: { current: null as MockAdminCtx | null },
  entitlement: vi.fn(),
  authoritative: vi.fn(),
}));
vi.mock("../../lib/feature-flags", () => ({ isFeatureEnabled: authoritative }));
vi.mock("../../middlewares/requireAdmin", () => makeRequireAdminMock(admin));
vi.mock("../../lib/entitlement/patient-supply-summary", () => ({
  loadPatientSupplySummary: entitlement,
}));
import router from "./resupply-calendar";
const P = "11111111-1111-4111-8111-111111111111";
const RX = "22222222-2222-4222-8222-222222222222";
const E = "33333333-3333-4333-8333-333333333333";
const URL =
  "/admin/resupply-calendar?from=2026-09-01T04:00:00.000Z&to=2026-10-01T04:00:00.000Z";
const app = () => express().use(router);
beforeEach(() => {
  db.reset();
  admin.current = { userId: "csr", email: "csr@example.test", role: "agent" };
  entitlement
    .mockReset()
    .mockResolvedValue({
      entitlements: new Map(),
      lastOrderedAt: new Map(),
      lastSuppliedAt: new Map(),
    });
  authoritative.mockReset().mockResolvedValue(true);
});
describe("resupply calendar", () => {
  it("filters legacy dates after applying overrides and shipment baselines", async () => {
    authoritative.mockResolvedValue(false);
    const p2 = "55555555-5555-4555-8555-555555555555";
    stage("episodes", "select", {
      data: [
        {
          id: E,
          patient_id: P,
          prescription_id: RX,
          due_at: "2026-12-01T12:00:00Z",
        },
        {
          id: "e2",
          patient_id: p2,
          prescription_id: "r2",
          due_at: "2026-09-02T12:00:00Z",
        },
      ],
    });
    stage("patients", "select", {
      data: [
        {
          id: P,
          legal_first_name: "Jane",
          legal_last_name: "Example",
          status: "active",
          cadence_override_days: 15,
          created_at: "2025-01-01T00:00:00Z",
        },
        { id: p2, status: "active", created_at: "2025-01-01T00:00:00Z" },
      ],
    });
    stage("prescriptions", "select", {
      data: [
        {
          id: RX,
          patient_id: P,
          item_sku: "MASK",
          status: "active",
          cadence_days: 90,
          created_at: "2026-08-01T12:00:00Z",
        },
        {
          id: "r2",
          patient_id: p2,
          item_sku: "MASK",
          status: "active",
          cadence_days: 90,
          created_at: "2026-09-01T12:00:00Z",
        },
      ],
    });
    stage("fulfillments", "select", {
      data: [
        {
          id: "f1",
          patient_id: P,
          item_sku: "MASK",
          created_at: "2026-08-30T12:00:00Z",
          shipped_at: "2026-09-01T12:00:00Z",
        },
      ],
    });
    const result = await request(app()).get(URL);
    expect(result.status).toBe(200);
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]).toMatchObject({
      id: E,
      cadenceDays: 15,
      dueAt: "2026-09-16T12:00:00.000Z",
    });
    expect(getSupabaseFilterCalls("episodes", "select")).not.toContainEqual({
      verb: "gte",
      args: ["due_at", "2026-09-01T04:00:00.000Z"],
    });
  });
  it("requires authentication and tenant context", async () => {
    admin.current = null;
    expect((await request(app()).get(URL)).status).toBe(401);
    admin.current = {
      userId: "csr",
      email: "csr@example.test",
      role: "agent",
      orgId: null,
    };
    expect((await request(app()).get(URL)).status).toBe(500);
  });
  it("rejects invalid or unbounded date windows", async () => {
    expect(
      (await request(app()).get("/admin/resupply-calendar?from=bad&to=bad"))
        .status,
    ).toBe(400);
    expect(
      (await request(app()).get(URL.replace("2026-10-01", "2027-10-01")))
        .status,
    ).toBe(400);
  });
  it("reads beyond the first page, scopes child reads, and exposes reachability without addresses", async () => {
    stage("episodes", "select", {
      data: Array.from({ length: 200 }, (_, i) => ({
        id: `e-${i}`,
        patient_id: P,
        prescription_id: RX,
        due_at: "2026-09-10T12:00:00Z",
        status: "outreach_pending",
      })),
    });
    stage("episodes", "select", {
      data: [
        {
          id: E,
          patient_id: P,
          prescription_id: RX,
          due_at: "2026-09-30T12:00:00Z",
          status: "awaiting_response",
        },
      ],
    });
    for (let i = 0; i < 2; i++) {
      stage("patients", "select", {
        data: [
          {
            id: P,
            status: "active",
            legal_first_name: "Jane",
            legal_last_name: "Example",
            phone_e164: "+15555550100",
            email: "private@example.test",
          },
        ],
      });
      stage("prescriptions", "select", {
        data: [
          {
            id: RX,
            patient_id: P,
            item_sku: "CUSHION",
            status: "active",
            cadence_days: 30,
          },
        ],
      });
    }
    const result = await request(app()).get(URL);
    expect(result.status).toBe(200);
    expect(result.body.items).toHaveLength(201);
    expect(result.body.items[200]).toMatchObject({
      id: E,
      patientName: "Jane Example",
      hasPhone: true,
      hasEmail: true,
    });
    expect(JSON.stringify(result.body)).not.toContain("private@example.test");
    expect(getSupabaseFilterCalls("episodes", "select")).toContainEqual({
      verb: "range",
      args: [200, 399],
    });
    for (const table of ["episodes", "patients", "prescriptions"])
      expect(getSupabaseFilterCalls(table, "select")).toContainEqual({
        verb: "eq",
        args: ["org_id", MOCK_ORG_ID],
      });
  });
  it("excludes inactive patients and prescriptions", async () => {
    stage("episodes", "select", {
      data: [{ id: E, patient_id: P, prescription_id: RX }],
    });
    stage("patients", "select", { data: [{ id: P, status: "paused" }] });
    stage("prescriptions", "select", {
      data: [{ id: RX, patient_id: P, status: "active" }],
    });
    expect((await request(app()).get(URL)).body.items).toEqual([]);
  });
  it("checks patient ownership before resolving order eligibility", async () => {
    expect(
      (await request(app()).get(`/admin/patients/${P}/supply-overview`)).status,
    ).toBe(404);
    expect(entitlement).not.toHaveBeenCalled();
  });
  it("returns historical order pages and unknown eligibility without inventing a due date", async () => {
    stage("patients", "select", { data: { id: P } });
    stage("prescriptions", "select", {
      data: [{ id: RX, item_sku: "CUSTOM", cadence_days: 30 }],
    });
    stage("episodes", "select", { data: [] });
    stage("fulfillments", "select", {
      data: [
        {
          id: E,
          item_sku: "CUSTOM",
          quantity: 2,
          status: "shipped",
          created_at: "2026-08-01T12:00:00Z",
          shipped_at: "2026-08-03T12:00:00Z",
        },
      ],
      count: 26,
    });
    stage("products", "select", {
      data: [{ sku: "CUSTOM", name: "Custom mask" }],
    });
    const result = await request(app()).get(
      `/admin/patients/${P}/supply-overview?offset=25`,
    );
    expect(result.status).toBe(200);
    expect(result.body.supplies[0]).toMatchObject({
      itemName: "Custom mask",
      eligibility: null,
      scheduledDueAt: null,
    });
    expect(result.body.orders[0]).toMatchObject({
      itemName: "Custom mask",
      quantity: 2,
      orderedAt: "2026-08-01T12:00:00Z",
    });
    expect(result.body.totalOrders).toBe(26);
    expect(getSupabaseFilterCalls("fulfillments", "select")).toContainEqual({
      verb: "range",
      args: [25, 49],
    });
  });
});
