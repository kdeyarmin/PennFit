// Multi-tenant scoping tests for the provider e-signature portal.
//
// The portal reads/writes `provider_signature_requests` — an org-scoped
// TENANT table (it has `org_id`, read via the raw client + a MANUAL
// `.eq("org_id", …)` filter). A provider arriving on a verified
// custom-domain tenant must query THAT tenant's signature queue, not the
// seed org's. These tests prove:
//
//   1. A provider on tenant-A's host scopes its `provider_signature_requests`
//      read to tenant-A's org_id (NOT the seed org / tenant-B's).
//   2. The platform host (host resolves to no tenant) falls back to the seed
//      org — byte-for-byte the historical single-tenant behavior.
//   3. Provider isolation still holds — every read carries the
//      `.eq("provider_id", …)` filter for the signed-in provider.
//   4. The MFA gate still applies to the PHI-bearing data routes.
//
// We mock `resolveOrgIdByHost` (host → org) and let the shared Supabase
// mock stub `resolveSeedOrgId` to a fixed seed org. The mock captures the
// `.eq(...)` filters applied to each (table, op) so we can assert the
// org_id the route actually scoped to.

import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// The seed org the shared Supabase mock pins `resolveSeedOrgId()` to.
const SEED_ORG = "00000000-0000-4000-8000-000000000000";
const TENANT_A_ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const PROVIDER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Host → org resolver. Default: no tenant resolves (platform host).
const resolveOrgIdByHostMock = vi.hoisted(() =>
  vi.fn(async (_host: string): Promise<string | null> => null),
);
vi.mock("../../lib/tenant-branding", () => ({
  resolveOrgIdByHost: resolveOrgIdByHostMock,
}));

// Append-only signature-event log — exercised by the view side effect.
// No-op so we don't have to stage its DB round-trips; it isn't under test.
const appendSignatureEventMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../lib/provider-portal/signature-events", () => ({
  appendSignatureEvent: appendSignatureEventMock,
}));

// Stand in for the real provider gate: inject a fixed provider account and
// pass through. Lets us drive the route bodies without the session/CSRF/
// account-lookup plumbing (covered by the middleware's own tests). The MFA
// gate is mocked separately so tests can flip it on/off.
const mfaEnrolledMock = vi.hoisted(() => ({ value: true }));
vi.mock("../../middlewares/requireProvider", () => ({
  requireProvider: [
    (
      req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) => {
      (req as express.Request).providerAccount = {
        id: ACCOUNT_ID,
        providerId: PROVIDER_ID,
        emailLower: "dr@example.com",
        status: "active",
        mfaEnrolledAt: "2026-01-01T00:00:00.000Z",
      };
      next();
    },
  ],
  requireProviderMfaEnrolled: (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!mfaEnrolledMock.value) {
      res.status(403).json({ error: "mfa_enrollment_required" });
      return;
    }
    next();
  },
}));

import portalRouter from "./portal";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(portalRouter);
  return app;
}

/** The org_id value the route applied as an `.eq("org_id", …)` filter on
 *  the given `provider_signature_requests` operation, or undefined. */
function orgFilterValue(op: "select" | "update"): unknown {
  const calls = supabaseMock.filterCalls("provider_signature_requests", op);
  return calls.find((c) => c.verb === "eq" && c.args[0] === "org_id")?.args[1];
}

/** The provider_id value the route applied as an `.eq("provider_id", …)`
 *  filter on the given operation, or undefined. */
function providerFilterValue(op: "select" | "update"): unknown {
  const calls = supabaseMock.filterCalls("provider_signature_requests", op);
  return calls.find((c) => c.verb === "eq" && c.args[0] === "provider_id")
    ?.args[1];
}

beforeEach(() => {
  supabaseMock.reset();
  resolveOrgIdByHostMock.mockReset();
  resolveOrgIdByHostMock.mockResolvedValue(null);
  appendSignatureEventMock.mockReset();
  appendSignatureEventMock.mockResolvedValue(undefined);
  mfaEnrolledMock.value = true;
});

