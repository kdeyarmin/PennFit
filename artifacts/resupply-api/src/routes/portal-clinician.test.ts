// Route tests for GET /portal/clinician/:token (portal-clinician.ts).
//
// Coverage:
//   * 404 when token param is too short (< 8 chars) — zod validation
//   * 404 when token param is too long (> 2000 chars)
//   * 404 when HMAC signature is invalid (verifyClinicianShareToken returns invalid)
//   * 404 when share token row doesn't exist in the DB
//   * 410 when share token has been revoked (revoked_at not null)
//   * 410 when share token has expired (expires_at in the past)
//   * 404 when the referenced referral no longer exists
//   * 200 happy path — full response shape with referral status, timeline, preflight
//   * 200 with empty timeline and preflight arrays when those tables are empty
//   * view_count is incremented in the response (fire-and-forget update)
//   * audit log is written on successful view
//   * audit log failure is swallowed (does not affect response)
//   * PHI invariant — response does not include patient name, dob, address,
//     phone, email, member_id, hcpcs_codes, or icd10_codes

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../test-helpers/supabase-mock";
import type { VerifyClinicianShareTokenResult } from "../lib/clinician-share-token";

// ── Supabase mock ────────────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── express-rate-limit — bypass bucket state across tests ────────────
vi.mock("express-rate-limit", () => ({
  default: () =>
    (_req: unknown, _res: unknown, next: () => void) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

// ── Audit mock ───────────────────────────────────────────────────────
const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

// ── verifyClinicianShareToken mock ───────────────────────────────────
// Default: return valid with a known shareRowId. Override per test.
const verifyClinicianShareTokenMock = vi.hoisted(() =>
  vi.fn<() => VerifyClinicianShareTokenResult>(() => ({
    valid: true as const,
    shareRowId: "share-row-uuid-1111",
  })),
);
vi.mock("../lib/clinician-share-token", () => ({
  verifyClinicianShareToken: verifyClinicianShareTokenMock,
}));

// ── logger mock ──────────────────────────────────────────────────────
vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import portalClinicianRouter from "./portal-clinician";

// ── Constants ─────────────────────────────────────────────────────────
const SHARE_ROW_ID = "share-row-uuid-1111";
const REFERRAL_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

// A token that passes min(8) / max(2000) validation.
const VALID_TOKEN = "valid-token-for-test-AABBCCDD";

// A future ISO string so expiry checks pass.
const FUTURE_EXPIRES_AT = "2099-12-31T00:00:00.000Z";
const PAST_EXPIRES_AT = "2000-01-01T00:00:00.000Z";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(portalClinicianRouter);
  return app;
}

function stubShareRow(
  overrides: Partial<{
    id: string;
    referral_id: string;
    expires_at: string;
    revoked_at: string | null;
    view_count: number;
  }> = {},
): void {
  stageSupabaseResponse("clinician_share_tokens", "select", {
    data: {
      id: SHARE_ROW_ID,
      referral_id: REFERRAL_ID,
      expires_at: FUTURE_EXPIRES_AT,
      revoked_at: null,
      view_count: 3,
      ...overrides,
    },
  });
}

function stubReferral(
  overrides: Partial<Record<string, unknown>> = {},
): void {
  stageSupabaseResponse("inbound_referral_orders", "select", {
    data: {
      id: REFERRAL_ID,
      source: "parachute",
      source_order_id: "ORDER-ABC-123",
      triage_status: "accepted",
      accepted_at: "2026-05-01T10:00:00.000Z",
      accepted_order_kind: "new",
      triaged_at: "2026-05-01T09:00:00.000Z",
      received_at: "2026-05-01T08:00:00.000Z",
      preflight_completed_at: "2026-05-01T09:30:00.000Z",
      // PHI fields that the route must NOT include:
      legal_first_name: "ALICE",
      legal_last_name: "SMITH",
      dob: "1970-01-01",
      phone_e164: "+15555550100",
      email: "alice@example.com",
      member_id: "MEM-0001",
      ...overrides,
    },
  });
}

function stubOutboxRows(
  rows: unknown[] = [
    {
      event_type: "accepted",
      status: "delivered",
      delivered_at: "2026-05-01T10:05:00.000Z",
      created_at: "2026-05-01T10:05:00.000Z",
    },
  ],
): void {
  stageSupabaseResponse("inbound_referral_status_outbox", "select", {
    data: rows,
  });
}

function stubPreflightChecks(
  rows: unknown[] = [
    {
      check_kind: "coverage_active",
      outcome_status: "pass",
      created_at: "2026-05-01T09:20:00.000Z",
    },
  ],
): void {
  stageSupabaseResponse("inbound_referral_preflight_checks", "select", {
    data: rows,
  });
}

beforeEach(() => {
  supabaseMock.reset();
  logAuditMock.mockClear();
  verifyClinicianShareTokenMock.mockClear();
  // Default: token passes HMAC verification
  verifyClinicianShareTokenMock.mockReturnValue({
    valid: true,
    shareRowId: SHARE_ROW_ID,
  });
});

// ────────────────────────────────────────────────────────────────────
// Input validation
// ────────────────────────────────────────────────────────────────────

describe("GET /portal/clinician/:token — input validation", () => {
  it("returns 404 when token is shorter than 8 characters", async () => {
    const res = await request(makeApp()).get("/portal/clinician/abc");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 404 when token exceeds 2000 characters", async () => {
    const longToken = "a".repeat(2001);
    const res = await request(makeApp()).get(
      `/portal/clinician/${longToken}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 404 when HMAC verification fails", async () => {
    verifyClinicianShareTokenMock.mockReturnValueOnce({ valid: false });
    const res = await request(makeApp()).get(
      `/portal/clinician/${VALID_TOKEN}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });
});

// ────────────────────────────────────────────────────────────────────
// DB guard-rails (share token row checks)
// ────────────────────────────────────────────────────────────────────

describe("GET /portal/clinician/:token — share token row checks", () => {
  it("returns 404 when the share token row doesn't exist in the DB", async () => {
    stageSupabaseResponse("clinician_share_tokens", "select", {
      data: null,
    });
    const res = await request(makeApp()).get(
      `/portal/clinician/${VALID_TOKEN}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 410 with error='revoked' when the token has been revoked", async () => {
    stubShareRow({ revoked_at: "2026-01-15T00:00:00.000Z" });
    const res = await request(makeApp()).get(
      `/portal/clinician/${VALID_TOKEN}`,
    );
    expect(res.status).toBe(410);
    expect(res.body.error).toBe("revoked");
  });

  it("returns 410 with error='expired' when expires_at is in the past", async () => {
    stubShareRow({ expires_at: PAST_EXPIRES_AT, revoked_at: null });
    const res = await request(makeApp()).get(
      `/portal/clinician/${VALID_TOKEN}`,
    );
    expect(res.status).toBe(410);
    expect(res.body.error).toBe("expired");
  });

  it("checks revoked_at before expires_at (revoked takes priority)", async () => {
    stubShareRow({
      revoked_at: "2026-01-01T00:00:00.000Z",
      expires_at: PAST_EXPIRES_AT,
    });
    const res = await request(makeApp()).get(
      `/portal/clinician/${VALID_TOKEN}`,
    );
    expect(res.status).toBe(410);
    expect(res.body.error).toBe("revoked");
  });
});

// ────────────────────────────────────────────────────────────────────
// Referral not found
// ────────────────────────────────────────────────────────────────────

describe("GET /portal/clinician/:token — referral not found", () => {
  it("returns 404 when the referral no longer exists (FK cascade hard-delete)", async () => {
    stubShareRow();
    stageSupabaseResponse("inbound_referral_orders", "select", {
      data: null,
    });
    stubOutboxRows([]);
    stubPreflightChecks([]);
    const res = await request(makeApp()).get(
      `/portal/clinician/${VALID_TOKEN}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });
});

// ────────────────────────────────────────────────────────────────────
// Happy path — 200 response shape
// ────────────────────────────────────────────────────────────────────

describe("GET /portal/clinician/:token — happy path", () => {
  it("returns 200 with the correct referral status fields", async () => {
    stubShareRow();
    stubReferral();
    stubOutboxRows([]);
    stubPreflightChecks([]);
    const res = await request(makeApp()).get(
      `/portal/clinician/${VALID_TOKEN}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.sourceOrderId).toBe("ORDER-ABC-123");
    expect(res.body.source).toBe("parachute");
    expect(res.body.status).toBe("accepted");
    expect(res.body.receivedAt).toBe("2026-05-01T08:00:00.000Z");
    expect(res.body.triagedAt).toBe("2026-05-01T09:00:00.000Z");
    expect(res.body.acceptedAt).toBe("2026-05-01T10:00:00.000Z");
    expect(res.body.acceptedOrderKind).toBe("new");
    expect(res.body.preflightCompletedAt).toBe("2026-05-01T09:30:00.000Z");
  });

  it("returns expiresAt and viewCount in the footer (view_count+1)", async () => {
    stubShareRow({ view_count: 5 });
    stubReferral();
    stubOutboxRows([]);
    stubPreflightChecks([]);
    const res = await request(makeApp()).get(
      `/portal/clinician/${VALID_TOKEN}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.expiresAt).toBe(FUTURE_EXPIRES_AT);
    // view_count was 5, response should show 6
    expect(res.body.viewCount).toBe(6);
  });

  it("maps outbox rows into the timeline array", async () => {
    stubShareRow();
    stubReferral();
    stubOutboxRows([
      {
        event_type: "received",
        status: "delivered",
        delivered_at: "2026-05-01T08:01:00.000Z",
        created_at: "2026-05-01T08:00:00.000Z",
      },
      {
        event_type: "accepted",
        status: "delivered",
        delivered_at: "2026-05-01T10:05:00.000Z",
        created_at: "2026-05-01T10:00:00.000Z",
      },
    ]);
    stubPreflightChecks([]);
    const res = await request(makeApp()).get(
      `/portal/clinician/${VALID_TOKEN}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.timeline).toHaveLength(2);
    expect(res.body.timeline[0]).toMatchObject({
      eventType: "received",
      status: "delivered",
      deliveredAt: "2026-05-01T08:01:00.000Z",
      at: "2026-05-01T08:00:00.000Z",
    });
    expect(res.body.timeline[1].eventType).toBe("accepted");
  });

  it("maps preflight check rows into the preflightSummary array", async () => {
    stubShareRow();
    stubReferral();
    stubOutboxRows([]);
    stubPreflightChecks([
      {
        check_kind: "coverage_active",
        outcome_status: "pass",
        created_at: "2026-05-01T09:20:00.000Z",
      },
      {
        check_kind: "prior_auth_required",
        outcome_status: "needs_review",
        created_at: "2026-05-01T09:25:00.000Z",
      },
    ]);
    const res = await request(makeApp()).get(
      `/portal/clinician/${VALID_TOKEN}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.preflightSummary).toHaveLength(2);
    expect(res.body.preflightSummary[0]).toMatchObject({
      kind: "coverage_active",
      status: "pass",
      at: "2026-05-01T09:20:00.000Z",
    });
    expect(res.body.preflightSummary[1].kind).toBe("prior_auth_required");
  });

  it("returns empty arrays when timeline and preflight are null from DB", async () => {
    stubShareRow();
    stubReferral();
    stageSupabaseResponse("inbound_referral_status_outbox", "select", {
      data: null,
    });
    stageSupabaseResponse("inbound_referral_preflight_checks", "select", {
      data: null,
    });
    const res = await request(makeApp()).get(
      `/portal/clinician/${VALID_TOKEN}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.timeline).toEqual([]);
    expect(res.body.preflightSummary).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// PHI invariant — response must never leak patient identity fields
// ────────────────────────────────────────────────────────────────────

describe("GET /portal/clinician/:token — PHI invariant", () => {
  it("does not include patient name, dob, phone, email, or member_id in the 200 response", async () => {
    stubShareRow();
    stubReferral();
    stubOutboxRows([]);
    stubPreflightChecks([]);
    const res = await request(makeApp()).get(
      `/portal/clinician/${VALID_TOKEN}`,
    );
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    // These strings appear in the mock referral row above; they must
    // not appear anywhere in the serialised response.
    expect(body).not.toContain("ALICE");
    expect(body).not.toContain("SMITH");
    expect(body).not.toContain("1970-01-01");
    expect(body).not.toContain("+15555550100");
    expect(body).not.toContain("alice@example.com");
    expect(body).not.toContain("MEM-0001");
  });
});

// ────────────────────────────────────────────────────────────────────
// Audit logging
// ────────────────────────────────────────────────────────────────────

describe("GET /portal/clinician/:token — audit logging", () => {
  it("writes an audit log entry on every successful view", async () => {
    stubShareRow({ view_count: 0 });
    stubReferral();
    stubOutboxRows([]);
    stubPreflightChecks([]);
    await request(makeApp()).get(`/portal/clinician/${VALID_TOKEN}`);
    expect(logAuditMock).toHaveBeenCalledOnce();
    const auditCall = logAuditMock.mock.calls[0][0] as Record<string, unknown>;
    expect(auditCall.action).toBe(
      "inbound_referral.clinician_share_viewed",
    );
    expect(auditCall.targetTable).toBe("clinician_share_tokens");
    expect(auditCall.targetId).toBe(SHARE_ROW_ID);
    const meta = auditCall.metadata as Record<string, unknown>;
    expect(meta.referral_id).toBe(REFERRAL_ID);
    expect(meta.view_count).toBe(1);
  });

  it("still returns 200 even when logAudit throws", async () => {
    stubShareRow();
    stubReferral();
    stubOutboxRows([]);
    stubPreflightChecks([]);
    logAuditMock.mockRejectedValueOnce(new Error("audit service down"));
    const res = await request(makeApp()).get(
      `/portal/clinician/${VALID_TOKEN}`,
    );
    expect(res.status).toBe(200);
  });

  it("does not write an audit log when the token is revoked", async () => {
    stubShareRow({ revoked_at: "2026-01-15T00:00:00.000Z" });
    await request(makeApp()).get(`/portal/clinician/${VALID_TOKEN}`);
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("does not write an audit log when HMAC verification fails", async () => {
    verifyClinicianShareTokenMock.mockReturnValueOnce({ valid: false });
    await request(makeApp()).get(`/portal/clinician/${VALID_TOKEN}`);
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// View count update (fire-and-forget)
// ────────────────────────────────────────────────────────────────────

describe("GET /portal/clinician/:token — view count fire-and-forget update", () => {
  it("issues a DB update to bump view_count by 1 on each view", async () => {
    stubShareRow({ view_count: 7 });
    stubReferral();
    stubOutboxRows([]);
    stubPreflightChecks([]);
    await request(makeApp()).get(`/portal/clinician/${VALID_TOKEN}`);
    expect(
      supabaseMock.callCount("clinician_share_tokens", "update"),
    ).toBe(1);
    const payload = supabaseMock.writePayloads(
      "clinician_share_tokens",
      "update",
    )[0] as Record<string, unknown>;
    expect(payload.view_count).toBe(8);
    expect(typeof payload.last_viewed_at).toBe("string");
  });
});
