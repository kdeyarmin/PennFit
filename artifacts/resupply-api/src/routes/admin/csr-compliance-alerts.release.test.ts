// Route test for the address-change release valve on
// PATCH /admin/csr-compliance-alerts/:id.
//
// Why this test exists
// --------------------
// When a patient asks to change their shipping address we hold every
// not-yet-shipped fulfillment so nothing reaches the old address. A hold
// with no release is worse than the bug it fixes — the order would sit
// forever — so resolving the `address_change_pending` alert is the
// release valve, and this pins that wiring.
//
// The hold/release helpers themselves are unit-tested in
// `lib/messaging/order-flow.test.ts`; what is covered here is that the
// route calls the release for the right alert type and only on resolve.

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

vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

const releaseMock = vi.fn().mockResolvedValue(2);
vi.mock("../../lib/messaging/order-flow", () => ({
  releaseAddressChangeHold: (...a: unknown[]) => releaseMock(...a),
}));

import alertsRouter from "./csr-compliance-alerts";

const SUPERVISOR: MockAdminCtx = {
  userId: "u_super",
  email: "sup@penn.example.com",
  role: "agent",
  granularRole: "supervisor",
};

const ALERT_ID = "00000000-0000-4000-8000-0000000000a1";
const PATIENT_ID = "00000000-0000-4000-8000-000000000011";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", alertsRouter);
  return app;
}

function stageAlert(alertType: string): void {
  stageSupabaseResponse("csr_compliance_alerts", "select", {
    data: {
      id: ALERT_ID,
      patient_id: PATIENT_ID,
      status: "open",
      alert_type: alertType,
    },
    error: null,
  });
  stageSupabaseResponse("csr_compliance_alerts", "update", {
    data: null,
    error: null,
  });
}

describe("PATCH /admin/csr-compliance-alerts/:id — address-change release", () => {
  beforeEach(() => {
    supabaseMock.reset();
    releaseMock.mockClear().mockResolvedValue(2);
    mockAdmin.current = SUPERVISOR;
  });

  it("releases held fulfillments when an address-change alert is resolved", async () => {
    stageAlert("address_change_pending");

    const res = await request(makeApp())
      .patch(`/resupply-api/admin/csr-compliance-alerts/${ALERT_ID}`)
      .send({ action: "resolve" });

    expect(res.status).toBe(200);
    expect(releaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: PATIENT_ID }),
    );
    expect(res.body.releasedFulfillments).toBe(2);
  });

  it("does not release for other alert types", async () => {
    stageAlert("resupply_too_soon");

    const res = await request(makeApp())
      .patch(`/resupply-api/admin/csr-compliance-alerts/${ALERT_ID}`)
      .send({ action: "resolve" });

    expect(res.status).toBe(200);
    expect(releaseMock).not.toHaveBeenCalled();
    expect(res.body.releasedFulfillments).toBeUndefined();
  });

  it("does not release on snooze — the address is still unconfirmed", async () => {
    stageAlert("address_change_pending");

    const res = await request(makeApp())
      .patch(`/resupply-api/admin/csr-compliance-alerts/${ALERT_ID}`)
      .send({
        action: "snooze",
        snoozeUntil: "2030-01-01T00:00:00.000Z",
      });

    expect(res.status).toBe(200);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("still resolves the alert when the release fails", async () => {
    // The alert is already updated by the time we release; a release
    // failure must not turn a successful resolve into a 500.
    stageAlert("address_change_pending");
    releaseMock.mockResolvedValue(0);

    const res = await request(makeApp())
      .patch(`/resupply-api/admin/csr-compliance-alerts/${ALERT_ID}`)
      .send({ action: "resolve" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resolved");
    expect(res.body.releasedFulfillments).toBe(0);
  });
});
