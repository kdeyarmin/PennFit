import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// We mock the readiness module wholesale rather than the underlying
// pg pool. Two reasons: (1) the readiness logic itself has its own
// unit coverage in readiness.test.ts (added alongside), and (2) the
// route's job is purely "call checkReadiness, map status to HTTP
// code" — mocking at the seam keeps these route tests fast and
// network-free.
vi.mock("../lib/readiness", () => ({
  checkReadiness: vi.fn(),
}));

import healthRouter from "./health";
import { checkReadiness } from "../lib/readiness";

function makeApp(): express.Express {
  const app = express();
  app.use(healthRouter);
  return app;
}

describe("GET /healthz", () => {
  it("returns 200 with the liveness payload and never invokes readiness checks", async () => {
    const app = makeApp();
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "resupply-api" });
    // Liveness must not cascade into the dependency graph — that's
    // /readyz's job. If this regresses, the deploy gate's liveness
    // probe will start failing on transient DB blips.
    expect(checkReadiness).not.toHaveBeenCalled();
  });
});

describe("GET /readyz", () => {
  beforeEach(() => {
    vi.mocked(checkReadiness).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 when every dependency is reachable", async () => {
    vi.mocked(checkReadiness).mockResolvedValue({
      status: "ready",
      checks: { db: "ok", queue: "ok" },
    });
    const res = await request(makeApp()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ready",
      checks: { db: "ok", queue: "ok" },
    });
    // Errors must NOT be present on a successful readiness response.
    expect(res.body).not.toHaveProperty("errors");
  });

  it("returns 503 with structured per-dependency failures when the DB is down", async () => {
    vi.mocked(checkReadiness).mockResolvedValue({
      status: "not_ready",
      checks: { db: "failed", queue: "ok" },
      errors: { db: "connection_refused" },
    });
    const res = await request(makeApp()).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "not_ready",
      checks: { db: "failed", queue: "ok" },
      errors: { db: "connection_refused" },
    });
  });

  it("returns 503 when the pg-boss schema is missing", async () => {
    vi.mocked(checkReadiness).mockResolvedValue({
      status: "not_ready",
      checks: { db: "ok", queue: "failed" },
      errors: { queue: "schema_not_initialized" },
    });
    const res = await request(makeApp()).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.checks.queue).toBe("failed");
    expect(res.body.errors.queue).toBe("schema_not_initialized");
  });

  it("falls back to a safe structured 503 if checkReadiness unexpectedly throws", async () => {
    // Defense-in-depth: checkReadiness is contractually never-throw,
    // but if a future regression breaks that, we must NOT fall
    // through to Express's default error handler — that would either
    // return an unstructured 500 or leak the raw error.
    vi.mocked(checkReadiness).mockRejectedValue(
      new Error("unexpected internal failure with secret content"),
    );
    const res = await request(makeApp()).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "not_ready",
      checks: { db: "failed", queue: "failed" },
      errors: { db: "unavailable", queue: "unavailable" },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/secret content/);
  });

  it("only ever returns error categories from the closed allowlist", async () => {
    // Regression guard: if someone widens checkReadiness to surface
    // raw driver text or some new ad-hoc string, this fails. The
    // allowlist must stay in sync with the CheckError enum in
    // lib/resupply-api-spec/openapi.yaml.
    const ALLOWED = new Set([
      "timeout",
      "connection_refused",
      "host_not_found",
      "schema_not_initialized",
      "database_starting_up",
      "database_does_not_exist",
      "unavailable",
    ]);
    const scenarios = [
      { db: "connection_refused" as const },
      { queue: "schema_not_initialized" as const },
      { db: "timeout" as const, queue: "unavailable" as const },
      { db: "host_not_found" as const },
      { queue: "database_starting_up" as const },
    ];
    for (const errors of scenarios) {
      vi.mocked(checkReadiness).mockResolvedValue({
        status: "not_ready",
        checks: {
          db: errors.db ? "failed" : "ok",
          queue: errors.queue ? "failed" : "ok",
        },
        errors,
      });
      const res = await request(makeApp()).get("/readyz");
      expect(res.status).toBe(503);
      for (const value of Object.values(res.body.errors ?? {})) {
        expect(ALLOWED.has(value as string)).toBe(true);
      }
    }
  });

  it("never includes raw connection-string fragments in the response body", async () => {
    // Regression guard: if someone wires checkReadiness to surface
    // raw error.message text, this assertion catches the leak before
    // it hits prod.
    vi.mocked(checkReadiness).mockResolvedValue({
      status: "not_ready",
      checks: { db: "failed", queue: "ok" },
      errors: { db: "connection_refused" },
    });
    const res = await request(makeApp()).get("/readyz");
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/postgres:\/\//i);
    expect(body).not.toMatch(/password/i);
    expect(body).not.toMatch(/DATABASE_URL/);
  });
});
