// Platform identity probe — /platform/me.
//
// The gate is mocked (its own behavior is covered by
// requirePlatformAdmin-in-house.test.ts); this asserts the handler echoes
// the resolved platform admin's identity on success and that the gate's
// 401 pass through.

import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import meRouter from "./me";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(meRouter);
  return app;
}

beforeEach(() => {
  mockPlatformAdmin.current = null;
});

describe("GET /platform/me", () => {
  it("401s when the caller is not a platform admin", async () => {
    const res = await request(makeApp()).get("/platform/me");
    expect(res.status).toBe(401);
  });

  it("returns the platform admin's identity on success", async () => {
    mockPlatformAdmin.current = { userId: "u_platform", email: "ops@cm" };
    const res = await request(makeApp()).get("/platform/me");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: "u_platform", email: "ops@cm" });
  });
});
