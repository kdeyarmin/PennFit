// Route tests for POST /integrations/inbound/:source — production fail-closed.
//
// PR change: when NODE_ENV === "production" and the signature outcome is
// "no_secret" (no signing secret configured for the source), the route now
// returns 503 instead of accepting the payload with signature_verified=false.
//
// This closes the gap where any internet caller could seed the inbound queue
// on a production deploy if the operator forgot to set the partner's signing
// secret env var.
//
// Coverage:
//   * NODE_ENV=production + no secret (source "test" always → no_secret) → 503
//   * NODE_ENV=production + no secret (source "parachute" without env var) → 503
//   * NODE_ENV=development + no secret → 202 (dev/preview path unaffected)
//   * NODE_ENV=production + configured_bad signature → 401 (existing gate, unaffected)
//   * Non-production (NODE_ENV=test) + no secret → 202 (not fail-closed)
//
// Strategy: verifyInlineSignature is a module-private function. We
// control its output by setting/clearing PARACHUTE_SIGNING_SECRET (for
// the parachute source) or by using the "test" source (always no_secret).
// The @workspace/resupply-integrations-parachute module is mocked out so
// signature math doesn't run in tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// Mock Parachute signature verification — controls whether the source
// appears as "configured_ok" or "configured_bad".
const verifyParachuteSigMock = vi.hoisted(() =>
  vi.fn((): { ok: boolean; reason?: string } => ({
    ok: false,
    reason: "mock_bad_sig",
  })),
);
vi.mock("@workspace/resupply-integrations-parachute", () => ({
  verifyParachuteSignature: verifyParachuteSigMock,
}));

// Mock audit log — no-op to keep tests DB-free
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

// Mock logger to suppress output + allow assertions
const loggerWarnMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/logger", () => ({
  logger: {
    warn: loggerWarnMock,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import integrationsInboundRouter from "./integrations-inbound";

const VALID_PAYLOAD = JSON.stringify({ type: "order_created", id: "evt-1" });

function makeApp(): Express {
  const app = express();
  // The route uses express.raw for body parsing, which needs to be applied
  // before the router; the router itself applies it per-route.
  app.use("/resupply-api", integrationsInboundRouter);
  return app;
}

function postWebhook(
  app: Express,
  source: string,
  body: string = VALID_PAYLOAD,
  headers: Record<string, string> = {},
) {
  return request(app)
    .post(`/resupply-api/integrations/inbound/${source}`)
    .set("Content-Type", "application/json")
    .set(headers)
    .send(Buffer.from(body));
}

describe("POST /integrations/inbound/:source — production fail-closed (PR change)", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalParachuteSecret = process.env.PARACHUTE_SIGNING_SECRET;

  beforeEach(() => {
    supabaseMock.reset();
    loggerWarnMock.mockReset();
    verifyParachuteSigMock.mockReset();
    verifyParachuteSigMock.mockReturnValue({
      ok: false,
      reason: "mock_bad_sig",
    });
    // Clear secrets to ensure no_secret outcome
    delete process.env.PARACHUTE_SIGNING_SECRET;
  });

  afterEach(() => {
    // Restore original environment
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalParachuteSecret === undefined) {
      delete process.env.PARACHUTE_SIGNING_SECRET;
    } else {
      process.env.PARACHUTE_SIGNING_SECRET = originalParachuteSecret;
    }
  });

  it("returns 503 in production when source 'test' has no signing secret", async () => {
    process.env.NODE_ENV = "production";

    const res = await postWebhook(makeApp(), "test");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "signature_not_configured" });
    expect(typeof res.body.message).toBe("string");
  });

  it("returns 503 in production when 'parachute' has no signing secret env var", async () => {
    process.env.NODE_ENV = "production";
    // PARACHUTE_SIGNING_SECRET is already deleted in beforeEach

    const res = await postWebhook(makeApp(), "parachute");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "signature_not_configured" });
  });

  it("logs a warning when failing closed in production", async () => {
    process.env.NODE_ENV = "production";

    await postWebhook(makeApp(), "test");

    expect(loggerWarnMock).toHaveBeenCalled();
    const warnCall = loggerWarnMock.mock.calls.find(
      (c: unknown[]) =>
        typeof c[1] === "string" && c[1].includes("refusing unsigned webhook"),
    );
    expect(warnCall).toBeDefined();
  });

  it("does NOT return 503 in development when source has no signing secret", async () => {
    process.env.NODE_ENV = "development";
    // Stage a successful DB insert
    stageSupabaseResponse("inbound_webhooks", "insert", {
      data: null,
      error: null,
    });

    const res = await postWebhook(makeApp(), "test");
    // In dev, unsigned webhooks are accepted (signature_verified=false)
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true });
  });

  it("does NOT return 503 in test environment when source has no signing secret", async () => {
    // NODE_ENV is "test" by default in vitest
    stageSupabaseResponse("inbound_webhooks", "insert", {
      data: null,
      error: null,
    });

    const res = await postWebhook(makeApp(), "test");
    expect(res.status).toBe(202);
  });

  it("returns 401 (not 503) in production when signature is configured but bad", async () => {
    process.env.NODE_ENV = "production";
    // Set a secret so the outcome is "configured_bad", not "no_secret"
    process.env.PARACHUTE_SIGNING_SECRET = "super-secret";
    verifyParachuteSigMock.mockReturnValue({ ok: false, reason: "bad_hmac" });

    const res = await postWebhook(makeApp(), "parachute");
    // configured_bad → 401, NOT 503
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "invalid_signature" });
  });

  it("returns 202 in production when parachute signature is valid", async () => {
    process.env.NODE_ENV = "production";
    process.env.PARACHUTE_SIGNING_SECRET = "super-secret";
    verifyParachuteSigMock.mockReturnValue({ ok: true });
    stageSupabaseResponse("inbound_webhooks", "insert", {
      data: null,
      error: null,
    });

    const res = await postWebhook(makeApp(), "parachute");
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true });
  });

  it("returns 404 for unknown source in production", async () => {
    process.env.NODE_ENV = "production";

    const res = await postWebhook(makeApp(), "unknown_vendor_xyz");
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid source slug (too short) in production", async () => {
    process.env.NODE_ENV = "production";
    // "x" is only 1 char — fails the /^[a-z0-9_]{2,40}$/ pattern
    const res = await postWebhook(makeApp(), "x");
    expect(res.status).toBe(400);
  });
});
