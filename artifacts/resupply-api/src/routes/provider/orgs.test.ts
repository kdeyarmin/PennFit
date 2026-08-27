// Tests for GET /api/provider/orgs + POST /api/provider/orgs/select.

import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const PROVIDER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
const LINK_A = "cccccccc-0000-4000-8000-000000000001";
const LINK_B = "dddddddd-0000-4000-8000-000000000002";

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const resolveTenantLinkBaseUrlMock = vi.hoisted(() =>
  vi.fn(async (orgId: string, _platform: string): Promise<string | null> => {
    if (orgId === ORG_A) return "https://pennpaps.example";
    return null;
  }),
);
vi.mock("../../lib/tenant-branding", () => ({
  resolveTenantLinkBaseUrl: resolveTenantLinkBaseUrlMock,
  resolveBrandOrgIdByHost: vi.fn(async () => null),
}));

const findSessionByIdMock = vi.hoisted(() =>
  vi.fn(async (_id: string) => ({
    providerActiveOrgId: null as string | null,
  })),
);
const setProviderActiveOrgIdMock = vi.hoisted(() =>
  vi.fn(async (_id: string, _orgId: string | null) => undefined),
);
vi.mock("../../lib/auth-deps", () => ({
  getAuthDeps: () => ({
    publicBaseUrl: "https://cmbreathe.example",
    repo: {
      findSessionById: findSessionByIdMock,
      setProviderActiveOrgId: setProviderActiveOrgIdMock,
    },
  }),
}));

vi.mock("../../middlewares/requireProvider", () => ({
  requireProvider: [
    (
      req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) => {
      req.providerAccount = {
        id: ACCOUNT_ID,
        providerId: PROVIDER_ID,
        emailLower: "dr@example.com",
        status: "active",
        mfaEnrolledAt: "2026-01-01T00:00:00.000Z",
      };
      req.authSessionId = SESSION_ID;
      next();
    },
  ],
}));

import orgsRouter from "./orgs";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(orgsRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  resolveTenantLinkBaseUrlMock.mockClear();
  findSessionByIdMock.mockReset();
  findSessionByIdMock.mockResolvedValue({ providerActiveOrgId: null });
  setProviderActiveOrgIdMock.mockReset();
  setProviderActiveOrgIdMock.mockResolvedValue(undefined);
});

describe("GET /api/provider/orgs", () => {
  it("lists active DME links with portal URLs and activeOrgId", async () => {
    findSessionByIdMock.mockResolvedValueOnce({ providerActiveOrgId: ORG_A });
    stageSupabaseResponse("provider_dme_links", "select", {
      data: [
        {
          id: LINK_A,
          org_id: ORG_A,
          display_name: null,
          status: "active",
          organizations: { name: "Penn Home Medical Supply" },
        },
        {
          id: LINK_B,
          org_id: ORG_B,
          display_name: "Acme Sleep",
          status: "active",
          organizations: { name: "Acme DME" },
        },
      ],
    });

    const res = await request(makeApp()).get("/api/provider/orgs");
    expect(res.status).toBe(200);
    expect(res.body.activeOrgId).toBe(ORG_A);
    expect(res.body.orgs).toEqual([
      {
        orgId: ORG_A,
        dmeLinkId: LINK_A,
        name: "Penn Home Medical Supply",
        portalBaseUrl: "https://pennpaps.example",
        portalUrl: "https://pennpaps.example/provider",
        hasVerifiedPortal: true,
        isActive: true,
      },
      {
        orgId: ORG_B,
        dmeLinkId: LINK_B,
        name: "Acme Sleep",
        portalBaseUrl: null,
        portalUrl: null,
        hasVerifiedPortal: false,
        isActive: false,
      },
    ]);
    expect(resolveTenantLinkBaseUrlMock).toHaveBeenCalledWith(
      ORG_A,
      "https://cmbreathe.example",
    );
  });

  it("returns an empty list when the provider has no DME links", async () => {
    stageSupabaseResponse("provider_dme_links", "select", { data: [] });
    const res = await request(makeApp()).get("/api/provider/orgs");
    expect(res.status).toBe(200);
    expect(res.body.orgs).toEqual([]);
    expect(res.body.activeOrgId).toBeNull();
  });
});

describe("POST /api/provider/orgs/select", () => {
  it("pins a membership-validated org on the session", async () => {
    stageSupabaseResponse("provider_dme_links", "select", {
      data: { id: LINK_A },
    });

    const res = await request(makeApp())
      .post("/api/provider/orgs/select")
      .send({ orgId: ORG_A });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ activeOrgId: ORG_A });
    expect(setProviderActiveOrgIdMock).toHaveBeenCalledWith(SESSION_ID, ORG_A);
  });

  it("refuses an org the provider is not linked to", async () => {
    stageSupabaseResponse("provider_dme_links", "select", { data: null });

    const res = await request(makeApp())
      .post("/api/provider/orgs/select")
      .send({ orgId: ORG_B });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_a_member");
    expect(setProviderActiveOrgIdMock).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid orgId", async () => {
    const res = await request(makeApp())
      .post("/api/provider/orgs/select")
      .send({ orgId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});
