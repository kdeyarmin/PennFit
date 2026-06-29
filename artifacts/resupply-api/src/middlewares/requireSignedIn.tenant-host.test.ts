// Cross-tenant SERVING test (multi-tenant G1, plan item 5).
//
// requireSignedIn / attachSignedIn are the shared chokepoint every
// /shop/me/* storefront + customer route runs behind. They resolve the
// tenant from the REQUEST HOST and thread that org_id into the
// customer-row resolver, so a signed-in shopper is served in the tenant
// that owns the host they hit — never a fixed seed org. These tests prove
// the serving property end-to-end through the gate:
//
//   * A request on tenant B's verified custom domain sets req.orgId to
//     tenant B and resolves/mint the shop_customers row in tenant B.
//   * A request on the platform host resolves to the seed org.
//   * The SAME signed-in user, hitting two different hosts, is served in
//     two different tenants — i.e. identity does not leak a fixed org.

import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { issueToken, type AuthDeps } from "@workspace/resupply-auth";
import {
  makeMemoryRepo,
  type MemoryRepo,
} from "@workspace/resupply-auth/test-helpers";

// Each entry is the orgId the customer resolver was invoked with, in call
// order. The resolver is what looks up / mints the shop_customers row, so
// the org it receives is the tenant the shopper is served in.
const resolverOrgIds: (string | undefined)[] = [];

let mockDeps: AuthDeps | null = null;
vi.mock("../lib/auth-deps", () => ({
  getAuthDeps: () => {
    if (!mockDeps) throw new Error("test: mockDeps not set");
    return mockDeps;
  },
  getAuthDepsOrNull: () => mockDeps,
}));

import { attachSignedIn, requireSignedIn } from "./requireSignedIn";
import { __resetTenantBrandingForTests } from "../lib/tenant-branding";

// The supabase mock stubs resolveSeedOrgId() to this fixed org.
const SEED_ORG = "00000000-0000-4000-8000-000000000000";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const TENANT_B_HOST = "shop.tenantb.com";
// `*.up.railway.app` is reserved → no custom-domain lookup → seed org.
const PLATFORM_HOST = "pennfit.up.railway.app";

function makeApp(): Express {
  const app = express();
  // Production sets `trust proxy` (Cloudflare/Railway CIDRs) so req.hostname
  // honors X-Forwarded-Host from the trusted edge. supertest connects over
  // loopback, so trust it here to model the same path; without this,
  // req.hostname would ignore the forwarded host and read the loopback Host.
  app.set("trust proxy", true);
  app.get("/protected", requireSignedIn, (req, res) => {
    res.json({
      orgId: req.orgId ?? null,
      userCustomerId: req.userCustomerId ?? null,
    });
  });
  app.get("/soft", attachSignedIn, (req, res) => {
    res.json({ orgId: req.orgId ?? null });
  });
  return app;
}

function buildDeps(): { deps: AuthDeps; repo: MemoryRepo } {
  const repo = makeMemoryRepo();
  const deps: AuthDeps = {
    env: { sessionTtlDays: 14, emailTokenTtlHours: 24 },
    repo,
    audit: () => {},
    email: () => {},
    publicBaseUrl: "https://example.test",
    secureCookies: false,
    allowSignUp: true,
    // Capture the tenant each resolution runs in; return a stable key so
    // the gate admits the request.
    customerIdResolver: async (input) => {
      resolverOrgIds.push(input.orgId);
      return {
        customerKey: `cust_${input.authUserId}`,
        email: input.emailLower,
        displayName: input.displayName,
      };
    },
  };
  return { deps, repo };
}

async function seedSignedIn(
  repo: MemoryRepo,
  id: string,
): Promise<{ cookie: string }> {
  repo.__putUser({
    id,
    emailLower: `${id}@example.com`,
    displayName: null,
    role: "customer",
    status: "active",
    emailVerifiedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const tok = issueToken();
  await repo.insertSession({
    tokenHash: tok.hash,
    userId: id,
    expiresAt: new Date(Date.now() + 60_000),
    ip: null,
    userAgentHash: null,
  });
  return { cookie: `pf_session=${tok.raw}` };
}

describe("requireSignedIn — serves the host's tenant (G1 item 5)", () => {
  beforeEach(() => {
    mockDeps = null;
    resolverOrgIds.length = 0;
    supabaseMock.reset();
    __resetTenantBrandingForTests();
  });

  afterEach(() => {
    mockDeps = null;
  });

  it("resolves req.orgId + the customer row to tenant B on tenant B's verified host", async () => {
    const { deps, repo } = buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedIn(repo, "u_1");
    // tenant B owns the verified custom domain.
    stageSupabaseResponse("organizations", "select", {
      data: { id: TENANT_B },
    });

    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie)
      .set("X-Forwarded-Host", TENANT_B_HOST);

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(TENANT_B);
    expect(res.body.userCustomerId).toBe("cust_u_1");
    // The customer row was resolved/minted in tenant B, not the seed org.
    expect(resolverOrgIds).toEqual([TENANT_B]);
  });

  it("resolves req.orgId to the seed org on the platform host", async () => {
    const { deps, repo } = buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedIn(repo, "u_2");

    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie)
      .set("X-Forwarded-Host", PLATFORM_HOST);

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(SEED_ORG);
    expect(resolverOrgIds).toEqual([SEED_ORG]);
  });

  it("serves the SAME signed-in user in different tenants by host (no fixed-org leak)", async () => {
    const { deps, repo } = buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedIn(repo, "u_3");
    stageSupabaseResponse("organizations", "select", {
      data: { id: TENANT_B },
    });

    const onTenantB = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie)
      .set("X-Forwarded-Host", TENANT_B_HOST);
    const onPlatform = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie)
      .set("X-Forwarded-Host", PLATFORM_HOST);

    expect(onTenantB.body.orgId).toBe(TENANT_B);
    expect(onPlatform.body.orgId).toBe(SEED_ORG);
    expect(resolverOrgIds).toEqual([TENANT_B, SEED_ORG]);
  });

  it("attachSignedIn (soft) also serves the host's tenant", async () => {
    const { deps, repo } = buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedIn(repo, "u_4");
    stageSupabaseResponse("organizations", "select", {
      data: { id: TENANT_B },
    });

    const res = await request(makeApp())
      .get("/soft")
      .set("Cookie", cookie)
      .set("X-Forwarded-Host", TENANT_B_HOST);

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(TENANT_B);
    expect(resolverOrgIds).toEqual([TENANT_B]);
  });
});
