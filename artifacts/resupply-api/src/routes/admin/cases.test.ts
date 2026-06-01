// Route tests for /admin/cases (Phase 0 / F4 case object).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
  getSupabaseWritePayloads,
  getSupabaseFilterCalls,
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

import casesRouter from "./cases";

// CSR holds cases.read + cases.manage.
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};
// rt (clinician bucket) does NOT hold cases.* — used for the 403 path.
const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};
const CASE_ID = "case_1";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(casesRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET /admin/cases", () => {
  it("401s without admin", async () => {
    expect((await request(makeApp()).get("/admin/cases")).status).toBe(401);
  });

  it("403s for a role without cases.read (rt)", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp()).get("/admin/cases");
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("cases.read");
  });

  it("defaults to the open feed and maps rows", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("cases", "select", {
      data: [
        {
          id: CASE_ID,
          title: "Lost order #12345",
          status: "open",
          priority: "high",
          patient_id: null,
          customer_id: "cust_9",
          assigned_to_user_id: null,
          opened_by_email: "csr@penn.example.com",
          summary: null,
          created_at: "2026-05-31T00:00:00Z",
          updated_at: "2026-05-31T00:00:00Z",
          resolved_at: null,
        },
      ],
    });
    const res = await request(makeApp()).get("/admin/cases");
    expect(res.status).toBe(200);
    expect(res.body.cases[0]).toMatchObject({
      id: CASE_ID,
      title: "Lost order #12345",
      status: "open",
      priority: "high",
      customerId: "cust_9",
    });
    expect(getSupabaseFilterCalls("cases", "select")).toContainEqual({
      verb: "eq",
      args: ["status", "open"],
    });
  });
});

describe("POST /admin/cases", () => {
  it("403s for rt (lacks cases.manage)", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp())
      .post("/admin/cases")
      .send({ title: "x" });
    expect(res.status).toBe(403);
    expect(getSupabaseCallCount("cases", "insert")).toBe(0);
  });

  it("400s without a title", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).post("/admin/cases").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("creates + audits without the free-text title", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("cases", "insert", {
      data: { id: CASE_ID, created_at: "2026-05-31T00:00:00Z" },
    });
    const res = await request(makeApp())
      .post("/admin/cases")
      .send({ title: "Lost order #12345", priority: "high" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(CASE_ID);

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("case.create");
    expect(audit.metadata).toEqual({ priority: "high", patient_id: null });
    expect(JSON.stringify(audit.metadata)).not.toContain("Lost order");
  });
});

describe("GET /admin/cases/:id", () => {
  it("404s when the case doesn't exist", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("cases", "select", { data: null });
    const res = await request(makeApp()).get(`/admin/cases/${CASE_ID}`);
    expect(res.status).toBe(404);
  });

  it("returns the case with its links", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("cases", "select", {
      data: {
        id: CASE_ID,
        title: "Lost order #12345",
        status: "open",
        priority: "high",
        patient_id: null,
        customer_id: "cust_9",
        assigned_to_user_id: null,
        opened_by_email: "csr@penn.example.com",
        summary: null,
        created_at: "2026-05-31T00:00:00Z",
        updated_at: "2026-05-31T00:00:00Z",
        resolved_at: null,
      },
    });
    stageSupabaseResponse("case_links", "select", {
      data: [
        {
          id: "link_1",
          link_kind: "order",
          ref_id: "order_12345",
          note: null,
          created_by_email: "csr@penn.example.com",
          created_at: "2026-05-31T01:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get(`/admin/cases/${CASE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.case.id).toBe(CASE_ID);
    expect(res.body.links).toHaveLength(1);
    expect(res.body.links[0]).toMatchObject({
      linkKind: "order",
      refId: "order_12345",
    });
  });
});

describe("PATCH /admin/cases/:id", () => {
  it("sets resolved_at when transitioning to resolved", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("cases", "update", {
      data: { id: CASE_ID, status: "resolved" },
    });
    const res = await request(makeApp())
      .patch(`/admin/cases/${CASE_ID}`)
      .send({ status: "resolved" });
    expect(res.status).toBe(200);
    const payload = getSupabaseWritePayloads("cases", "update")[0] as Record<
      string,
      unknown
    >;
    expect(payload.status).toBe("resolved");
    expect(typeof payload.resolved_at).toBe("string");
  });

  it("400s on an empty patch", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .patch(`/admin/cases/${CASE_ID}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/cases/:id/links", () => {
  it("404s when the case doesn't exist", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("cases", "select", { data: null });
    const res = await request(makeApp())
      .post(`/admin/cases/${CASE_ID}/links`)
      .send({ linkKind: "order", refId: "order_12345" });
    expect(res.status).toBe(404);
    expect(getSupabaseCallCount("case_links", "upsert")).toBe(0);
  });

  it("links an artifact to the case", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("cases", "select", { data: { id: CASE_ID } });
    stageSupabaseResponse("case_links", "upsert", { data: [{ id: "link_1" }] });
    const res = await request(makeApp())
      .post(`/admin/cases/${CASE_ID}/links`)
      .send({ linkKind: "order", refId: "order_12345" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ linked: true });
    const payload = getSupabaseWritePayloads(
      "case_links",
      "upsert",
    )[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      case_id: CASE_ID,
      link_kind: "order",
      ref_id: "order_12345",
    });
  });
});
