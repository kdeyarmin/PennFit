import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../middlewares/requireAdmin", () => ({
  requireAdminOnly: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import adminUsersRouter from "./admin-users";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(adminUsersRouter);
  return app;
}

const disabledBody = {
  error: "legacy_team_api_disabled",
  message: "Use /resupply-api/admin/team for staff management.",
};

describe("legacy /admin/users routes", () => {
  it("disables the legacy roster endpoint", async () => {
    const res = await request(makeApp()).get("/admin/users");

    expect(res.status).toBe(410);
    expect(res.body).toEqual(disabledBody);
  });

  it.each([
    ["post", "/admin/users/invite"],
    ["patch", "/admin/users/user-123/role"],
    ["delete", "/admin/users/user-456"],
    ["delete", "/admin/users/invitations/inv-789"],
  ] as const)("disables %s %s", async (method, path) => {
    const res = await request(makeApp())[method](path).send({
      email: "new@example.com",
      role: "agent",
    });

    expect(res.status).toBe(410);
    expect(res.body).toEqual(disabledBody);
  });
});
