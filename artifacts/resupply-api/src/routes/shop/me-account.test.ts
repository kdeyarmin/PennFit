// Route tests for routes/shop/me-account.ts (POST /shop/me/account/close).
//
// Coverage:
//   * 401 when the caller has no session
//   * 400 on a missing/invalid body
//   * 403 (and NO mutation) when the re-verified password is wrong
//   * 400 when the account has no password credential to verify against
//   * happy path: scrubs customer + orders, revokes login + sessions,
//     clears the cookie, returns { closed: true }

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import { makeRequireSignedInMock } from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn, verifyOkRef, repoMocks, auditMock, appendSetCookieMock } =
  vi.hoisted(() => ({
    mockSignedIn: { current: null as string | null },
    verifyOkRef: { current: true },
    repoMocks: {
      findSessionByTokenHash: vi.fn(),
      findCredentialByUserId: vi.fn(),
      updateUserStatus: vi.fn(async () => undefined),
      revokeAllUserSessions: vi.fn(async () => undefined),
    },
    auditMock: vi.fn(),
    appendSetCookieMock: vi.fn(),
  }));

vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

vi.mock("@workspace/resupply-auth", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-auth")
  >("@workspace/resupply-auth");
  return {
    ...actual,
    readCookie: () => "raw-token",
    hashToken: () => "hashed-token",
    verifyPasswordCredential: async () => ({ ok: verifyOkRef.current }),
    appendSetCookie: (...args: unknown[]) => appendSetCookieMock(...args),
    buildClearCookies: () => ["pf_session=; Max-Age=0"],
  };
});

vi.mock("../../lib/auth-deps", () => ({
  getAuthDeps: () => ({
    repo: repoMocks,
    audit: auditMock,
    secureCookies: false,
  }),
}));

import meAccountRouter from "./me-account";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", meAccountRouter);
  return app;
}

function stubSignedIn(userId: string): void {
  mockSignedIn.current = userId;
}

const CLOSE = "/resupply-api/shop/me/account/close";

beforeEach(() => {
  mockSignedIn.current = null;
  verifyOkRef.current = true;
  repoMocks.findSessionByTokenHash.mockReset();
  repoMocks.findCredentialByUserId.mockReset();
  repoMocks.updateUserStatus.mockReset();
  repoMocks.revokeAllUserSessions.mockReset();
  auditMock.mockReset();
  appendSetCookieMock.mockReset();
  // Sensible defaults for the authed path.
  repoMocks.findSessionByTokenHash.mockResolvedValue({
    id: "sess_1",
    userId: "auth_1",
    revokedAt: null,
  });
  repoMocks.findCredentialByUserId.mockResolvedValue({ hash: "x" });
  supabaseMock.reset();
});

describe("POST /shop/me/account/close", () => {
  it("returns 401 when the caller has no session", async () => {
    const res = await request(makeApp()).post(CLOSE).send({ password: "pw" });
    expect(res.status).toBe(401);
    expect(repoMocks.updateUserStatus).not.toHaveBeenCalled();
  });

  it("returns 400 on a missing password", async () => {
    stubSignedIn("cust_1");
    const res = await request(makeApp()).post(CLOSE).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(repoMocks.revokeAllUserSessions).not.toHaveBeenCalled();
  });

  it("returns 403 and mutates nothing when the password is wrong", async () => {
    stubSignedIn("cust_1");
    verifyOkRef.current = false;
    const res = await request(makeApp())
      .post(CLOSE)
      .send({ password: "wrong" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invalid_password");
    // No scrub, no login-disable, no session revoke.
    expect(getSupabaseCallCount("shop_customers", "update")).toBe(0);
    expect(repoMocks.updateUserStatus).not.toHaveBeenCalled();
    expect(repoMocks.revokeAllUserSessions).not.toHaveBeenCalled();
    expect(appendSetCookieMock).not.toHaveBeenCalled();
  });

  it("returns 400 when there is no password credential to verify", async () => {
    stubSignedIn("cust_1");
    repoMocks.findCredentialByUserId.mockResolvedValue(null);
    const res = await request(makeApp()).post(CLOSE).send({ password: "pw" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("password_unavailable");
    expect(repoMocks.updateUserStatus).not.toHaveBeenCalled();
  });

  it("scrubs PII, disables login, revokes sessions, and clears the cookie", async () => {
    stubSignedIn("cust_1");
    const res = await request(makeApp()).post(CLOSE).send({ password: "pw" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ closed: true });

    // PII scrubbed on both the customer profile and the retained orders.
    expect(getSupabaseCallCount("shop_customers", "update")).toBe(1);
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(1);
    // Auth row PII scrubbed + login disabled + sessions revoked.
    expect(getSupabaseCallCount("users", "update")).toBe(1);
    expect(repoMocks.updateUserStatus).toHaveBeenCalledWith(
      "auth_1",
      "revoked",
    );
    expect(repoMocks.revokeAllUserSessions).toHaveBeenCalledWith(
      "auth_1",
      expect.any(Date),
    );
    // Session cookie cleared on the way out.
    expect(appendSetCookieMock).toHaveBeenCalledTimes(1);
  });
});
