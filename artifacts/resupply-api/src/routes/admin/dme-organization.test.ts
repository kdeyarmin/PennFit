// Route tests for /admin/dme-organization — per-tenant billing identity.
//
// Regression guard for the multi-tenant fix: the Company Information CRUD
// must scope by org_id (migration 0375 dropped the global `singleton`
// uniqueness), NOT by the legacy `singleton` flag — otherwise a second
// tenant's save would read/UPDATE the seed tenant's billing identity, and a
// fresh insert would land an org_id-less row.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  MOCK_ORG_ID,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({ logAudit: logAuditMock }));

// The post-save env re-hydration is fail-soft and not under test; stub it so
// the test doesn't depend on company-info's seed lookup.
vi.mock("../../lib/company-info", async () => {
  const actual = await vi.importActual<typeof import("../../lib/company-info")>(
    "../../lib/company-info",
  );
  return {
    ...actual,
    applyCompanyInfoToEnv: vi.fn(async () => undefined),
    invalidateCompanyInfoCache: vi.fn(() => undefined),
  };
});

import dmeOrganizationRouter from "./dme-organization";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "owner@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(dmeOrganizationRouter);
  return app;
}

const VALID_BODY = {
  legalName: "Second Tenant DME LLC",
  taxId: "123456789",
  organizationalNpi: "1234567890",
  physicalAddressLine1: "1 Main St",
  physicalCity: "Erie",
  physicalState: "PA",
  physicalZip: "16501",
  phoneE164: "+18145551234",
  billingEmail: "billing@tenant2.example",
};

beforeEach(() => {
  mockAdmin.current = ADMIN; // req.orgId defaults to MOCK_ORG_ID
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("PUT /admin/dme-organization", () => {
  it("stamps the caller's org_id on a fresh insert (not the legacy singleton)", async () => {
    // No existing row for this tenant → insert path.
    stageSupabaseResponse("dme_organization", "select", { data: null });
    stageSupabaseResponse("dme_organization", "insert", {
      data: { id: "org-row-2" },
    });

    const res = await request(makeApp())
      .put("/admin/dme-organization")
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "org-row-2", created: true });

    const inserts = getSupabaseWritePayloads(
      "dme_organization",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(inserts).toHaveLength(1);
    // The security-critical assertion: the row carries THIS tenant's org_id,
    // so it can never collide with / overwrite the seed tenant's identity.
    expect(inserts[0]?.org_id).toBe(MOCK_ORG_ID);
    expect(inserts[0]?.legal_name).toBe("Second Tenant DME LLC");
  });

  it("updates the existing row for the caller's tenant", async () => {
    // An existing row resolves for this tenant → update path.
    stageSupabaseResponse("dme_organization", "select", {
      data: { id: "org-row-2" },
    });
    stageSupabaseResponse("dme_organization", "update", { data: [] });

    const res = await request(makeApp())
      .put("/admin/dme-organization")
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "org-row-2", created: false });
  });
});
