// Route tests for /admin/shop/customers/:userId/followups (Phase 17).
//
// Coverage:
//   * 401 for all three verbs without admin
//   * 400 for malformed user / followup ids and bad bodies
//   * 404 for nonexistent customer / followup
//   * GET returns the open queue by default; ?include=completed
//     returns the full history
//   * POST creates + audits with non-PHI metadata
//   * PATCH-complete sets completed_at + audits; 409 on already-completed
//   * PATCH-reopen clears completed_at + audits; 409 on already-open
//   * Critical: audit metadata never contains the body content

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

import followupsRouter from "./customer-followups";

const USER_ID = "user_abc123";
const FOLLOWUP_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

// Double-submit CSRF pair used by POST/PATCH tests. Mirrors the
// pattern in admin-users.test.ts so every mutating request below
// satisfies `requireCsrf` (the route's CSRF gate).
const CSRF_TOKEN = "test-csrf-token-followups";
const CSRF_COOKIE = `pf_csrf=${CSRF_TOKEN}`;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(followupsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET /admin/shop/customers/:userId/followups", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      `/admin/shop/customers/${USER_ID}/followups`,
    );
    expect(res.status).toBe(401);
  });

  it("400s with malformed userId", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      `/admin/shop/customers/has spaces!/followups`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_user_id");
  });

  it("404s when the customer doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_customers", "select", { data: null });
    const res = await request(makeApp()).get(
      `/admin/shop/customers/${USER_ID}/followups`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("customer_not_found");
  });

  it("returns the open queue by default", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: USER_ID },
    });
    stageSupabaseResponse("shop_customer_followups", "select", {
      data: [
        {
          id: FOLLOWUP_ID,
          body: "Call about UPS claim",
          due_at: new Date("2026-05-10T16:00:00Z").toISOString(),
          completed_at: null,
          completed_by_email: null,
          created_by_email: "ops@penn.example.com",
          created_at: new Date("2026-05-04T12:00:00Z").toISOString(),
        },
      ],
    });

    const res = await request(makeApp()).get(
      `/admin/shop/customers/${USER_ID}/followups`,
    );
    expect(res.status).toBe(200);
    expect(res.body.followups).toHaveLength(1);
    expect(res.body.followups[0]).toMatchObject({
      id: FOLLOWUP_ID,
      body: "Call about UPS claim",
      completedAt: null,
    });
  });

  it("returns full history with ?include=completed", async () => {
    mockAdmin.current = ADMIN;
    const DONE_ID = "22222222-2222-4222-8222-222222222222";
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: USER_ID },
    });
    stageSupabaseResponse("shop_customer_followups", "select", {
      data: [
        {
          id: FOLLOWUP_ID,
          body: "Open task",
          due_at: new Date("2026-05-10T16:00:00Z").toISOString(),
          completed_at: null,
          completed_by_email: null,
          created_by_email: "ops@penn.example.com",
          created_at: new Date("2026-05-04T12:00:00Z").toISOString(),
        },
        {
          id: DONE_ID,
          body: "Older completed task",
          due_at: new Date("2026-04-01T09:00:00Z").toISOString(),
          completed_at: new Date("2026-04-02T10:00:00Z").toISOString(),
          completed_by_email: "ops@penn.example.com",
          created_by_email: "ops@penn.example.com",
          created_at: new Date("2026-03-28T08:00:00Z").toISOString(),
        },
      ],
    });

    const res = await request(makeApp()).get(
      `/admin/shop/customers/${USER_ID}/followups?include=completed`,
    );
    expect(res.status).toBe(200);
    expect(res.body.followups).toHaveLength(2);
    const doneRow = res.body.followups.find(
      (f: { id: string }) => f.id === DONE_ID,
    );
    expect(doneRow).toBeDefined();
    expect(doneRow.completedAt).toBe("2026-04-02T10:00:00.000Z");
  });
});

