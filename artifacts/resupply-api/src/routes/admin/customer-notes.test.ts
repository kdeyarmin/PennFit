// Route tests for /admin/shop/customers/:userId/notes (Phase 10).
//
// Coverage:
//   * 401 / 400 / 404 paths for both GET and POST
//   * GET returns the notes array (newest-first ordering verified
//     by the SQL `desc(createdAt)`; we just confirm the route
//     forwards what the helper returns)
//   * POST validates body length (empty + over-limit)
//   * POST inserts + audits with non-PHI metadata; envelope never
//     contains the body content

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

// Fluent drizzle stub. The route does up to four queries:
//   GET:  SELECT id FROM shop_customers (exists) → SELECT … FROM
//         shop_customer_notes ORDER BY created_at DESC LIMIT 50
//   POST: SELECT id FROM shop_customers (exists) → INSERT INTO
//         shop_customer_notes RETURNING id, created_at
const selectQueue: unknown[][] = [];
const insertQueue: unknown[][] = [];
const dbStub = {
  select: vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      orderBy: () => obj,
      limit: () => Promise.resolve(result),
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

import customerNotesRouter from "./customer-notes";

const USER_ID = "user_abc123";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(customerNotesRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  selectQueue.length = 0;
  insertQueue.length = 0;
  logAuditMock.mockClear();
  dbStub.select.mockClear();
  dbStub.insert.mockClear();
});

describe("GET /admin/shop/customers/:userId/notes", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      `/admin/shop/customers/${USER_ID}/notes`,
    );
    expect(res.status).toBe(401);
  });

  it("400s with malformed userId (rejects spaces / special chars)", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const res = await request(makeApp()).get(
      `/admin/shop/customers/has spaces!/notes`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_user_id");
    expect(dbStub.select).not.toHaveBeenCalled();
  });

  it("404s when the customer doesn't exist", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([]); // exists check
    const res = await request(makeApp()).get(
      `/admin/shop/customers/${USER_ID}/notes`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("customer_not_found");
  });

  it("returns the notes list", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ id: USER_ID }]); // exists
    selectQueue.push([
      {
        id: "note_1",
        body: "Spoke with Anna 5/3 — switching to nasal pillows.",
        authorEmail: "ops@penn.example.com",
        authorUserId: "u_admin",
        createdAt: new Date("2026-05-03T15:00:00Z"),
      },
      {
        id: "note_0",
        body: "Old note.",
        authorEmail: "other@penn.example.com",
        authorUserId: "u_other",
        createdAt: new Date("2026-05-01T10:00:00Z"),
      },
    ]);

    const res = await request(makeApp()).get(
      `/admin/shop/customers/${USER_ID}/notes`,
    );
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(2);
    expect(res.body.notes[0]).toMatchObject({
      id: "note_1",
      body: "Spoke with Anna 5/3 — switching to nasal pillows.",
      authorEmail: "ops@penn.example.com",
    });
    expect(res.body.notes[0].createdAt).toBe("2026-05-03T15:00:00.000Z");

    // Audit was written with structural metadata only.
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      targetTable: string;
      targetId: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("shop_customer.notes.list");
    expect(audit.targetTable).toBe("shop_customer_notes");
    expect(audit.targetId).toBe(USER_ID);
    expect(audit.metadata).toEqual({ customer_id: USER_ID, count: 2 });
    // Critical: no body content in the audit envelope.
    expect(JSON.stringify(audit.metadata)).not.toContain("nasal pillows");
    expect(JSON.stringify(audit.metadata)).not.toContain("Old note");
  });
});

describe("POST /admin/shop/customers/:userId/notes", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/notes`)
      .send({ body: "test" });
    expect(res.status).toBe(401);
  });

  it("400s with empty body", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/notes`)
      .send({ body: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(dbStub.insert).not.toHaveBeenCalled();
  });

  it("400s with over-limit body", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/notes`)
      .send({ body: "x".repeat(4001) });
    expect(res.status).toBe(400);
  });

  it("404s when the customer doesn't exist", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([]); // exists check
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/notes`)
      .send({ body: "Spoke 5/3" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("customer_not_found");
    expect(dbStub.insert).not.toHaveBeenCalled();
  });

  it("inserts + audits with non-PHI envelope", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ id: USER_ID }]); // exists
    insertQueue.push([
      { id: "note_new", createdAt: new Date("2026-05-04T12:00:00Z") },
    ]);

    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/notes`)
      .send({ body: "Switched Anna to nasal pillows; 30-day follow-up set." });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: "note_new",
      createdAt: "2026-05-04T12:00:00.000Z",
    });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      targetTable: string;
      targetId: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("shop_customer.note.create");
    expect(audit.targetTable).toBe("shop_customer_notes");
    expect(audit.targetId).toBe("note_new");
    expect(audit.metadata).toEqual({
      customer_id: USER_ID,
      body_length: "Switched Anna to nasal pillows; 30-day follow-up set."
        .length,
    });
    // Critical: no body content in the audit envelope.
    expect(JSON.stringify(audit.metadata)).not.toContain("nasal pillows");
    expect(JSON.stringify(audit.metadata)).not.toContain("Switched");
  });

  it("trims whitespace before persisting + measuring length", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ id: USER_ID }]);
    insertQueue.push([
      { id: "note_t", createdAt: new Date("2026-05-04T12:00:00Z") },
    ]);

    await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/notes`)
      .send({ body: "  hello there  " });

    const audit = logAuditMock.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    // Body length is the TRIMMED length ("hello there" = 11), not the
    // raw 15-char input.
    expect(audit.metadata.body_length).toBe("hello there".length);
  });
});
