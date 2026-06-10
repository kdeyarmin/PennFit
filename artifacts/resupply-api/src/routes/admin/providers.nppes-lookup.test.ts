// Contract tests for POST /admin/providers/nppes-lookup.
//
// The upstream registry is stubbed at the global-fetch layer so the
// REAL lookupNpi + projection code runs — these lock in the response
// envelope the Add Provider modal depends on:
//   200 { provider }            — registered NPI
//   404 { error: npi_not_found } — registry answered, no such NPI
//   400 { error: invalid_body }  — not a 10-digit NPI
//   502 { error: nppes_unavailable, upstreamStatus, message }
//       — registry unreachable/rejecting; `message` is operator-facing
//         and `upstreamStatus` is the raw diagnostic.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import { installSupabaseMock } from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import providersRouter from "./providers";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(providersRouter);
  return app;
}

const REGISTERED = {
  result_count: 1,
  results: [
    {
      number: "1003000126",
      basic: { first_name: "ARDALAN", last_name: "ENKESHAFI" },
      addresses: [
        {
          address_purpose: "LOCATION",
          address_1: "6410 ROCKLEDGE DR",
          city: "BETHESDA",
          state: "MD",
          postal_code: "20817",
          country_code: "US",
          telephone_number: "443-602-6207",
        },
      ],
      taxonomies: [{ code: "208M00000X", primary: true }],
    },
  ],
};

function stubNppesFetch(impl: typeof fetch | Response | Error): void {
  if (impl instanceof Response) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(impl));
  } else if (impl instanceof Error) {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(impl));
  } else {
    vi.stubGlobal("fetch", impl);
  }
}

beforeEach(() => {
  mockAdmin.current = ADMIN;
  supabaseMock.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /admin/providers/nppes-lookup", () => {
  it("401s without a session", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp())
      .post("/admin/providers/nppes-lookup")
      .send({ npi: "1003000126" });
    expect(res.status).toBe(401);
  });

  it("400s a non-10-digit NPI", async () => {
    const res = await request(makeApp())
      .post("/admin/providers/nppes-lookup")
      .send({ npi: "12345" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns the projection for a registered NPI", async () => {
    stubNppesFetch(
      new Response(JSON.stringify(REGISTERED), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await request(makeApp())
      .post("/admin/providers/nppes-lookup")
      .send({ npi: "1003000126" });
    expect(res.status).toBe(200);
    expect(res.body.provider).toMatchObject({
      npi: "1003000126",
      legalName: "ARDALAN ENKESHAFI",
      taxonomyCode: "208M00000X",
      phoneE164: "+14436026207",
    });
  });

  it("404s npi_not_found when the registry has no match", async () => {
    stubNppesFetch(
      new Response(JSON.stringify({ result_count: 0, results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await request(makeApp())
      .post("/admin/providers/nppes-lookup")
      .send({ npi: "1234567893" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("npi_not_found");
  });

  it("502s with the upstream status + operator message when the registry rejects us", async () => {
    stubNppesFetch(new Response("Forbidden", { status: 403 }));
    const res = await request(makeApp())
      .post("/admin/providers/nppes-lookup")
      .send({ npi: "1003000126" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("nppes_unavailable");
    expect(res.body.upstreamStatus).toBe(403);
    expect(res.body.message).toContain("HTTP 403");
  });

  it("502s with a null upstream status on a network failure", async () => {
    stubNppesFetch(new TypeError("fetch failed"));
    const res = await request(makeApp())
      .post("/admin/providers/nppes-lookup")
      .send({ npi: "1003000126" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("nppes_unavailable");
    expect(res.body.upstreamStatus).toBeNull();
    expect(typeof res.body.message).toBe("string");
  });
});
