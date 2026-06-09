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