describe("provider portal — multi-tenant scoping of the signature queue", () => {
  it("scopes the queue read to the HOST tenant's org, not the seed org", async () => {
    resolveOrgIdByHostMock.mockResolvedValueOnce(TENANT_A_ORG);
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: [],
    });

    const res = await request(makeApp())
      .get("/api/provider/queue")
      .set("Host", "tenant-a.example.com");

    expect(res.status).toBe(200);
    // Host resolved → tenant A's org, NOT the seed org.
    expect(orgFilterValue("select")).toBe(TENANT_A_ORG);
    expect(orgFilterValue("select")).not.toBe(SEED_ORG);
    // Provider isolation preserved.
    expect(providerFilterValue("select")).toBe(PROVIDER_ID);
    // The host actually fed the resolver.
    expect(resolveOrgIdByHostMock).toHaveBeenCalledWith("tenant-a.example.com");
  });

  it("falls back to the SEED org on the platform host (no tenant resolved)", async () => {
    // Default mock returns null → seed-org fallback (unchanged behavior).
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: [],
    });

    const res = await request(makeApp())
      .get("/api/provider/queue")
      .set("Host", "cmbreathe.com");

    expect(res.status).toBe(200);
    // No tenant resolved → seed org, exactly as before the fix.
    expect(orgFilterValue("select")).toBe(SEED_ORG);
    expect(providerFilterValue("select")).toBe(PROVIDER_ID);
  });

  it("scopes the /me pending count to the host tenant's org", async () => {
    resolveOrgIdByHostMock.mockResolvedValueOnce(TENANT_A_ORG);
    // /me reads provider_portal_accounts (update), providers (select),
    // then counts provider_signature_requests (select). Only the last is
    // org-scoped; the count value flows through unset → defaults fine.
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: null,
      count: 0,
    });

    const res = await request(makeApp())
      .get("/api/provider/me")
      .set("Host", "tenant-a.example.com");

    expect(res.status).toBe(200);
    expect(orgFilterValue("select")).toBe(TENANT_A_ORG);
    expect(providerFilterValue("select")).toBe(PROVIDER_ID);
  });

  it("does NOT return another tenant's documents: a row under a different org is filtered out by org_id", async () => {
    // The route asks for tenant-A's org; a tenant-B row would never come
    // back from PostgREST because of the org_id filter. We assert the
    // route applied tenant-A's org filter (the mechanism that excludes B).
    resolveOrgIdByHostMock.mockResolvedValueOnce(TENANT_A_ORG);
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: [
        {
          id: REQUEST_ID,
          subject_type: "prescription",
          subject_id: "s1",
          title: "Rx",
          patient_name_snapshot: "Pat",
          detail: null,
          status: "pending",
          created_at: "2026-01-01T00:00:00.000Z",
          expires_at: null,
          signed_at: null,
        },
      ],
    });

    const res = await request(makeApp())
      .get("/api/provider/queue")
      .set("Host", "tenant-a.example.com");

    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(orgFilterValue("select")).toBe(TENANT_A_ORG);
  });
});

describe("provider portal — MFA gate stays in force", () => {
  it("blocks the queue route when MFA is not enrolled (403)", async () => {
    mfaEnrolledMock.value = false;
    const res = await request(makeApp())
      .get("/api/provider/queue")
      .set("Host", "tenant-a.example.com");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("mfa_enrollment_required");
  });
});

describe("provider portal — sign route scopes the org-guarded update", () => {
  it("signs against the host tenant's org and preserves provider isolation", async () => {
    resolveOrgIdByHostMock.mockResolvedValue(TENANT_A_ORG);
    // loadOwnRequest → select one pending row for this provider.
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: {
        id: REQUEST_ID,
        status: "pending",
        expires_at: null,
        subject_type: "prescription",
      },
    });
    // loadProviderNpi → providers select (global table).
    stageSupabaseResponse("providers", "select", {
      data: { npi: "1234567890" },
    });
    // executeSignature → the status-guarded update RETURNING id.
    stageSupabaseResponse("provider_signature_requests", "update", {
      data: { id: REQUEST_ID },
    });

    const res = await request(makeApp())
      .post(`/api/provider/queue/${REQUEST_ID}/sign`)
      .set("Host", "tenant-a.example.com")
      .send({ consentEsign: true, signerName: "Dr Pat Example" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("signed");
    // Both the load (select) and the guarded write (update) scoped to A.
    expect(orgFilterValue("select")).toBe(TENANT_A_ORG);
    expect(orgFilterValue("update")).toBe(TENANT_A_ORG);
    expect(providerFilterValue("select")).toBe(PROVIDER_ID);
  });
});
