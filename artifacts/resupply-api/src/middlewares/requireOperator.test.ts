import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

// Mock @clerk/express wholesale. Two reasons:
//   1. The middleware's only Clerk surface area is `getAuth(req)` and
//      `clerkClient.users.getUser(id)`. Stubbing those keeps the test
//      hermetic — no Clerk network calls, no need for a CLERK_SECRET_KEY
//      at test time.
//   2. We want to drive the userId / email / verification status from
//      the test, not a real Clerk fixture.
const getAuthMock = vi.fn();
const getUserMock = vi.fn();
vi.mock("@clerk/express", () => ({
  getAuth: (...args: unknown[]) => getAuthMock(...args),
  clerkClient: {
    users: { getUser: (...args: unknown[]) => getUserMock(...args) },
  },
}));

import { requireOperator } from "./requireOperator";

function makeApp(): Express {
  const app = express();
  app.get("/protected", requireOperator, (req, res) => {
    res.json({
      ok: true,
      operatorEmail: req.operatorEmail,
      operatorClerkId: req.operatorClerkId,
    });
  });
  return app;
}

const ALLOWED_EMAIL = "rt-coordinator@pennhomemedical.com";
const NOT_ALLOWED_EMAIL = "random.user@example.com";

function stubVerifiedUser(email: string, userId = "user_abc123"): void {
  getAuthMock.mockReturnValue({ userId });
  getUserMock.mockResolvedValue({
    primaryEmailAddressId: "eml_1",
    emailAddresses: [
      {
        id: "eml_1",
        emailAddress: email,
        verification: { status: "verified" },
      },
    ],
  });
}

