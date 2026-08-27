import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const PROVIDER_ID = "33333333-3333-4333-8333-333333333333";

const verifyProviderPortalTokenMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/provider-portal-token", () => ({
  verifyProviderPortalToken: verifyProviderPortalTokenMock,
}));

const getOrgScopedClientMock = vi.hoisted(() => vi.fn());
vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: getOrgScopedClientMock,
  resolveSeedOrgId: vi.fn(async () => ORG_A),
}));

import providerPortalRouter from "./provider-portal";

function makeApp(): Express {
  const app = express();
  app.use(providerPortalRouter);
  return app;
}

describe("GET /provider-portal/:token", () => {
  beforeEach(() => {
    verifyProviderPortalTokenMock.mockReset();
    getOrgScopedClientMock.mockReset();
  });

  it("rejects legacy tokens that omit minting org id", async () => {
    verifyProviderPortalTokenMock.mockReturnValue({
      valid: true,
      providerId: PROVIDER_ID,
      version: 0,
      orgId: null,
    });

    const res = await request(makeApp()).get("/provider-portal/legacy-token");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("token_requires_reissue");
    expect(getOrgScopedClientMock).not.toHaveBeenCalled();
  });
});
