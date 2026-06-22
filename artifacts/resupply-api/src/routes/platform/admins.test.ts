// /platform/admins — the platform operator roster.
//
// The gate (requirePlatformAdmin) and the auth repo have their own tests;
// here we cover the route contract: the gate, identity resolution, and the
// grant/revoke guards (elevate-existing-only, no self-removal, no last
// operator).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequirePlatformAdminMock,
  type MockPlatformAdminRef,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockPlatformAdmin } = vi.hoisted(() => ({
  mockPlatformAdmin: { current: null } as MockPlatformAdminRef,
}));
vi.mock("../../middlewares/requirePlatformAdmin", () =>
  makeRequirePlatformAdminMock(mockPlatformAdmin),
);

const { authRepo } = vi.hoisted(() => ({
  authRepo: {
    findUserById: vi.fn(),
    findUserByEmail: vi.fn(),
  },
}));
vi.mock("../../lib/auth-deps", () => ({
  getAuthDeps: () => ({ repo: authRepo }),
}));

import adminsRouter from "./admins";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(adminsRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  mockPlatformAdmin.current = null;
  authRepo.findUserById.mockReset();
  authRepo.findUserByEmail.mockReset();
});

describe("GET /platform/admins", () => {
  it("401s for a non-platform-admin", async () => {
    const res = await request(makeApp()).get("/platform/admins");
    expect(res.status).toBe(401);
  });

  it("lists operators with resolved identities", async () => {
    mockPlatformAdmin.current = { userId: "u_self", email: "me@cm" };
    stageSupabaseResponse("platform_admins", "select", {
      data: [
        {
          auth_user_id: "u_self",
          granted_by_email: "migration:0355",
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          auth_user_id: "u_two",
          granted_by_email: "me@cm",
          created_at: "2026-02-01T00:00:00Z",
        },
      ],
    });
    authRepo.findUserById.mockImplementation(async (id: string) =>
      id === "u_self"
        ? {
            id,
            emailLower: "me@cm",
            displayName: "Me",
            status: "active",
          }
        : { id, emailLower: "two@cm", displayName: null, status: "active" },
    );

    const res = await request(makeApp()).get("/platform/admins");
    expect(res.status).toBe(200);
    expect(res.body.operators).toHaveLength(2);
    expect(res.body.operators[0]).toMatchObject({
      authUserId: "u_self",
      email: "me@cm",
    });
    expect(res.body.operators[1]).toMatchObject({
      authUserId: "u_two",
      email: "two@cm",
    });
  });
});

describe("POST /platform/admins (grant)", () => {
  it("400s on an invalid email", async () => {
    mockPlatformAdmin.current = { userId: "u_self", email: "me@cm" };
    const res = await request(makeApp())
      .post("/platform/admins")
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("404s when no auth user has that email (elevate-existing-only)", async () => {
    mockPlatformAdmin.current = { userId: "u_self", email: "me@cm" };
    authRepo.findUserByEmail.mockResolvedValue(null);
    const res = await request(makeApp())
      .post("/platform/admins")
      .send({ email: "ghost@example.com" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_such_user");
  });

  it("grants platform access to an existing user (201)", async () => {
    mockPlatformAdmin.current = { userId: "u_self", email: "me@cm" };
    authRepo.findUserByEmail.mockResolvedValue({
      id: "u_new",
      emailLower: "new@example.com",
      displayName: "New Op",
      status: "active",
    });
    stageSupabaseResponse("platform_admins", "upsert", { error: null });
    const res = await request(makeApp())
      .post("/platform/admins")
      .send({ email: "new@example.com" });
    expect(res.status).toBe(201);
    expect(res.body.operator).toMatchObject({
      authUserId: "u_new",
      email: "new@example.com",
    });
    const upserts = supabaseMock.writePayloads("platform_admins", "upsert");
    expect((upserts[0] as { auth_user_id: string }).auth_user_id).toBe("u_new");
  });
});

describe("DELETE /platform/admins/:authUserId (revoke)", () => {
  it("refuses to remove yourself", async () => {
    mockPlatformAdmin.current = { userId: "u_self", email: "me@cm" };
    const res = await request(makeApp()).delete("/platform/admins/u_self");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("cannot_remove_self");
  });

  it("refuses to remove the last operator", async () => {
    mockPlatformAdmin.current = { userId: "u_self", email: "me@cm" };
    stageSupabaseResponse("platform_admins", "select", {
      count: 1,
      data: null,
    });
    const res = await request(makeApp()).delete("/platform/admins/u_other");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("cannot_remove_last_operator");
  });

  it("revokes an operator when more than one remains", async () => {
    mockPlatformAdmin.current = { userId: "u_self", email: "me@cm" };
    // 1) count head query, 2) existence check, then the delete.
    stageSupabaseResponse("platform_admins", "select", {
      count: 2,
      data: null,
    });
    stageSupabaseResponse("platform_admins", "select", {
      data: { auth_user_id: "u_other" },
    });
    stageSupabaseResponse("platform_admins", "delete", { error: null });
    const res = await request(makeApp()).delete("/platform/admins/u_other");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, removed: "u_other" });
  });

  it("404s when the operator id isn't on the roster", async () => {
    mockPlatformAdmin.current = { userId: "u_self", email: "me@cm" };
    stageSupabaseResponse("platform_admins", "select", {
      count: 2,
      data: null,
    });
    stageSupabaseResponse("platform_admins", "select", { data: null });
    const res = await request(makeApp()).delete("/platform/admins/u_ghost");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("operator_not_found");
  });
});
