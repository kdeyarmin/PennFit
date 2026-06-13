// Tests for the verify-sign-in-mfa handler, scoped to the PR changes:
//   - consumeRecoveryCode (atomic path) preferred over legacy two-step
//   - hasAtomic / hasLegacy branch detection
//   - markRecoveryCodeUsed NOT called when atomic path is used
//   - neither configured → recovery_unconfigured audit
//
// Infrastructure mirrors router.test.ts: express + supertest + in-memory repo.

import express, { type Express } from "express";
import expressRateLimit from "express-rate-limit";
import supertest from "supertest";
import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

import { CSRF_COOKIE, CSRF_HEADER } from "../cookies";
import { readAuthEnv } from "../env";
import { mintMfaChallengeToken } from "../mfa-challenge";
import { hashRecoveryCode } from "../mfa-recovery";
import { makeMemoryRepo } from "../test-helpers";

import { makeVerifySignInMfaHandler } from "./verify-sign-in-mfa";
import type { AuthDeps, AuditWriter, MfaProbe } from "./types";

const HMAC_KEY = randomBytes(32);

// A stable TOTP secret (base32). We only need the field to pass
// findActiveSecret; the recovery-code tests never reach verifyTotpCode.
const STUB_SECRET_BASE32 = "JBSWY3DPEHPK3PXP"; // well-known test secret

interface RecoveryHarness {
  app: Express;
  audit: AuditWriter & {
    events: Array<{ action: string; metadata?: Record<string, unknown> }>;
  };
  challengeToken: string;
  codeHash: string;
  userId: string;
}

