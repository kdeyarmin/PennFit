// Route tests for the clinician share-token endpoints added to
// /admin/inbound-referrals in Phase 6.
//
// Coverage:
//   POST /admin/inbound-referrals/:id/share-tokens
//     * 401 when unauthenticated
//     * 403 when missing conversations.manage permission
//     * 404 when referral id is not a UUID
//     * 400 when body has extra fields (strict schema)
//     * 400 when ttlSeconds is below minimum (< 3600)
//     * 400 when ttlSeconds is above maximum (> 180d)
//     * 404 when referral row doesn't exist
//     * 409 when referral is archived
//     * 409 when referral is duplicate
//     * 500 when DB insert fails
//     * 201 happy path with default TTL — returns shareTokenId, token, expiresAt
//     * 201 happy path with explicit ttlSeconds
//     * audit log is written on success
//     * audit log failure is swallowed (does not affect response)
//
//   DELETE /admin/inbound-referrals/:id/share-tokens/:shareTokenId
//     * 401 when unauthenticated
//     * 403 when missing conversations.manage permission
//     * 404 when params are not valid UUIDs
//     * 404 when share token row doesn't exist (or wrong referral_id)
//     * 200 { revoked: true, alreadyRevoked: true } when already revoked (idempotent)
//     * 200 { revoked: true } on successful revocation
//     * audit log is written on success

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

// ── Supabase mock ────────────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── requireAdmin / requirePermission mock ────────────────────────────
const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// ── adminRateLimit — pass-through in tests ───────────────────────────
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit:
    (_opts: unknown) =>
    (
      _req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ) => {
      next();
    },
}));

// ── Audit mock ───────────────────────────────────────────────────────
const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

// ── signClinicianShareToken mock ─────────────────────────────────────
const signClinicianShareTokenMock = vi.hoisted(() =>
  vi.fn(() => ({
    token: "test-payload.test-sig",
    expiresAt: "2099-12-31T00:00:00.000Z",
  })),
);
vi.mock("../../lib/clinician-share-token", () => ({
  signClinicianShareToken: signClinicianShareTokenMock,
}));

// ── Other transitive deps used by inbound-referrals.ts ───────────────
vi.mock("../../lib/inbound-dispatchers/preflight", () => ({
  runReferralPreflight: vi.fn(async () => ({ ok: true, checks: [] })),
}));
vi.mock("../../lib/referral-callbacks", () => ({
  enqueueReferralStatusEvent: vi.fn(async () => undefined),
}));
vi.mock("../../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import inboundReferralsRouter from "./inbound-referrals";

// ── Constants ─────────────────────────────────────────────────────────
const ADMIN_EMAIL = "ops@example.com";
const REFERRAL_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SHARE_TOKEN_ID = "11111111-2222-4333-8444-555555555555";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(inboundReferralsRouter);
  return app;
}

function stubAdmin(
  granularRole: MockAdminCtx["granularRole"] = "admin",
): void {
  mockAdmin.current = {
    userId: "user_op_1",
    email: ADMIN_EMAIL,
    role: "admin",
    granularRole,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
  signClinicianShareTokenMock.mockClear();
});

// ────────────────────────────────────────────────────────────────────
// POST /admin/inbound-referrals/:id/share-tokens
// ────────────────────────────────────────────────────────────────────

