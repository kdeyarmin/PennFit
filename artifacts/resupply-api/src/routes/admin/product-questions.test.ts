// Route tests for /admin/shop/product-questions (Phase A.5).
//
// Coverage:
//   * 401 without admin
//   * GET defaults to status=pending
//   * PATCH 'answer' transitions pending → answered + audits with
//     question/answer length only (no body content in the envelope)
//   * PATCH 'reject' transitions pending → rejected + audits
//   * PATCH 409 on already-moderated row

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
const updateSets: Record<string, unknown>[] = [];
const updateQueue: unknown[][] = [];
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
  update: vi.fn(() => {
    const obj: Record<string, unknown> = {
      set: (vals: Record<string, unknown>) => {
        updateSets.push(vals);
        return obj;
      },
      where: () => obj,
      returning: () => Promise.resolve(updateQueue.shift() ?? [{ id: "q_1" }]),
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

import productQuestionsAdminRouter from "./product-questions";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(productQuestionsAdminRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  selectQueue.length = 0;
  updateSets.length = 0;
  updateQueue.length = 0;
  logAuditMock.mockClear();
  dbStub.select.mockClear();
  dbStub.update.mockClear();
});

describe("GET /admin/shop/product-questions", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get("/admin/shop/product-questions");
    expect(res.status).toBe(401);
  });

  it("defaults status filter to 'pending' and returns paginated shape", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([
      {
        id: "q_1",
        productId: "prod_1",
        askerDisplayName: "Anna S.",
        askerEmail: "anna@example.com",
        questionBody: "Does this fit?",
        answerBody: null,
        answeredByEmail: null,
        answeredAt: null,
        moderationNote: null,
        moderatedAt: null,
        status: "pending",
        createdAt: new Date("2026-05-01T00:00:00Z"),
      },
    ]);
    const res = await request(makeApp()).get("/admin/shop/product-questions");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].status).toBe("pending");
    expect(res.body.nextCursor).toBeNull();
  });
});

describe("PATCH /admin/shop/product-questions/:id", () => {
  it("answers a pending question + audits with non-PHI envelope", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([
      {
        id: "q_1",
        productId: "prod_1",
        questionBody: "Does this work at 10cm pressure?",
        status: "pending",
      },
    ]);

    const answer = "Yes — the cushion seals reliably from 4 to 20 cmH2O.";
    const res = await request(makeApp())
      .patch("/admin/shop/product-questions/q_1")
      .send({ action: "answer", answerBody: answer });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("answered");

    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]?.status).toBe("answered");
    expect(updateSets[0]?.answerBody).toBe(answer);

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("shop_product_question.answer");
    expect(audit.metadata).toEqual({
      product_id: "prod_1",
      question_length: "Does this work at 10cm pressure?".length,
      answer_length: answer.length,
    });
    // No body text in the envelope.
    expect(JSON.stringify(audit.metadata)).not.toContain("seals");
  });

  it("409s when the question is already moderated", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([
      {
        id: "q_1",
        productId: "prod_1",
        questionBody: "x",
        status: "answered",
      },
    ]);
    const res = await request(makeApp())
      .patch("/admin/shop/product-questions/q_1")
      .send({ action: "answer", answerBody: "another" });
    expect(res.status).toBe(409);
    expect(updateSets).toEqual([]);
  });

  it("409s when a concurrent request wins the race (empty .returning())", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    // Row reads as pending (pre-check passes), but the conditional UPDATE
    // finds no rows to update — simulates losing a concurrent race.
    selectQueue.push([
      {
        id: "q_1",
        productId: "prod_1",
        questionBody: "Does this fit?",
        status: "pending",
      },
    ]);
    updateQueue.push([]); // .returning() yields no rows
    const res = await request(makeApp())
      .patch("/admin/shop/product-questions/q_1")
      .send({ action: "answer", answerBody: "Yes it does." });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_moderated");
    // The update was attempted but returned nothing — no audit should fire.
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("rejects with audit length-only metadata (no note text)", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([
      {
        id: "q_1",
        productId: "prod_1",
        questionBody: "How do I beat traffic?",
        status: "pending",
      },
    ]);
    const res = await request(makeApp())
      .patch("/admin/shop/product-questions/q_1")
      .send({ action: "reject", moderationNote: "Off-topic for the product." });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("shop_product_question.reject");
    expect(audit.metadata).toEqual({
      product_id: "prod_1",
      question_length: "How do I beat traffic?".length,
      moderation_note_length: "Off-topic for the product.".length,
    });
    expect(JSON.stringify(audit.metadata)).not.toContain("Off-topic");
  });
});
