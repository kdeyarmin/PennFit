// Tests for the provider-portal runtime feature gate.
//
// The gate must resolve `provider.portal_enabled` against the SAME tenant
// the provider DATA routes scope their reads to — the request host's org.
// Otherwise a non-seed tenant is mis-gated: its providers would 404 on a
// flag that's only OFF for the seed org (or be let through on a flag only
// ON for the seed org). These tests prove:
//
//   1. The host org is threaded into isFeatureEnabled (NOT a bare/seed
//      call) — a non-seed tenant is gated on ITS OWN flag.
//   2. The platform host (no tenant resolved → seed fallback) keeps the
//      historical single-tenant behavior byte-for-byte.
//   3. The auth surface (/api/provider/auth/*) stays reachable while the
//      flag is OFF (staged rollout).
//   4. Non-/api/provider paths pass straight through.

import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

const SEED_ORG = "00000000-0000-4000-8000-000000000000";
const TENANT_A_ORG = "aaaaaaaa-0000-4000-8000-000000000001";

// Host → org resolver. resolveOrgIdByHost fails SOFT to the seed org for
// any unresolved host, so the default here mirrors the platform host.
const resolveOrgIdByHostMock = vi.hoisted(() =>
  vi.fn(async (_host: string): Promise<string | null> => SEED_ORG),
);
vi.mock("./tenant-branding", () => ({
  resolveOrgIdByHost: resolveOrgIdByHostMock,
}));

// Feature-flag reader. Captures the (key, orgId) it was asked for.
const isFeatureEnabledMock = vi.hoisted(() =>
  vi.fn(async (_key: string, _orgId?: string): Promise<boolean> => true),
);
vi.mock("./feature-flags", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

import { providerPortalFeatureGate } from "./provider-portal-feature-gate";

function makeApp(): Express {
  const app = express();
  app.use(providerPortalFeatureGate);
  // Sentinel terminal handler: if the gate calls next(), we land here.
  app.use((_req, res) => {
    res.status(200).json({ passedThrough: true });
  });
  return app;
}

beforeEach(() => {
  resolveOrgIdByHostMock.mockReset();
  resolveOrgIdByHostMock.mockResolvedValue(SEED_ORG);
  isFeatureEnabledMock.mockReset();
  isFeatureEnabledMock.mockResolvedValue(true);
});

describe("providerPortalFeatureGate — flag resolves against the host tenant", () => {
  it("reads provider.portal_enabled for the HOST tenant's org, not a bare seed call", async () => {
    resolveOrgIdByHostMock.mockResolvedValue(TENANT_A_ORG);
    isFeatureEnabledMock.mockResolvedValue(true);

    const res = await request(makeApp())
      .get("/api/provider/queue")
      .set("Host", "tenant-a.example.com");

    expect(res.status).toBe(200);
    expect(res.body.passedThrough).toBe(true);
    // The host fed the resolver, and the resolved org was passed to the flag.
    expect(resolveOrgIdByHostMock).toHaveBeenCalledWith("tenant-a.example.com");
    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "provider.portal_enabled",
      TENANT_A_ORG,
    );
  });

  it("404s a non-seed tenant when ITS OWN flag is OFF (mis-gating is fixed)", async () => {
    resolveOrgIdByHostMock.mockResolvedValue(TENANT_A_ORG);
    isFeatureEnabledMock.mockResolvedValue(false);

    const res = await request(makeApp())
      .get("/api/provider/queue")
      .set("Host", "tenant-a.example.com");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Not found");
    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "provider.portal_enabled",
      TENANT_A_ORG,
    );
  });

  it("falls back to the seed org on the platform host (single-tenant unchanged)", async () => {
    // resolveOrgIdByHost fails soft to the seed org; the gate passes that
    // through (`?? undefined` → isFeatureEnabled applies its own seed
    // fallback). Either way the flag is read for the seed org, exactly as
    // the historical bare `isFeatureEnabled("provider.portal_enabled")`.
    resolveOrgIdByHostMock.mockResolvedValue(SEED_ORG);
    isFeatureEnabledMock.mockResolvedValue(true);

    const res = await request(makeApp())
      .get("/api/provider/queue")
      .set("Host", "cmbreathe.com");

    expect(res.status).toBe(200);
    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "provider.portal_enabled",
      SEED_ORG,
    );
  });

  it("passes the seed org as undefined when even the seed can't be resolved", async () => {
    // DB-down-at-boot: resolveOrgIdByHost returns null. The gate's
    // `?? undefined` lets isFeatureEnabled apply its own seed/posture
    // fallback rather than throwing.
    resolveOrgIdByHostMock.mockResolvedValue(null);
    isFeatureEnabledMock.mockResolvedValue(true);

    const res = await request(makeApp())
      .get("/api/provider/queue")
      .set("Host", "cmbreathe.com");

    expect(res.status).toBe(200);
    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "provider.portal_enabled",
      undefined,
    );
  });
});

describe("providerPortalFeatureGate — staged-rollout exemptions", () => {
  it("lets the auth surface through even when the flag is OFF", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);

    const res = await request(makeApp())
      .get("/api/provider/auth/me")
      .set("Host", "tenant-a.example.com");

    expect(res.status).toBe(200);
    expect(res.body.passedThrough).toBe(true);
    // Auth surface is exempt — the flag is never consulted for it.
    expect(isFeatureEnabledMock).not.toHaveBeenCalled();
  });

  it("ignores non-/api/provider paths entirely (no flag read)", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);

    const res = await request(makeApp()).get("/api/shop/products");

    expect(res.status).toBe(200);
    expect(res.body.passedThrough).toBe(true);
    expect(isFeatureEnabledMock).not.toHaveBeenCalled();
    expect(resolveOrgIdByHostMock).not.toHaveBeenCalled();
  });
});