describe("POST /admin/shop/customers/:userId/followups", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/followups`)
      .set("Cookie", CSRF_COOKIE)
      .set("x-pf-csrf", CSRF_TOKEN)
      .send({ body: "x", dueAt: "2026-05-10T16:00:00Z" });
    expect(res.status).toBe(401);
  });

  it("403s without a matching CSRF pair", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/followups`)
      .send({ body: "Ping", dueAt: "2026-05-10T16:00:00Z" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
    expect(getSupabaseCallCount("shop_customer_followups", "insert")).toBe(0);
  });

  it("400s with empty body", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/followups`)
      .set("Cookie", CSRF_COOKIE)
      .set("x-pf-csrf", CSRF_TOKEN)
      .send({ body: "  ", dueAt: "2026-05-10T16:00:00Z" });
    expect(res.status).toBe(400);
    expect(getSupabaseCallCount("shop_customer_followups", "insert")).toBe(0);
  });

  it("400s with bad dueAt", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/followups`)
      .set("Cookie", CSRF_COOKIE)
      .set("x-pf-csrf", CSRF_TOKEN)
      .send({ body: "Ping", dueAt: "not-a-date" });
    expect(res.status).toBe(400);
  });

  it("404s when the customer doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_customers", "select", { data: null });
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/followups`)
      .set("Cookie", CSRF_COOKIE)
      .set("x-pf-csrf", CSRF_TOKEN)
      .send({ body: "Ping", dueAt: "2026-05-10T16:00:00Z" });
    expect(res.status).toBe(404);
    expect(getSupabaseCallCount("shop_customer_followups", "insert")).toBe(0);
  });

  it("inserts + audits with non-PHI envelope", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: USER_ID },
    });
    stageSupabaseResponse("shop_customer_followups", "insert", {
      data: {
        id: FOLLOWUP_ID,
        created_at: new Date("2026-05-04T12:00:00Z").toISOString(),
        due_at: new Date("2026-05-10T16:00:00Z").toISOString(),
      },
    });

    const body = "Call Anna about her UPS claim — confirm replacement shipped.";
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/followups`)
      .set("Cookie", CSRF_COOKIE)
      .set("x-pf-csrf", CSRF_TOKEN)
      .send({ body, dueAt: "2026-05-10T16:00:00Z" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(FOLLOWUP_ID);

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("shop_customer.followup.create");
    expect(audit.metadata).toEqual({
      customer_id: USER_ID,
      body_length: body.length,
      due_at: "2026-05-10T16:00:00.000Z",
    });
    // No body content in the audit envelope.
    expect(JSON.stringify(audit.metadata)).not.toContain("UPS");
    expect(JSON.stringify(audit.metadata)).not.toContain("replacement");
  });
});

