// Route tests for /admin/providers-pecos.
//
// Coverage:
//   * GET list 401 without sign-in
//   * GET list returns rows envelope
//   * GET list with ?stale=true filters by last_synced_at cutoff
//   * GET by npi 404 on malformed npi
//   * GET by npi 404 when row missing
//   * GET by npi returns the pecos object
//   * POST sync-now 401 without sign-in
//   * POST sync-now 403 for agent
//   * POST sync-now happy path runs sync + audits

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  getSupabaseFilterCalls,
  installSupabaseMock,
  stageSupabaseResponse,
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
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

const runPecosSyncMock = vi.hoisted(() =>
  vi.fn(async () => ({ npisChecked: 5, npisUpdated: 2 })),
);
vi.mock("../../worker/jobs/pecos-sync", () => ({
  runPecosSync: runPecosSyncMock,
}));

import pecosRouter from "./pecos-status";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(pecosRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  logAuditMock.mockClear();
  runPecosSyncMock.mockClear();
  supabaseMock.reset();
});

describe("GET /admin/providers-pecos (list)", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/admin/providers-pecos");
    expect(res.status).toBe(401);
  });

  it("returns rows envelope", async () => {
    mockAdmin.current = { userId: "u_1", email: "a@a", role: "admin" };
    stageSupabaseResponse("providers_pecos_status", "select", {
      data: [
        {
          npi: "1234567890",
          enrollment_status: "approved",
          enrollment_type: "Group",
          first_approved_date: "2020-01-01",
          specialty_description: "Sleep Medicine",
          last_synced_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get("/admin/providers-pecos");
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].npi).toBe("1234567890");
  });

  it("applies stale cutoff with ?stale=true", async () => {
    mockAdmin.current = { userId: "u_1", email: "a@a", role: "admin" };
    stageSupabaseResponse("providers_pecos_status", "select", { data: [] });
    await request(makeApp()).get("/admin/providers-pecos?stale=true");
    const calls = getSupabaseFilterCalls("providers_pecos_status", "select");
    const lteCall = calls.find((c) => c.verb === "lte");
    expect(lteCall?.args[0]).toBe("last_synced_at");
    expect(lteCall?.args[1]).toBeTruthy();
  });
});

describe("GET /admin/providers-pecos/:npi", () => {
  it("404s on malformed npi", async () => {
    mockAdmin.current = { userId: "u_1", email: "a@a", role: "admin" };
    const res = await request(makeApp()).get("/admin/providers-pecos/123");
    expect(res.status).toBe(404);
  });

  it("404s when row is missing", async () => {
    mockAdmin.current = { userId: "u_1", email: "a@a", role: "admin" };
    stageSupabaseResponse("providers_pecos_status", "select", { data: null });
    const res = await request(makeApp()).get(
      "/admin/providers-pecos/1234567890",
    );
    expect(res.status).toBe(404);
  });

  it("returns the pecos object on hit", async () => {
    mockAdmin.current = { userId: "u_1", email: "a@a", role: "admin" };
    stageSupabaseResponse("providers_pecos_status", "select", {
      data: { npi: "1234567890", enrollment_status: "approved" },
    });
    const res = await request(makeApp()).get(
      "/admin/providers-pecos/1234567890",
    );
    expect(res.status).toBe(200);
    expect(res.body.pecos.npi).toBe("1234567890");
  });
});

describe("POST /admin/providers-pecos/sync-now", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp())
      .post("/admin/providers-pecos/sync-now")
      .send({});
    expect(res.status).toBe(401);
  });

  it("403s when caller is an agent (requireAdminOnly)", async () => {
    mockAdmin.current = { userId: "u_1", email: "a@a", role: "agent" };
    const res = await request(makeApp())
      .post("/admin/providers-pecos/sync-now")
      .send({});
    expect(res.status).toBe(403);
  });

  it("runs sync + audits on happy path", async () => {
    mockAdmin.current = {
      userId: "u_1",
      email: "ops@pennpaps.com",
      role: "admin",
    };
    const res = await request(makeApp())
      .post("/admin/providers-pecos/sync-now")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.stats).toEqual({ npisChecked: 5, npisUpdated: 2 });
    expect(runPecosSyncMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0]?.[0]).toMatchObject({
      action: "providers_pecos.manual_sync",
      metadata: { npisChecked: 5, npisUpdated: 2 },
    });
  });
});