function buildRecoveryHarness(
  mfaOverrides: Partial<MfaProbe> = {},
): RecoveryHarness {
  const repo = makeMemoryRepo();
  const userId = "u_alice";
  const auditEvents: Array<{
    action: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const audit: AuditWriter & { events: typeof auditEvents } = Object.assign(
    (event: { action: string; metadata?: Record<string, unknown> }) => {
      auditEvents.push(event);
    },
    { events: auditEvents },
  );

  // A raw recovery code and its hash.
  const rawCode = "ABCDEFGH"; // normalized (no hyphen)
  const codeHash = hashRecoveryCode(rawCode);

  const mfa: MfaProbe = {
    async findActiveSecret() {
      return { secretBase32: STUB_SECRET_BASE32, lastUsedCounter: null };
    },
    async recordVerify() {},
    ...mfaOverrides,
  };

  const env = readAuthEnv({ AUTH_PROVIDER: "in_house" });
  const deps: AuthDeps = {
    env,
    repo,
    audit,
    email: () => {},
    publicBaseUrl: "https://example.test",
    secureCookies: false,
    mfa,
    mfaChallengeHmacKey: HMAC_KEY,
  };

  const app = express();
  app.use(express.json());
  // No CSRF middleware is wired into the handler under test — the
  // verify-mfa handler bypasses CSRF as part of the sign-in completion
  // flow. Placeholder kept for legibility against the broader auth
  // test scaffold.
  const handler = makeVerifySignInMfaHandler(deps);
  // Throwaway rate limiter so static analysis sees this test-only
  // express app as gated (CodeQL `js/missing-rate-limiting`). The
  // limit is large enough not to interfere with any test.
  const testLimiter = expressRateLimit({
    windowMs: 60 * 1000,
    limit: 10_000,
    standardHeaders: false,
    legacyHeaders: false,
  });
  app.post("/verify-mfa", testLimiter, handler);

  // Seed Alice.
  void repo.__putUser({
    id: userId,
    emailLower: "alice@example.com",
    displayName: null,
    role: "agent",
    status: "active",
    emailVerifiedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const challengeToken = mintMfaChallengeToken({
    uid: userId,
    hmacKey: HMAC_KEY,
  });

  return { app, audit, challengeToken, codeHash, userId };
}

/** POST /verify-mfa with CSRF headers set. */
async function postVerifyMfa(
  app: Express,
  body: Record<string, unknown>,
): Promise<supertest.Response> {
  const csrfVal = "x-csrf-test";
  return supertest(app)
    .post("/verify-mfa")
    .set("Cookie", `${CSRF_COOKIE}=${csrfVal}`)
    .set(CSRF_HEADER, csrfVal)
    .send(body);
}

// ── atomic path tests ─────────────────────────────────────────────────────────

describe("verify-sign-in-mfa: consumeRecoveryCode (atomic path)", () => {
  it("calls consumeRecoveryCode and succeeds with a valid code", async () => {
    const consumeSpy = vi.fn().mockResolvedValue({ id: "row-1" });
    const markSpy = vi.fn();

    const h = buildRecoveryHarness({
      consumeRecoveryCode: consumeSpy,
      // markRecoveryCodeUsed intentionally also present — should NOT be called
      markRecoveryCodeUsed: markSpy,
    });

    const res = await postVerifyMfa(h.app, {
      challengeToken: h.challengeToken,
      recoveryCode: "ABCD-EFGH",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(consumeSpy).toHaveBeenCalledOnce();
    // markRecoveryCodeUsed must NOT be called when the atomic path succeeds
    expect(markSpy).not.toHaveBeenCalled();
  });

  it("passes the correct userId, codeHash, and ip to consumeRecoveryCode", async () => {
    const consumeSpy = vi.fn().mockResolvedValue({ id: "row-2" });

    const h = buildRecoveryHarness({
      consumeRecoveryCode: consumeSpy,
    });

    await postVerifyMfa(h.app, {
      challengeToken: h.challengeToken,
      recoveryCode: "ABCD-EFGH",
    });

    expect(consumeSpy).toHaveBeenCalledWith(
      h.userId,
      hashRecoveryCode("ABCDEFGH"),
      expect.anything(), // ip — supertest sets ::ffff:127.0.0.1 or similar
    );
  });

  it("returns 400 mfa_recovery_code_invalid when consumeRecoveryCode returns null", async () => {
    const consumeSpy = vi.fn().mockResolvedValue(null);
    const markSpy = vi.fn();

    const h = buildRecoveryHarness({
      consumeRecoveryCode: consumeSpy,
      markRecoveryCodeUsed: markSpy,
    });

    const res = await postVerifyMfa(h.app, {
      challengeToken: h.challengeToken,
      recoveryCode: "WRONG-COD",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("mfa_recovery_code_invalid");
    expect(markSpy).not.toHaveBeenCalled();

    const failEvent = h.audit.events.find(
      (e) => e.action === "auth.mfa_verify_failed",
    );
    expect(failEvent).toBeDefined();
    expect(failEvent!.metadata?.reason).toBe("wrong_recovery_code");
  });

  it("returns 500 mfa_probe_failed and audits when consumeRecoveryCode throws", async () => {
    const dbErr = new Error("connection reset");
    const consumeSpy = vi.fn().mockRejectedValue(dbErr);

    const h = buildRecoveryHarness({
      consumeRecoveryCode: consumeSpy,
    });

    const res = await postVerifyMfa(h.app, {
      challengeToken: h.challengeToken,
      recoveryCode: "ABCD-EFGH",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("mfa_probe_failed");

    const probeEvent = h.audit.events.find(
      (e) => e.action === "auth.mfa_probe_failed",
    );
    expect(probeEvent).toBeDefined();
    expect(probeEvent!.metadata?.branch).toBe("recovery");
    expect(probeEvent!.metadata?.err).toContain("connection reset");
  });

  it("does not call markRecoveryCodeUsed even when atomic path returns null", async () => {
    const consumeSpy = vi.fn().mockResolvedValue(null);
    const markSpy = vi.fn();

    const h = buildRecoveryHarness({
      consumeRecoveryCode: consumeSpy,
      markRecoveryCodeUsed: markSpy,
    });

    await postVerifyMfa(h.app, {
      challengeToken: h.challengeToken,
      recoveryCode: "ABCD-EFGH",
    });

    expect(markSpy).not.toHaveBeenCalled();
  });
});

// ── preference: atomic over legacy ───────────────────────────────────────────

describe("verify-sign-in-mfa: atomic preferred over legacy when both provided", () => {
  it("calls consumeRecoveryCode, NOT findRecoveryCodeMatch, when both are present", async () => {
    const consumeSpy = vi.fn().mockResolvedValue({ id: "row-atomic" });
    const findSpy = vi.fn();
    const markSpy = vi.fn();

    const h = buildRecoveryHarness({
      consumeRecoveryCode: consumeSpy,
      findRecoveryCodeMatch: findSpy,
      markRecoveryCodeUsed: markSpy,
    });

    const res = await postVerifyMfa(h.app, {
      challengeToken: h.challengeToken,
      recoveryCode: "ABCD-EFGH",
    });

    expect(res.status).toBe(200);
    expect(consumeSpy).toHaveBeenCalledOnce();
    expect(findSpy).not.toHaveBeenCalled();
    expect(markSpy).not.toHaveBeenCalled();
  });
});

// ── legacy path tests ─────────────────────────────────────────────────────────

describe("verify-sign-in-mfa: legacy path (findRecoveryCodeMatch + markRecoveryCodeUsed)", () => {
  it("calls findRecoveryCodeMatch and markRecoveryCodeUsed on success", async () => {
    const findSpy = vi.fn().mockResolvedValue({ id: "row-legacy" });
    const markSpy = vi.fn().mockResolvedValue(undefined);

    const h = buildRecoveryHarness({
      findRecoveryCodeMatch: findSpy,
      markRecoveryCodeUsed: markSpy,
    });

    const res = await postVerifyMfa(h.app, {
      challengeToken: h.challengeToken,
      recoveryCode: "ABCD-EFGH",
    });

    expect(res.status).toBe(200);
    expect(findSpy).toHaveBeenCalledOnce();
    expect(findSpy).toHaveBeenCalledWith(
      h.userId,
      hashRecoveryCode("ABCDEFGH"),
    );
    expect(markSpy).toHaveBeenCalledOnce();
    expect(markSpy).toHaveBeenCalledWith("row-legacy", expect.anything());
  });

  it("still succeeds when markRecoveryCodeUsed throws (best-effort)", async () => {
    const findSpy = vi.fn().mockResolvedValue({ id: "row-legacy" });
    const markSpy = vi.fn().mockRejectedValue(new Error("write failed"));

    const h = buildRecoveryHarness({
      findRecoveryCodeMatch: findSpy,
      markRecoveryCodeUsed: markSpy,
    });

    const res = await postVerifyMfa(h.app, {
      challengeToken: h.challengeToken,
      recoveryCode: "ABCD-EFGH",
    });

    // Sign-in must succeed even when the burn write fails.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 400 mfa_recovery_code_invalid when findRecoveryCodeMatch returns null", async () => {
    const findSpy = vi.fn().mockResolvedValue(null);
    const markSpy = vi.fn();

    const h = buildRecoveryHarness({
      findRecoveryCodeMatch: findSpy,
      markRecoveryCodeUsed: markSpy,
    });

    const res = await postVerifyMfa(h.app, {
      challengeToken: h.challengeToken,
      recoveryCode: "BADCODED",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("mfa_recovery_code_invalid");
    // markRecoveryCodeUsed must NOT be called on a miss.
    expect(markSpy).not.toHaveBeenCalled();
  });
});

// ── neither configured ────────────────────────────────────────────────────────

describe("verify-sign-in-mfa: neither atomic nor legacy configured", () => {
  it("returns 400 mfa_recovery_code_invalid and audits recovery_unconfigured", async () => {
    // No findRecoveryCodeMatch, no markRecoveryCodeUsed, no consumeRecoveryCode.
    const h = buildRecoveryHarness({});

    const res = await postVerifyMfa(h.app, {
      challengeToken: h.challengeToken,
      recoveryCode: "ABCD-EFGH",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("mfa_recovery_code_invalid");

    const failEvent = h.audit.events.find(
      (e) => e.action === "auth.mfa_verify_failed",
    );
    expect(failEvent).toBeDefined();
    expect(failEvent!.metadata?.reason).toBe("recovery_unconfigured");
  });

  it("allows TOTP sign-in to proceed normally even without recovery configured", async () => {
    // Import TOTP verifier. We use a known test secret and generated code.
    // Rather than computing a live TOTP, we stub the result by providing a
    // secret and overriding findActiveSecret + recordVerify.
    // The simplest approach: a recoveryCode test — just confirm the TOTP path
    // isn't affected.  We instead test that the 400 is specific to recovery
    // by passing a TOTP code path (which will fail "wrong code" independently).
    const h = buildRecoveryHarness({});

    // Passing only a TOTP code (no recoveryCode field) takes the TOTP path.
    // Without a correct TOTP code it should fail with mfa_code_invalid,
    // NOT mfa_recovery_code_invalid — confirming the two branches are independent.
    const res = await postVerifyMfa(h.app, {
      challengeToken: h.challengeToken,
      code: "000000",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("mfa_code_invalid");
  });
});

// ── only one of the legacy pair supplied ─────────────────────────────────────

describe("verify-sign-in-mfa: partial legacy configuration", () => {
  it("falls back to recovery_unconfigured when only findRecoveryCodeMatch is present (no mark)", async () => {
    const findSpy = vi.fn().mockResolvedValue({ id: "row-1" });

    // markRecoveryCodeUsed intentionally absent.
    const h = buildRecoveryHarness({ findRecoveryCodeMatch: findSpy });

    const res = await postVerifyMfa(h.app, {
      challengeToken: h.challengeToken,
      recoveryCode: "ABCD-EFGH",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("mfa_recovery_code_invalid");
    const failEvent = h.audit.events.find(
      (e) => e.action === "auth.mfa_verify_failed",
    );
    expect(failEvent?.metadata?.reason).toBe("recovery_unconfigured");
    expect(findSpy).not.toHaveBeenCalled();
  });

  it("falls back to recovery_unconfigured when only markRecoveryCodeUsed is present (no find)", async () => {
    const markSpy = vi.fn();

    // findRecoveryCodeMatch intentionally absent.
    const h = buildRecoveryHarness({ markRecoveryCodeUsed: markSpy });

    const res = await postVerifyMfa(h.app, {
      challengeToken: h.challengeToken,
      recoveryCode: "ABCD-EFGH",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("mfa_recovery_code_invalid");
    expect(markSpy).not.toHaveBeenCalled();
  });
});

// ── brute-force counter fail-closed ──────────────────────────────────────────

describe("verify-sign-in-mfa: failure-count probe errors fail CLOSED", () => {
  it("returns 429 (not unlimited guesses) when countRecentFailures throws", async () => {
    const repo = makeMemoryRepo();
    const userId = "u_closed";
    void repo.__putUser({
      id: userId,
      emailLower: "closed@example.com",
      displayName: null,
      role: "agent",
      status: "active",
      emailVerifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // Simulate the DB probe failing — the gate this counter backs must
    // fail closed, matching checkLoginRateLimit on the password step.
    repo.countRecentFailures = async () => {
      throw new Error("db unavailable");
    };

    const probeErrors: unknown[] = [];
    const env = readAuthEnv({ AUTH_PROVIDER: "in_house" });
    const deps: AuthDeps = {
      env,
      repo,
      audit: () => {},
      email: () => {},
      publicBaseUrl: "https://example.test",
      secureCookies: false,
      mfa: {
        async findActiveSecret() {
          return { secretBase32: STUB_SECRET_BASE32, lastUsedCounter: null };
        },
        async recordVerify() {},
      },
      mfaChallengeHmacKey: HMAC_KEY,
      rateLimitOnError: (err) => {
        probeErrors.push(err);
      },
    };

    const app = express();
    app.use(express.json());
    const testLimiter = expressRateLimit({
      windowMs: 60 * 1000,
      limit: 10_000,
      standardHeaders: false,
      legacyHeaders: false,
    });
    app.post("/verify-mfa", testLimiter, makeVerifySignInMfaHandler(deps));

    const challengeToken = mintMfaChallengeToken({
      uid: userId,
      hmacKey: HMAC_KEY,
    });
    const res = await postVerifyMfa(app, {
      challengeToken,
      code: "000000",
    });

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    // The observability hook saw the probe failure.
    expect(probeErrors).toHaveLength(1);
  });
});
