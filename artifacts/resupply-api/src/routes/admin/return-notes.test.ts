// Route tests for /admin/shop/returns/:returnId/notes (Phase 15).
// Mirrors order-notes.test.ts.

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

import returnNotesRouter from "./return-notes";

const RETURN_ID = "return_abc123";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(returnNotesRouter);
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

describe("GET /admin/shop/returns/:returnId/notes", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      `/admin/shop/returns/${RETURN_ID}/notes`,
    );
    expect(res.status).toBe(401);
  });

  it("400s with malformed returnId", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const res = await request(makeApp()).get(
      `/admin/shop/returns/has spaces!/notes`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_return_id");
    expect(dbStub.select).not.toHaveBeenCalled();
  });

  it("404s when the return doesn't exist", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([]);
    const res = await request(makeApp()).get(
      `/admin/shop/returns/${RETURN_ID}/notes`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("return_not_found");
  });

  it("returns the notes list", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ id: RETURN_ID }]);
    selectQueue.push([
      {
        id: "note_1",
        body: "Approved for replacement; vendor has stock.",
        authorEmail: "ops@penn.example.com",
        authorUserId: "u_admin",
        createdAt: new Date("2026-05-03T15:00:00Z"),
      },
    ]);

    const res = await request(makeApp()).get(
      `/admin/shop/returns/${RETURN_ID}/notes`,
    );
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0]).toMatchObject({
      id: "note_1",
      body: "Approved for replacement; vendor has stock.",
      authorEmail: "ops@penn.example.com",
    });
  });
});

describe("POST /admin/shop/returns/:returnId/notes", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(`/admin/shop/returns/${RETURN_ID}/notes`)
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
      .post(`/admin/shop/returns/${RETURN_ID}/notes`)
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
      .post(`/admin/shop/returns/${RETURN_ID}/notes`)
      .send({ body: "x".repeat(4001) });
    expect(res.status).toBe(400);
  });

  it("404s when the return doesn't exist", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([]);
    const res = await request(makeApp())
      .post(`/admin/shop/returns/${RETURN_ID}/notes`)
      .send({ body: "Vendor confirmed warranty replacement" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("return_not_found");
    expect(dbStub.insert).not.toHaveBeenCalled();
  });

  it("inserts + audits with non-PHI envelope", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ id: RETURN_ID }]);
    insertQueue.push([
      { id: "note_new", createdAt: new Date("2026-05-04T12:00:00Z") },
    ]);

    const res = await request(makeApp())
      .post(`/admin/shop/returns/${RETURN_ID}/notes`)
      .send({
        body: "Denied — outside the 30-day comfort-guarantee window.",
      });

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
    expect(audit.action).toBe("shop_return.note.create");
    expect(audit.targetTable).toBe("shop_return_notes");
    expect(audit.targetId).toBe("note_new");
    expect(audit.metadata).toEqual({
      return_id: RETURN_ID,
      body_length: "Denied — outside the 30-day comfort-guarantee window."
        .length,
    });
    // Critical: no body content in the audit envelope.
    expect(JSON.stringify(audit.metadata)).not.toContain("Denied");
    expect(JSON.stringify(audit.metadata)).not.toContain("comfort-guarantee");
  });
});
