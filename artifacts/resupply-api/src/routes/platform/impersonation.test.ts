// Platform impersonation routes — start (act-as) and stop.
//
// The gate is mocked (covered by requirePlatformAdmin-in-house.test.ts)
// and the auth repo is a controllable stub; the real cookie/token helpers
// from resupply-auth run unmocked.

import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { issueToken } from "@workspace/resupply-auth";

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

// Controllable directory lookup + auth repo.
const { state } = vi.hoisted(() => ({
  state: {
    orgLookup: null as { id: string; slug: string } | null,
    inserted: [] as unknown[],
    sessionLookup: null as {
      id: string;
      expiresAt: Date;
      revokedAt: Date | null;
      impersonatedOrgId: string | null;
      impersonatorUserId: string | null;
    } | null,
    revoked: [] as string[],
  },
}));

vi.mock("@workspace/resupply-db", () => ({
  resolveSeedOrgId: async () => "00000000-0000-4000-8000-000000000000",
  getOrgScopedClient: () => ({
    raw: () => ({
      schema: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: async () => ({
                  data: state.orgLookup,
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("../../lib/auth-deps", () => ({
  getAuthDeps: () => ({
    secureCookies: false,
    repo: {
      insertSession: async (input: unknown) => {
        state.inserted.push(input);
        return { id: "sess_1" };
      },
      findSessionByTokenHash: async () => state.sessionLookup,
      revokeSession: async (id: string) => {
        state.revoked.push(id);
      },
    },
  }),
}));

import impersonationRouter from "./impersonation";

const TARGET_ORG = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(impersonationRouter);
  return app;
}

beforeEach(() => {
  mockPlatformAdmin.current = null;
  state.orgLookup = null;
  state.inserted = [];
  state.sessionLookup = null;
  state.revoked = [];
});

describe("POST /platform/tenants/:id/impersonate", () => {
  it("401s when the caller is not a platform admin", async () => {
    const res = await request(makeApp()).post(
      `/platform/tenants/${TARGET_ORG}/impersonate`,
    );
    expect(res.status).toBe(401);
  });

  it("400s on a non-uuid id", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    const res = await request(makeApp()).post(
      "/platform/tenants/not-a-uuid/impersonate",
    );
    expect(res.status).toBe(400);
  });

  it("404s when the target tenant does not exist", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    state.orgLookup = null;
    const res = await request(makeApp()).post(
      `/platform/tenants/${TARGET_ORG}/impersonate`,
    );
    expect(res.status).toBe(404);
  });

  it("mints an impersonation session + sets the cookie", async () => {
    mockPlatformAdmin.current = { userId: "u_platform", email: "ops@cm" };
    state.orgLookup = { id: TARGET_ORG, slug: "acme-dme" };

    const res = await request(makeApp()).post(
      `/platform/tenants/${TARGET_ORG}/impersonate`,
    );

    expect(res.status).toBe(200);
    expect(res.body.impersonatingOrgId).toBe(TARGET_ORG);
    // A pf_session cookie was set.
    const cookies = res.headers["set-cookie"] as unknown as string[];
    expect(cookies.some((c) => c.startsWith("pf_session="))).toBe(true);
    // The session row carries the impersonation context.
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      userId: "u_platform",
      impersonatedOrgId: TARGET_ORG,
      impersonatorUserId: "u_platform",
    });
  });
});

describe("POST /platform/impersonation/stop", () => {
  it("revokes an active impersonation session and clears the cookie", async () => {
    state.sessionLookup = {
      id: "sess_1",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      impersonatedOrgId: TARGET_ORG,
      impersonatorUserId: "u_platform",
    };
    const res = await request(makeApp())
      .post("/platform/impersonation/stop")
      .set("Cookie", `pf_session=${issueToken().raw}`);

    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(true);
    expect(state.revoked).toContain("sess_1");
    const cookies = res.headers["set-cookie"] as unknown as string[];
    expect(cookies.some((c) => c.startsWith("pf_session="))).toBe(true);
  });

  it("is a safe no-op (200) when there is no session cookie", async () => {
    const res = await request(makeApp()).post("/platform/impersonation/stop");
    expect(res.status).toBe(200);
    expect(state.revoked).toHaveLength(0);
  });

  it("does NOT revoke a normal (non-impersonation) session", async () => {
    state.sessionLookup = {
      id: "sess_normal",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      impersonatedOrgId: null,
      impersonatorUserId: null,
    };
    const res = await request(makeApp())
      .post("/platform/impersonation/stop")
      .set("Cookie", `pf_session=${issueToken().raw}`);
    expect(res.status).toBe(200);
    // A normal session must not be revoked by the stop endpoint.
    expect(state.revoked).toHaveLength(0);
  });
});
