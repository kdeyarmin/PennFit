// GET /shop/education-videos — the public /learn library is now per-tenant
// (migration 0358). The route resolves the tenant by request host and reads
// that tenant's OWN videos via the org-scoped facade. These tests pin the
// host→org resolution + the org_id scoping, and the fail-soft empty-library
// contract.

import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const resolveOrgIdByHostMock = vi.hoisted(() =>
  // Typed string | null so the no-tenant case can resolve null directly
  // (the route's resolveOrgIdByHost returns string | null).
  vi.fn<() => Promise<string | null>>(async () => "org-from-host"),
);
vi.mock("../../lib/tenant-branding", () => ({
  resolveOrgIdByHost: resolveOrgIdByHostMock,
}));
vi.mock("../../lib/request-host", () => ({
  requestHost: () => "tenant.example.com",
}));

import educationVideosRouter from "./education-videos";

function makeApp(): Express {
  const app = express();
  app.use(educationVideosRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  resolveOrgIdByHostMock.mockReset().mockResolvedValue("org-from-host");
});

describe("GET /shop/education-videos", () => {
  it("serves the host tenant's videos, scoped to that org", async () => {
    stageSupabaseResponse("education_videos", "select", {
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          title: "Fitting your mask",
          topic: "mask_fitting",
          description: null,
          video_url: "https://videos.example.com/fit.mp4",
          thumbnail_url: null,
          duration_seconds: 120,
          sort_order: 0,
          active: true,
        },
      ],
    });

    const res = await request(makeApp()).get("/shop/education-videos");

    expect(res.status).toBe(200);
    // Tenant resolved from the request host.
    expect(resolveOrgIdByHostMock).toHaveBeenCalledWith("tenant.example.com");
    // The catalog read scoped to that tenant (facade appends org_id).
    const filters = getSupabaseFilterCalls("education_videos", "select");
    expect(
      filters.some(
        (f) =>
          f.verb === "eq" &&
          f.args[0] === "org_id" &&
          f.args[1] === "org-from-host",
      ),
    ).toBe(true);
    expect(res.body.groups.length).toBeGreaterThan(0);
  });

  it("returns an empty library (fail-soft) on a query error", async () => {
    stageSupabaseResponse("education_videos", "select", {
      error: { message: "boom" },
    });
    const res = await request(makeApp()).get("/shop/education-videos");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: [] });
  });

  it("returns an empty library when no tenant resolves", async () => {
    resolveOrgIdByHostMock.mockResolvedValue(null);
    const res = await request(makeApp()).get("/shop/education-videos");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: [] });
  });
});
