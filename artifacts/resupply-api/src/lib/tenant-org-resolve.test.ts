// resolveOrgIdByHost: "whose DATA does a request on THIS host operate on?".
//
//   1. A verified custom domain resolves to that tenant's org_id.
//   2. The platform host / an unknown / unverified host resolves to the
//      seed org (single-tenant behavior is unchanged).
//   3. A DB error degrades to the seed org (fail-soft) — never throws.
//   4. Positive resolutions are cached per host.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  __resetTenantBrandingForTests,
  resolveOrgIdByHost,
} from "./tenant-branding";

// The supabase mock stubs resolveSeedOrgId() to this fixed test org.
const SEED_ORG = "00000000-0000-4000-8000-000000000000";
const TENANT_ORG = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  supabaseMock.reset();
  __resetTenantBrandingForTests();
});

describe("resolveOrgIdByHost", () => {
  it("resolves the seed org for the platform host (no custom-domain lookup)", async () => {
    // `*.up.railway.app` is a reserved host → normalizeCustomDomain returns
    // null → resolveOrgIdByHost short-circuits to the seed org with no
    // organizations query at all.
    const orgId = await resolveOrgIdByHost("pennfit.up.railway.app");
    expect(orgId).toBe(SEED_ORG);
  });

  it("resolves the seed org for an empty host", async () => {
    const orgId = await resolveOrgIdByHost("");
    expect(orgId).toBe(SEED_ORG);
  });

  it("resolves the tenant org for a verified custom domain", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: { id: TENANT_ORG },
    });
    const orgId = await resolveOrgIdByHost("shop.acme.com");
    expect(orgId).toBe(TENANT_ORG);
  });

  it("falls back to the seed org when no verified tenant owns the host", async () => {
    stageSupabaseResponse("organizations", "select", { data: null });
    const orgId = await resolveOrgIdByHost("unclaimed.example.com");
    expect(orgId).toBe(SEED_ORG);
  });

  it("degrades to the seed org on a DB error (fail-soft, never throws)", async () => {
    stageSupabaseResponse("organizations", "select", {
      error: { message: "boom" },
    });
    const orgId = await resolveOrgIdByHost("shop.acme.com");
    expect(orgId).toBe(SEED_ORG);
  });

  it("caches a positive resolution per host (second call needs no query)", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: { id: TENANT_ORG },
    });
    const first = await resolveOrgIdByHost("shop.acme.com");
    // No second response staged; an unstaged select returns { data: null }
    // which would resolve to the seed org. A cached hit returns TENANT_ORG.
    const second = await resolveOrgIdByHost("shop.acme.com");
    expect(first).toBe(TENANT_ORG);
    expect(second).toBe(TENANT_ORG);
  });
});