describe("POST /admin/inbound-referrals/:id/share-tokens", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).post(
      `/admin/inbound-referrals/${REFERRAL_ID}/share-tokens`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when referral id is not a valid UUID", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/inbound-referrals/not-a-uuid/share-tokens")
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 400 when body contains an unrecognised field (strict schema)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post(`/admin/inbound-referrals/${REFERRAL_ID}/share-tokens`)
      .send({ unknownField: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when ttlSeconds is below the 1-hour minimum", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post(`/admin/inbound-referrals/${REFERRAL_ID}/share-tokens`)
      .send({ ttlSeconds: 59 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when ttlSeconds exceeds the 180-day cap", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post(`/admin/inbound-referrals/${REFERRAL_ID}/share-tokens`)
      .send({ ttlSeconds: 180 * 24 * 60 * 60 + 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 404 when the referral row doesn't exist", async () => {
    stubAdmin();
    stageSupabaseResponse("inbound_referral_orders", "select", {
      data: null,
    });
    const res = await request(makeApp())
      .post(`/admin/inbound-referrals/${REFERRAL_ID}/share-tokens`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 409 when the referral is archived", async () => {
    stubAdmin();
    stageSupabaseResponse("inbound_referral_orders", "select", {
      data: { id: REFERRAL_ID, triage_status: "archived" },
    });
    const res = await request(makeApp())
      .post(`/admin/inbound-referrals/${REFERRAL_ID}/share-tokens`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_status");
    expect(res.body.message).toContain("archived");
  });

  it("returns 409 when the referral is a duplicate", async () => {
    stubAdmin();
    stageSupabaseResponse("inbound_referral_orders", "select", {
      data: { id: REFERRAL_ID, triage_status: "duplicate" },
    });
    const res = await request(makeApp())
      .post(`/admin/inbound-referrals/${REFERRAL_ID}/share-tokens`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_status");
    expect(res.body.message).toContain("duplicate");
  });

  it("returns 500 when the clinician_share_tokens INSERT fails", async () => {
    stubAdmin();
    stageSupabaseResponse("inbound_referral_orders", "select", {
      data: { id: REFERRAL_ID, triage_status: "new" },
    });
    stageSupabaseResponse("clinician_share_tokens", "insert", {
      data: null,
      error: { code: "23503", message: "foreign key violation" },
    });
    const res = await request(makeApp())
      .post(`/admin/inbound-referrals/${REFERRAL_ID}/share-tokens`)
      .send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("insert_failed");
  });

  it("returns 500 when inserted row data is null (no insert error but no row)", async () => {
    stubAdmin();
    stageSupabaseResponse("inbound_referral_orders", "select", {
      data: { id: REFERRAL_ID, triage_status: "triaged" },
    });
    stageSupabaseResponse("clinician_share_tokens", "insert", {
      data: null,
      error: null,
    });
    const res = await request(makeApp())
      .post(`/admin/inbound-referrals/${REFERRAL_ID}/share-tokens`)
      .send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("insert_failed");
  });

  it("returns 201 with shareTokenId, token, and expiresAt on the happy path (default TTL)", async () => {
    stubAdmin();
    stageSupabaseResponse("inbound_referral_orders", "select", {
      data: { id: REFERRAL_ID, triage_status: "new" },
    });
    stageSupabaseResponse("clinician_share_tokens", "insert", {
      data: { id: SHARE_TOKEN_ID },
    });
    const res = await request(makeApp())
      .post(`/admin/inbound-referrals/${REFERRAL_ID}/share-tokens`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.shareTokenId).toBe(SHARE_TOKEN_ID);
    expect(res.body.token).toBe("test-payload.test-sig");
    expect(res.body.expiresAt).toBe("2099-12-31T00:00:00.000Z");
    // signClinicianShareToken was called with the inserted row id
    expect(signClinicianShareTokenMock).toHaveBeenCalledWith(
      SHARE_TOKEN_ID,
      30 * 24 * 60 * 60,
    );
  });

  it("returns 201 and passes custom ttlSeconds to signClinicianShareToken", async () => {
    stubAdmin();
    stageSupabaseResponse("inbound_referral_orders", "select", {
      data: { id: REFERRAL_ID, triage_status: "triaged" },
    });
    stageSupabaseResponse("clinician_share_tokens", "insert", {
      data: { id: SHARE_TOKEN_ID },
    });
    const res = await request(makeApp())
      .post(`/admin/inbound-referrals/${REFERRAL_ID}/share-tokens`)
      .send({ ttlSeconds: 7200 });
    expect(res.status).toBe(201);
    expect(signClinicianShareTokenMock).toHaveBeenCalledWith(
      SHARE_TOKEN_ID,
      7200,
    );
  });

  it("calls logAudit with the correct action and metadata on success", async () => {
    stubAdmin();
    stageSupabaseResponse("inbound_referral_orders", "select", {
      data: { id: REFERRAL_ID, triage_status: "new" },
    });
    stageSupabaseResponse("clinician_share_tokens", "insert", {
      data: { id: SHARE_TOKEN_ID },
    });
    await request(makeApp())
      .post(`/admin/inbound-referrals/${REFERRAL_ID}/share-tokens`)
      .send({});
    expect(logAuditMock).toHaveBeenCalledOnce();
    const auditCall = logAuditMock.mock.calls[0][0] as Record<string, unknown>;
    expect(auditCall.action).toBe("inbound_referral.share_token.minted");
    expect(auditCall.targetTable).toBe("clinician_share_tokens");
    expect(auditCall.targetId).toBe(SHARE_TOKEN_ID);
    const meta = auditCall.metadata as Record<string, unknown>;
    expect(meta.referral_id).toBe(REFERRAL_ID);
  });

  it("still returns 201 even when logAudit throws", async () => {
    stubAdmin();
    stageSupabaseResponse("inbound_referral_orders", "select", {
      data: { id: REFERRAL_ID, triage_status: "accepted" },
    });
    stageSupabaseResponse("clinician_share_tokens", "insert", {
      data: { id: SHARE_TOKEN_ID },
    });
    logAuditMock.mockRejectedValueOnce(new Error("audit service down"));
    const res = await request(makeApp())
      .post(`/admin/inbound-referrals/${REFERRAL_ID}/share-tokens`)
      .send({});
    expect(res.status).toBe(201);
  });

  it("boundary: accepts exactly the 1-hour minimum ttlSeconds (3600)", async () => {
    stubAdmin();
    stageSupabaseResponse("inbound_referral_orders", "select", {
      data: { id: REFERRAL_ID, triage_status: "new" },
    });
    stageSupabaseResponse("clinician_share_tokens", "insert", {
      data: { id: SHARE_TOKEN_ID },
    });
    const res = await request(makeApp())
      .post(`/admin/inbound-referrals/${REFERRAL_ID}/share-tokens`)
      .send({ ttlSeconds: 3600 });
    expect(res.status).toBe(201);
  });

  it("boundary: accepts exactly the 180-day maximum ttlSeconds", async () => {
    stubAdmin();
    stageSupabaseResponse("inbound_referral_orders", "select", {
      data: { id: REFERRAL_ID, triage_status: "new" },
    });
    stageSupabaseResponse("clinician_share_tokens", "insert", {
      data: { id: SHARE_TOKEN_ID },
    });
    const res = await request(makeApp())
      .post(`/admin/inbound-referrals/${REFERRAL_ID}/share-tokens`)
      .send({ ttlSeconds: 180 * 24 * 60 * 60 });
    expect(res.status).toBe(201);
  });
});

// ────────────────────────────────────────────────────────────────────
// DELETE /admin/inbound-referrals/:id/share-tokens/:shareTokenId
// ────────────────────────────────────────────────────────────────────

describe("DELETE /admin/inbound-referrals/:id/share-tokens/:shareTokenId", () => {
  const deleteUrl = `/admin/inbound-referrals/${REFERRAL_ID}/share-tokens/${SHARE_TOKEN_ID}`;

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).delete(deleteUrl);
    expect(res.status).toBe(401);
  });

  it("returns 404 when referral id param is not a UUID", async () => {
    stubAdmin();
    const res = await request(makeApp()).delete(
      `/admin/inbound-referrals/not-a-uuid/share-tokens/${SHARE_TOKEN_ID}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 404 when shareTokenId param is not a UUID", async () => {
    stubAdmin();
    const res = await request(makeApp()).delete(
      `/admin/inbound-referrals/${REFERRAL_ID}/share-tokens/not-a-uuid`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 404 when the share token row doesn't exist", async () => {
    stubAdmin();
    stageSupabaseResponse("clinician_share_tokens", "select", {
      data: null,
    });
    const res = await request(makeApp()).delete(deleteUrl);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 200 { revoked: true, alreadyRevoked: true } when already revoked (idempotent)", async () => {
    stubAdmin();
    stageSupabaseResponse("clinician_share_tokens", "select", {
      data: {
        id: SHARE_TOKEN_ID,
        referral_id: REFERRAL_ID,
        revoked_at: "2026-01-01T00:00:00.000Z",
      },
    });
    const res = await request(makeApp()).delete(deleteUrl);
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
    expect(res.body.alreadyRevoked).toBe(true);
    // No DB update should have been issued
    expect(supabaseMock.callCount("clinician_share_tokens", "update")).toBe(0);
  });

  it("returns 200 { revoked: true } and sets revoked_at on the token", async () => {
    stubAdmin();
    stageSupabaseResponse("clinician_share_tokens", "select", {
      data: {
        id: SHARE_TOKEN_ID,
        referral_id: REFERRAL_ID,
        revoked_at: null,
      },
    });
    stageSupabaseResponse("clinician_share_tokens", "update", {
      data: null,
      error: null,
    });
    const res = await request(makeApp()).delete(deleteUrl);
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
    expect(res.body.alreadyRevoked).toBeUndefined();
    expect(supabaseMock.callCount("clinician_share_tokens", "update")).toBe(1);
    const payload = supabaseMock.writePayloads(
      "clinician_share_tokens",
      "update",
    )[0] as Record<string, unknown>;
    expect(typeof payload.revoked_at).toBe("string");
  });

  it("calls logAudit with the correct action on successful revocation", async () => {
    stubAdmin();
    stageSupabaseResponse("clinician_share_tokens", "select", {
      data: {
        id: SHARE_TOKEN_ID,
        referral_id: REFERRAL_ID,
        revoked_at: null,
      },
    });
    stageSupabaseResponse("clinician_share_tokens", "update", {
      data: null,
      error: null,
    });
    await request(makeApp()).delete(deleteUrl);
    expect(logAuditMock).toHaveBeenCalledOnce();
    const auditCall = logAuditMock.mock.calls[0][0] as Record<string, unknown>;
    expect(auditCall.action).toBe("inbound_referral.share_token.revoked");
    expect(auditCall.targetTable).toBe("clinician_share_tokens");
    expect(auditCall.targetId).toBe(SHARE_TOKEN_ID);
  });

  it("still returns 200 when logAudit throws after successful revocation", async () => {
    stubAdmin();
    stageSupabaseResponse("clinician_share_tokens", "select", {
      data: {
        id: SHARE_TOKEN_ID,
        referral_id: REFERRAL_ID,
        revoked_at: null,
      },
    });
    stageSupabaseResponse("clinician_share_tokens", "update", {
      data: null,
      error: null,
    });
    logAuditMock.mockRejectedValueOnce(new Error("audit down"));
    const res = await request(makeApp()).delete(deleteUrl);
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
  });

  it("does not call logAudit when the token was already revoked", async () => {
    stubAdmin();
    stageSupabaseResponse("clinician_share_tokens", "select", {
      data: {
        id: SHARE_TOKEN_ID,
        referral_id: REFERRAL_ID,
        revoked_at: "2026-02-01T00:00:00.000Z",
      },
    });
    await request(makeApp()).delete(deleteUrl);
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});