describe("requireOperator middleware", () => {
  let originalAllowlist: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    getAuthMock.mockReset();
    getUserMock.mockReset();
    originalAllowlist = process.env.RESUPPLY_OPERATOR_EMAILS;
    originalNodeEnv = process.env.NODE_ENV;
    delete process.env.RESUPPLY_OPERATOR_EMAILS;
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    if (originalAllowlist === undefined) {
      delete process.env.RESUPPLY_OPERATOR_EMAILS;
    } else {
      process.env.RESUPPLY_OPERATOR_EMAILS = originalAllowlist;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  // --- Required rejection paths from the task description ---

  it("returns 401 when there is no Clerk session", async () => {
    process.env.RESUPPLY_OPERATOR_EMAILS = ALLOWED_EMAIL;
    getAuthMock.mockReturnValue({ userId: null });

    const res = await request(makeApp()).get("/protected");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Sign in required" });
    // Clerk SDK should NOT have been hit if the session check failed.
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the signed-in email is not in the allowlist", async () => {
    process.env.RESUPPLY_OPERATOR_EMAILS = ALLOWED_EMAIL;
    stubVerifiedUser(NOT_ALLOWED_EMAIL);

    const res = await request(makeApp()).get("/protected");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "This account is not authorized for operator access.",
    });
  });

  it("returns 503 in production when RESUPPLY_OPERATOR_EMAILS is unset (fail-closed)", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.RESUPPLY_OPERATOR_EMAILS;
    stubVerifiedUser(ALLOWED_EMAIL);

    const res = await request(makeApp()).get("/protected");

    expect(res.status).toBe(503);
    // The error message must name the env var so an operator looking
    // at the response can fix the deploy without grepping the source.
    expect(res.body.error).toMatch(/RESUPPLY_OPERATOR_EMAILS/);
  });

  // --- Adjacent behaviors that protect the allowlist's invariants ---

  it("allows a signed-in operator whose verified email is in the allowlist", async () => {
    process.env.RESUPPLY_OPERATOR_EMAILS = `someone-else@example.com,${ALLOWED_EMAIL}`;
    stubVerifiedUser(ALLOWED_EMAIL);

    const res = await request(makeApp()).get("/protected");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      operatorEmail: ALLOWED_EMAIL,
      operatorClerkId: "user_abc123",
    });
  });

  it("matches allowlist case-insensitively (operator emails are not case-sensitive)", async () => {
    process.env.RESUPPLY_OPERATOR_EMAILS = "RT-Coordinator@PennHomeMedical.com";
    stubVerifiedUser(ALLOWED_EMAIL);

    const res = await request(makeApp()).get("/protected");

    expect(res.status).toBe(200);
    expect(res.body.operatorEmail).toBe(ALLOWED_EMAIL);
  });

  it("returns 403 when the primary email is unverified, even if it matches the allowlist", async () => {
    // Defense-in-depth: an attacker who could add someone else's
    // address to a Clerk profile (without proving they control the
    // inbox) must not get past the allowlist on that basis alone.
    process.env.RESUPPLY_OPERATOR_EMAILS = ALLOWED_EMAIL;
    getAuthMock.mockReturnValue({ userId: "user_abc123" });
    getUserMock.mockResolvedValue({
      primaryEmailAddressId: "eml_1",
      emailAddresses: [
        {
          id: "eml_1",
          emailAddress: ALLOWED_EMAIL,
          verification: { status: "unverified" },
        },
      ],
    });

    const res = await request(makeApp()).get("/protected");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not verified/i);
  });

  it("treats an env var of only commas/whitespace as unset (fail-closed in production)", async () => {
    // Regression guard: a deploy that ships
    // RESUPPLY_OPERATOR_EMAILS=", , ," must NOT silently fall through
    // to the dev-mode "any signed-in user is an operator" branch.
    process.env.NODE_ENV = "production";
    process.env.RESUPPLY_OPERATOR_EMAILS = " , ,, ";
    stubVerifiedUser(ALLOWED_EMAIL);

    const res = await request(makeApp()).get("/protected");

    expect(res.status).toBe(503);
  });

  it("falls back to allowing any signed-in user in development when env var is unset", async () => {
    // Confirms the dev-only escape hatch works so local development
    // doesn't require setting the env var. Paired with the 503 test
    // above to prove the same code path fails closed in production.
    process.env.NODE_ENV = "development";
    delete process.env.RESUPPLY_OPERATOR_EMAILS;
    stubVerifiedUser(NOT_ALLOWED_EMAIL);

    const res = await request(makeApp()).get("/protected");

    expect(res.status).toBe(200);
    expect(res.body.operatorEmail).toBe(NOT_ALLOWED_EMAIL);
  });

  it("dev fallback: also allows users whose primary email is unverified (no allowlist to spoof)", async () => {
    // The verified-email check is defense-in-depth against allowlist
    // spoofing. With no allowlist set, there's nothing to spoof, so
    // the verification check is irrelevant. This branch is exercised
    // by the e2e test harness, which creates Clerk users via the
    // Backend API and does NOT mark their primary email as verified.
    process.env.NODE_ENV = "development";
    delete process.env.RESUPPLY_OPERATOR_EMAILS;
    getAuthMock.mockReturnValue({ userId: "user_unverified" });
    getUserMock.mockResolvedValue({
      primaryEmailAddressId: "eml_1",
      emailAddresses: [
        {
          id: "eml_1",
          emailAddress: "fresh-test-user@example.com",
          verification: { status: "unverified" },
        },
      ],
    });

    const res = await request(makeApp()).get("/protected");

    expect(res.status).toBe(200);
    expect(res.body.operatorEmail).toBe("fresh-test-user@example.com");
    expect(res.body.operatorClerkId).toBe("user_unverified");
  });

  it("dev fallback: still issues an operator id even if Clerk returns no email at all", async () => {
    // Edge case: a Clerk user with zero email addresses. Production
    // would never reach this branch (allowlist would catch it), but
    // dev should still let the operator in so the console isn't
    // bricked by a fixture quirk.
    process.env.NODE_ENV = "development";
    delete process.env.RESUPPLY_OPERATOR_EMAILS;
    getAuthMock.mockReturnValue({ userId: "user_no_email" });
    getUserMock.mockResolvedValue({
      primaryEmailAddressId: null,
      emailAddresses: [],
    });

    const res = await request(makeApp()).get("/protected");

    expect(res.status).toBe(200);
    expect(res.body.operatorEmail).toBe("clerk:user_no_email");
    expect(res.body.operatorClerkId).toBe("user_no_email");
  });

  it("returns 401 if Clerk lookup throws", async () => {
    process.env.RESUPPLY_OPERATOR_EMAILS = ALLOWED_EMAIL;
    getAuthMock.mockReturnValue({ userId: "user_abc123" });
    getUserMock.mockRejectedValue(
      new Error("clerk says: user user_abc123 is locked out"),
    );

    const res = await request(makeApp()).get("/protected");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: "Could not verify your identity. Please sign in again.",
    });
    // The underlying Clerk error must NOT leak into the response.
    expect(JSON.stringify(res.body)).not.toMatch(/user_abc123/);
    expect(JSON.stringify(res.body)).not.toMatch(/locked out/);
  });
});
