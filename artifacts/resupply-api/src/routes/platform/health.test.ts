// GET /platform/health — platform-operator health snapshot.
//
// The gate (requirePlatformAdmin) and the readiness probe itself have
// their own focused tests; here we cover the route contract: the gate,
// the readiness pass-through, and the env-driven vendor flags.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequirePlatformAdminMock,
  type MockPlatformAdminRef,
} from "../../test-helpers/auth-mocks";

const { mockPlatformAdmin } = vi.hoisted(() => ({
  mockPlatformAdmin: { current: null } as MockPlatformAdminRef,
}));
vi.mock("../../middlewares/requirePlatformAdmin", () =>
  makeRequirePlatformAdminMock(mockPlatformAdmin),
);

const { readinessRef } = vi.hoisted(() => ({
  readinessRef: {
    current: { status: "ready", checks: { db: "ok", queue: "ok" } } as {
      status: string;
      checks: { db: string; queue: string };
      errors?: Record<string, string>;
    },
  },
}));
vi.mock("../../lib/readiness", () => ({
  checkReadiness: vi.fn(async () => readinessRef.current),
}));

import healthRouter from "./health";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(healthRouter);
  return app;
}

beforeEach(() => {
  mockPlatformAdmin.current = null;
  readinessRef.current = { status: "ready", checks: { db: "ok", queue: "ok" } };
});

describe("GET /platform/health", () => {
  it("401s when the caller is not a platform admin", async () => {
    const res = await request(makeApp()).get("/platform/health");
    expect(res.status).toBe(401);
  });

  it("returns readiness + vendor wiring for a platform admin", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    const res = await request(makeApp()).get("/platform/health");
    expect(res.status).toBe(200);
    expect(res.body.readiness.status).toBe("ready");
    expect(res.body.readiness.checks).toMatchObject({ db: "ok", queue: "ok" });
    expect(typeof res.body.readiness.latencyMs).toBe("number");
    expect(res.body.vendors).toHaveProperty("ai");
    expect(res.body.vendors).toHaveProperty("comms");
    expect(res.body.vendors).toHaveProperty("payments");
    expect(typeof res.body.vendors.storage).toBe("boolean");
  });

  it("passes through a degraded readiness result", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    readinessRef.current = {
      status: "not_ready",
      checks: { db: "failed", queue: "ok" },
      errors: { db: "timeout" },
    };
    const res = await request(makeApp()).get("/platform/health");
    expect(res.status).toBe(200);
    expect(res.body.readiness.status).toBe("not_ready");
    expect(res.body.readiness.checks.db).toBe("failed");
    expect(res.body.readiness.errors).toMatchObject({ db: "timeout" });
  });

  it("reflects a vendor credential present in the environment", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const res = await request(makeApp()).get("/platform/health");
    expect(res.body.vendors.ai.anthropic).toBe(true);
    vi.unstubAllEnvs();
  });
});