describe("PATCH /admin/shop/customers/:userId/followups/:id/complete", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .patch(
        `/admin/shop/customers/${USER_ID}/followups/${FOLLOWUP_ID}/complete`,
      )
      .set("Cookie", CSRF_COOKIE)
      .set("x-pf-csrf", CSRF_TOKEN);
    expect(res.status).toBe(401);
  });

  it("403s without a matching CSRF pair", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).patch(
      `/admin/shop/customers/${USER_ID}/followups/${FOLLOWUP_ID}/complete`,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("400s with malformed followup id", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .patch(`/admin/shop/customers/${USER_ID}/followups/not-a-uuid/complete`)
      .set("Cookie", CSRF_COOKIE)
      .set("x-pf-csrf", CSRF_TOKEN);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_followup_id");
  });

  it("404s when the followup doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_customer_followups", "select", { data: null });
    const res = await request(makeApp())
      .patch(
        `/admin/shop/customers/${USER_ID}/followups/${FOLLOWUP_ID}/complete`,
      )
      .set("Cookie", CSRF_COOKIE)
      .set("x-pf-csrf", CSRF_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("followup_not_found");
  });

  it("404s when the followup belongs to a different customer", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_customer_followups", "select", {
      data: {
        id: FOLLOWUP_ID,
        customer_id: "user_someone_else",
        completed_at: null,
        body: "anything",
      },
    });
    const res = await request(makeApp())
      .patch(
        `/admin/shop/customers/${USER_ID}/followups/${FOLLOWUP_ID}/complete`,
      )
      .set("Cookie", CSRF_COOKIE)
      .set("x-pf-csrf", CSRF_TOKEN);
    expect(res.status).toBe(404);
  });

  it("409s when the followup is already complete", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_customer_followups", "select", {
      data: {
        id: FOLLOWUP_ID,
        customer_id: USER_ID,
        completed_at: new Date("2026-05-04T15:00:00Z").toISOString(),
        body: "anything",
      },
    });
    const res = await request(makeApp())
      .patch(
        `/admin/shop/customers/${USER_ID}/followups/${FOLLOWUP_ID}/complete`,
      )
      .set("Cookie", CSRF_COOKIE)
      .set("x-pf-csrf", CSRF_TOKEN);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_completed");
  });

  it("marks complete + audits", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_customer_followups", "select", {
      data: {
        id: FOLLOWUP_ID,
        customer_id: USER_ID,
        completed_at: null,
        body: "Call Anna 5/10",
        due_at: new Date("2026-05-10T16:00:00Z").toISOString(),
      },
    });
    stageSupabaseResponse("shop_customer_followups", "update", {
      data: {
        id: FOLLOWUP_ID,
        completed_at: new Date("2026-05-04T16:00:00Z").toISOString(),
      },
    });

    const res = await request(makeApp())
      .patch(
        `/admin/shop/customers/${USER_ID}/followups/${FOLLOWUP_ID}/complete`,
      )
      .set("Cookie", CSRF_COOKIE)
      .set("x-pf-csrf", CSRF_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(FOLLOWUP_ID);
    expect(res.body.completedAt).toBe("2026-05-04T16:00:00.000Z");

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("shop_customer.followup.complete");
    expect(audit.metadata).toEqual({
      customer_id: USER_ID,
      body_length: "Call Anna 5/10".length,
      due_at: "2026-05-10T16:00:00.000Z",
    });
    // No body content in the audit envelope.
    expect(JSON.stringify(audit.metadata)).not.toContain("Call Anna");
  });
});

describe("PATCH /admin/shop/customers/:userId/followups/:id/reopen", () => {
  it("403s without a matching CSRF pair", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).patch(
      `/admin/shop/customers/${USER_ID}/followups/${FOLLOWUP_ID}/reopen`,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("409s when the followup is already open", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_customer_followups", "select", {
      data: {
        id: FOLLOWUP_ID,
        customer_id: USER_ID,
        completed_at: null,
        body: "anything",
      },
    });
    const res = await request(makeApp())
      .patch(`/admin/shop/customers/${USER_ID}/followups/${FOLLOWUP_ID}/reopen`)
      .set("Cookie", CSRF_COOKIE)
      .set("x-pf-csrf", CSRF_TOKEN);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_open");
  });

  it("reopens a completed followup + audits", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_customer_followups", "select", {
      data: {
        id: FOLLOWUP_ID,
        customer_id: USER_ID,
        completed_at: new Date("2026-05-04T16:00:00Z").toISOString(),
        body: "Call Anna 5/10",
        due_at: new Date("2026-05-10T16:00:00Z").toISOString(),
      },
    });
    stageSupabaseResponse("shop_customer_followups", "update", {
      data: {
        id: FOLLOWUP_ID,
        completed_at: null,
      },
    });

    const res = await request(makeApp())
      .patch(`/admin/shop/customers/${USER_ID}/followups/${FOLLOWUP_ID}/reopen`)
      .set("Cookie", CSRF_COOKIE)
      .set("x-pf-csrf", CSRF_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: FOLLOWUP_ID, completedAt: null });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("shop_customer.followup.reopen");
    expect(audit.metadata).toEqual({
      customer_id: USER_ID,
      body_length: "Call Anna 5/10".length,
      due_at: "2026-05-10T16:00:00.000Z",
    });
    expect(JSON.stringify(audit.metadata)).not.toContain("Call Anna");
  });
});
