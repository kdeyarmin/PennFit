// Unit tests for GET /shop/pickup-locations. The feature flag and the
// locations read are mocked at their helper boundaries so we exercise
// the route's gating logic without a live DB.

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => true),
}));
vi.mock("../../lib/pickup/locations", () => ({
  listActivePickupLocations: vi.fn(async () => []),
}));

// This public route has no auth middleware, so it resolves the tenant
// from the request host before reading the flag. Mock both boundaries so
// we can assert the resolved org is threaded into the gate.
const resolveOrgIdByHostMock = vi.hoisted(() =>
  vi.fn(async () => "org-from-host"),
);
vi.mock("../../lib/tenant-branding", () => ({
  resolveOrgIdByHost: resolveOrgIdByHostMock,
}));
vi.mock("../../lib/request-host", () => ({
  requestHost: () => "tenant.example.com",
}));

import pickupLocationsRouter from "./pickup-locations";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { listActivePickupLocations } from "../../lib/pickup/locations";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(pickupLocationsRouter);
  return app;
}

const LOC = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Penn Home Medical — State College",
  addressLine1: "100 Main St",
  addressLine2: null,
  city: "State College",
  state: "PA",
  postalCode: "16801",
  phoneE164: "+18145551234",
  isPrimary: true,
};

describe("GET /shop/pickup-locations", () => {
  beforeEach(() => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(true);
    vi.mocked(listActivePickupLocations).mockResolvedValue([]);
    resolveOrgIdByHostMock.mockReset();
    resolveOrgIdByHostMock.mockResolvedValue("org-from-host");
  });

  it("gates on the org resolved from the request host", async () => {
    // Flag off so we exercise the host-resolve → gate path (both run
    // before the flag check) without the DB read leaking call-count into
    // the sibling tests (this file's beforeEach doesn't clear history).
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    await request(makeApp()).get("/shop/pickup-locations");
    expect(resolveOrgIdByHostMock).toHaveBeenCalledWith("tenant.example.com");
    expect(isFeatureEnabled).toHaveBeenCalledWith(
      "storefront.pickup",
      "org-from-host",
    );
  });

  it("reports disabled (no DB read) when the feature flag is off", async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await request(makeApp()).get("/shop/pickup-locations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, locations: [] });
    expect(listActivePickupLocations).not.toHaveBeenCalled();
  });

  it("reports disabled when the flag is on but no active location exists", async () => {
    vi.mocked(listActivePickupLocations).mockResolvedValue([]);
    const res = await request(makeApp()).get("/shop/pickup-locations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, locations: [] });
  });

  it("returns enabled + the active locations when offerable", async () => {
    vi.mocked(listActivePickupLocations).mockResolvedValue([LOC]);
    const res = await request(makeApp()).get("/shop/pickup-locations");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.locations).toEqual([LOC]);
  });
});
