// Route tests for /shop/me/caregiver.
//
// Coverage:
//   * 401 without sign-in (all verbs)
//   * GET returns null when no caregiver on file
//   * GET returns the view shape when consent_at is set
//   * PUT rejects when caregiver email equals customer's own email
//   * PUT validates body shape
//   * PUT first-set stamps consent_at and audits caregiver.add
//   * PUT email-change refreshes consent_at and audits caregiver.update
//   * PUT same-email no-revoke keeps existing consent_at
//   * DELETE stamps revoked_at and audits; idempotent when nothing active
//   * Audit metadata never contains caregiver name/email PHI

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

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

import caregiverRouter from "./me-caregiver";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(caregiverRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  logAuditMock.mockClear();
  supabaseMock.reset();
});

describe("GET /shop/me/caregiver", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/caregiver");
    expect(res.status).toBe(401);
  });

  it("returns null when no caregiver on file", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        caregiver_name: null,
        caregiver_email: null,
        caregiver_consent_at: null,
        caregiver_revoked_at: null,
      },
    });
    const res = await request(makeApp()).get("/shop/me/caregiver");
    expect(res.status).toBe(200);
    expect(res.body.caregiver).toBeNull();
  });

  it("returns the view shape when consent_at is set", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        caregiver_name: "Pat Caregiver",
        caregiver_email: "pat@care.test",
        caregiver_consent_at: "2026-01-01T00:00:00.000Z",
        caregiver_revoked_at: null,
      },
    });
    const res = await request(makeApp()).get("/shop/me/caregiver");
    expect(res.status).toBe(200);
    expect(res.body.caregiver).toEqual({
      name: "Pat Caregiver",
      email: "pat@care.test",
      consentAt: "2026-01-01T00:00:00.000Z",
      revokedAt: null,
    });
  });
});

describe("PUT /shop/me/caregiver", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp())
      .put("/shop/me/caregiver")
      .send({ name: "X", email: "x@y.test" });
    expect(res.status).toBe(401);
  });

  it("400s with invalid body", async () => {
    mockSignedIn.current = "cust_1";
    const res = await request(makeApp())
      .put("/shop/me/caregiver")
      .send({ name: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("rejects when caregiver email equals customer's own email", async () => {
    mockSignedIn.current = {
      customerId: "cust_1",
      email: "alice@me.test",
    };
    const res = await request(makeApp())
      .put("/shop/me/caregiver")
      .send({ name: "Alice", email: "ALICE@me.test" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("caregiver_is_self");
  });

  it("first-set stamps consent_at and audits caregiver.add", async () => {
    mockSignedIn.current = {
      customerId: "cust_1",
      email: "alice@me.test",
    };
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        caregiver_name: null,
        caregiver_email: null,
        caregiver_consent_at: null,
        caregiver_revoked_at: null,
      },
    });
    stageSupabaseResponse("shop_customers", "update", { data: null });

    const res = await request(makeApp()).put("/shop/me/caregiver").send({
      name: "Pat",
      email: "pat@care.test",
    });
    expect(res.status).toBe(200);
    expect(res.body.caregiver.name).toBe("Pat");
    expect(res.body.caregiver.email).toBe("pat@care.test");
    expect(res.body.caregiver.consentAt).toBeTruthy();
    expect(res.body.caregiver.revokedAt).toBeNull();

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      adminEmail: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("shop_customer.caregiver.add");
    expect(audit.adminEmail).toBe("customer:alice@me.test");
    expect(audit.metadata.consent_refreshed).toBe(true);
    // CRITICAL: caregiver name + email must NOT appear in audit metadata
    expect(JSON.stringify(audit.metadata)).not.toContain("Pat");
    expect(JSON.stringify(audit.metadata)).not.toContain("pat@care.test");
  });

  it("email-change refreshes consent and audits as update", async () => {
    mockSignedIn.current = {
      customerId: "cust_1",
      email: "alice@me.test",
    };
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        caregiver_name: "Old Person",
        caregiver_email: "old@care.test",
        caregiver_consent_at: "2025-01-01T00:00:00.000Z",
        caregiver_revoked_at: null,
      },
    });
    stageSupabaseResponse("shop_customers", "update", { data: null });

    const res = await request(makeApp())
      .put("/shop/me/caregiver")
      .send({ name: "New Person", email: "new@care.test" });
    expect(res.status).toBe(200);
    // Consent refreshed → must NOT equal the prior consent_at
    expect(res.body.caregiver.consentAt).not.toBe("2025-01-01T00:00:00.000Z");

    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: { consent_refreshed: boolean };
    };
    expect(audit.action).toBe("shop_customer.caregiver.update");
    expect(audit.metadata.consent_refreshed).toBe(true);
  });

  it("preserves consent_at when same email is re-saved", async () => {
    mockSignedIn.current = {
      customerId: "cust_1",
      email: "alice@me.test",
    };
    const priorConsentAt = "2025-01-01T00:00:00.000Z";
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        caregiver_name: "Pat",
        caregiver_email: "pat@care.test",
        caregiver_consent_at: priorConsentAt,
        caregiver_revoked_at: null,
      },
    });
    stageSupabaseResponse("shop_customers", "update", { data: null });

    const res = await request(makeApp())
      .put("/shop/me/caregiver")
      .send({ name: "Pat Updated", email: "pat@care.test" });
    expect(res.status).toBe(200);
    expect(res.body.caregiver.consentAt).toBe(priorConsentAt);
  });
});

describe("DELETE /shop/me/caregiver", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).delete("/shop/me/caregiver");
    expect(res.status).toBe(401);
  });

  it("stamps revoked_at and audits when an active caregiver exists", async () => {
    mockSignedIn.current = {
      customerId: "cust_1",
      email: "alice@me.test",
    };
    stageSupabaseResponse("shop_customers", "update", {
      data: { customer_id: "cust_1" },
    });

    const res = await request(makeApp()).delete("/shop/me/caregiver");
    expect(res.status).toBe(200);
    expect(res.body.caregiver).toBeNull();
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0]?.[0]).toMatchObject({
      action: "shop_customer.caregiver.revoke",
    });
  });

  it("is idempotent when no active caregiver exists (no audit)", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_customers", "update", { data: null });

    const res = await request(makeApp()).delete("/shop/me/caregiver");
    expect(res.status).toBe(200);
    expect(res.body.caregiver).toBeNull();
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});
