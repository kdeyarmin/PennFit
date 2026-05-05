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
//   * Critical: audit metadata never contains the body content

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

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

const selectQueue: unknown[][] = [];
const insertQueue: unknown[][] = [];
const updateQueue: unknown[][] = [];
const dbStub = {
  select: vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      orderBy: () => obj,
      limit: () => Promise.resolve(result),
      // Allow awaiting the builder directly (no .limit() call) — used
      // by the ?include=completed history path.
      then: (
        onfulfilled: (v: unknown[]) => unknown,
        onrejected?: (r: unknown) => unknown,
      ) => Promise.resolve(result).then(onfulfilled, onrejected),
    };
    return obj;
  }),
  insert: vi.fn(() => {
    const result = insertQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      values: () => obj,
      returning: () => Promise.resolve(result),
    };
    return obj;
  }),
  update: vi.fn(() => {
    const result = updateQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      set: () => obj,
      where: () => obj,
      returning: () => Promise.resolve(result),
    };
    return obj;
  }),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return { ...actual, getDbPool: () => ({}) as never };
});

import followupsRouter from "./customer-followups";

const USER_ID = "user_abc123";
const FOLLOWUP_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(followupsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  selectQueue.length = 0;
  insertQueue.length = 0;
  updateQueue.length = 0;
  logAuditMock.mockClear();
  dbStub.select.mockClear();
  dbStub.insert.mockClear();
  dbStub.update.mockClear();
});

describe("GET /admin/shop/customers/:userId/followups", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      `/admin/shop/customers/${USER_ID}/followups`,
    );
    expect(res.status).toBe(401);
  });

  it("400s with malformed userId", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const res = await request(makeApp()).get(
      `/admin/shop/customers/has spaces!/followups`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_user_id");
  });

  it("404s when the customer doesn't exist", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([]);
    const res = await request(makeApp()).get(
      `/admin/shop/customers/${USER_ID}/followups`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("customer_not_found");
  });

  it("returns the open queue by default", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ id: USER_ID }]);
    selectQueue.push([
      {
        id: FOLLOWUP_ID,
        body: "Call about UPS claim",
        dueAt: new Date("2026-05-10T16:00:00Z"),
        completedAt: null,
        completedByEmail: null,
        createdByEmail: "ops@penn.example.com",
        createdAt: new Date("2026-05-04T12:00:00Z"),
      },
    ]);

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
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const DONE_ID = "22222222-2222-4222-8222-222222222222";
    selectQueue.push([{ id: USER_ID }]);
    selectQueue.push([
      {
        id: FOLLOWUP_ID,
        body: "Open task",
        dueAt: new Date("2026-05-10T16:00:00Z"),
        completedAt: null,
        completedByEmail: null,
        createdByEmail: "ops@penn.example.com",
        createdAt: new Date("2026-05-04T12:00:00Z"),
      },
      {
        id: DONE_ID,
        body: "Older completed task",
        dueAt: new Date("2026-04-01T09:00:00Z"),
        completedAt: new Date("2026-04-02T10:00:00Z"),
        completedByEmail: "ops@penn.example.com",
        createdByEmail: "ops@penn.example.com",
        createdAt: new Date("2026-03-28T08:00:00Z"),
      },
    ]);

    const res = await request(makeApp()).get(
      `/admin/shop/customers/${USER_ID}/followups?include=completed`,
    );
    expect(res.status).toBe(200);
    expect(res.body.followups).toHaveLength(2);
    // History includes completed rows.
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
      .send({ body: "x", dueAt: "2026-05-10T16:00:00Z" });
    expect(res.status).toBe(401);
  });

  it("400s with empty body", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/followups`)
      .send({ body: "  ", dueAt: "2026-05-10T16:00:00Z" });
    expect(res.status).toBe(400);
    expect(dbStub.insert).not.toHaveBeenCalled();
  });

  it("400s with bad dueAt", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/followups`)
      .send({ body: "Ping", dueAt: "not-a-date" });
    expect(res.status).toBe(400);
  });

  it("404s when the customer doesn't exist", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([]);
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/followups`)
      .send({ body: "Ping", dueAt: "2026-05-10T16:00:00Z" });
    expect(res.status).toBe(404);
    expect(dbStub.insert).not.toHaveBeenCalled();
  });

  it("inserts + audits with non-PHI envelope", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ id: USER_ID }]);
    insertQueue.push([
      {
        id: FOLLOWUP_ID,
        createdAt: new Date("2026-05-04T12:00:00Z"),
        dueAt: new Date("2026-05-10T16:00:00Z"),
      },
    ]);

    const body = "Call Anna about her UPS claim — confirm replacement shipped.";
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/followups`)
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
    const res = await request(makeApp()).patch(
      `/admin/shop/customers/${USER_ID}/followups/${FOLLOWUP_ID}/complete`,
    );
    expect(res.status).toBe(401);
  });

  it("400s with malformed followup id", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const res = await request(makeApp()).patch(
      `/admin/shop/customers/${USER_ID}/followups/not-a-uuid/complete`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_followup_id");
  });

  it("404s when the followup doesn't exist", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([]);
    const res = await request(makeApp()).patch(
      `/admin/shop/customers/${USER_ID}/followups/${FOLLOWUP_ID}/complete`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("followup_not_found");
  });

  it("404s when the followup belongs to a different customer", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([
      {
        id: FOLLOWUP_ID,
        customerId: "user_someone_else",
        completedAt: null,
        body: "anything",
      },
    ]);
    const res = await request(makeApp()).patch(
      `/admin/shop/customers/${USER_ID}/followups/${FOLLOWUP_ID}/complete`,
    );
    expect(res.status).toBe(404);
  });

  it("409s when the followup is already complete", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([
      {
        id: FOLLOWUP_ID,
        customerId: USER_ID,
        completedAt: new Date("2026-05-04T15:00:00Z"),
        body: "anything",
      },
    ]);
    const res = await request(makeApp()).patch(
      `/admin/shop/customers/${USER_ID}/followups/${FOLLOWUP_ID}/complete`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_completed");
  });

  it("marks complete + audits", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([
      {
        id: FOLLOWUP_ID,
        customerId: USER_ID,
        completedAt: null,
        body: "Call Anna 5/10",
        dueAt: new Date("2026-05-10T16:00:00Z"),
      },
    ]);
    updateQueue.push([
      {
        id: FOLLOWUP_ID,
        completedAt: new Date("2026-05-04T16:00:00Z"),
      },
    ]);

    const res = await request(makeApp()).patch(
      `/admin/shop/customers/${USER_ID}/followups/${FOLLOWUP_ID}/complete`,
    );

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
