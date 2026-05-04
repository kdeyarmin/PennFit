// Route tests for the POST /conversations/:id/status endpoint
// added in Phase 8. The other endpoints in assignment.ts are
// covered by the existing inbox-list test fixtures via
// supertest; this file is focused on the new status-mutation
// surface.
//
// Coverage:
//   * 401 without admin
//   * 400 with an invalid status value
//   * 404 when the conversation doesn't exist
//   * 409 when channel is not in_app
//   * idempotent no-op when already in the requested status
//   * happy path: writes status + audits with non-PHI envelope
//
// We mock drizzle at the fluent-builder level (same pattern as
// detail.test.ts and reply-in-app.test.ts) and stub the audit
// helper so we can assert the envelope shape.

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

// Drizzle stub. The route does:
//   1. SELECT status, channel FROM conversations WHERE id = ?
//   2. UPDATE conversations SET status = ?, sla_due_at = ?, updated_at
//      = ? WHERE id = ?
// `selectQueue` feeds 1; `update` is intercepted via dbStub.
const selectQueue: unknown[][] = [];
const dbStub = {
  select: vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      limit: () => Promise.resolve(result),
    };
    return obj;
  }),
  update: vi.fn(() => {
    const obj: Record<string, unknown> = {
      set: () => obj,
      where: () => Promise.resolve([{ id: "row" }]),
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

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

import assignmentRouter from "./assignment";

const CONV_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(assignmentRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  selectQueue.length = 0;
  logAuditMock.mockClear();
  dbStub.select.mockClear();
  dbStub.update.mockClear();
});

describe("POST /conversations/:id/status (Phase 8)", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/status`)
      .send({ status: "closed" });
    expect(res.status).toBe(401);
  });

  it("400s with an invalid status value", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/status`)
      .send({ status: "garbage" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("404s when the conversation doesn't exist", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([]);
    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/status`)
      .send({ status: "closed" });
    expect(res.status).toBe(404);
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("409s when the channel is not in_app", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ status: "open", channel: "sms" }]);
    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/status`)
      .send({ status: "closed" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("wrong_channel");
    expect(dbStub.update).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("returns 200 with changed=false when already in the requested status", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ status: "closed", channel: "in_app" }]);
    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/status`)
      .send({ status: "closed" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "closed", changed: false });
    // No-op: no UPDATE, no audit row.
    expect(dbStub.update).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("flips status + audits with non-PHI envelope on a valid mutation", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ status: "awaiting_admin", channel: "in_app" }]);

    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/status`)
      .send({ status: "closed" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "closed", changed: true });
    expect(dbStub.update).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledTimes(1);

    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      targetTable: string;
      targetId: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("messaging.conversation.status_change");
    expect(audit.targetTable).toBe("conversations");
    expect(audit.targetId).toBe(CONV_ID);
    expect(audit.metadata).toEqual({
      channel: "in_app",
      from_status: "awaiting_admin",
      to_status: "closed",
    });
  });

  it("supports reopen: closed → awaiting_admin", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ status: "closed", channel: "in_app" }]);

    const res = await request(makeApp())
      .post(`/conversations/${CONV_ID}/status`)
      .send({ status: "awaiting_admin" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      status: "awaiting_admin",
      changed: true,
    });
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(audit.metadata.from_status).toBe("closed");
    expect(audit.metadata.to_status).toBe("awaiting_admin");
  });
});
