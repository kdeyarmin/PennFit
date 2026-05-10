// Route tests for /admin/shop/product-questions (Phase A.5).
//
// Coverage:
//   * 401 without admin
//   * GET defaults to status=pending and returns paginated shape
//   * PATCH 'answer' transitions pending → answered + audits with
//     question/answer length only (no body content in the envelope)
//   * PATCH 'reject' transitions pending → rejected + audits
//   * PATCH 409 when the atomic UPDATE returns 0 rows (already moderated
//     by another CSR or concurrent race)
//   * PATCH 404 when the row does not exist at all

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
  getSupabaseWritePayloads,
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

import productQuestionsAdminRouter from "./product-questions";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(productQuestionsAdminRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET /admin/shop/product-questions", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get("/admin/shop/product-questions");
    expect(res.status).toBe(401);
  });

  it("defaults status filter to 'pending' and returns paginated shape", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_product_questions", "select", {
      data: [
        {
          id: "q_1",
          product_id: "prod_1",
          asker_display_name: "Anna S.",
          asker_email: "anna@example.com",
          question_body: "Does this fit?",
          answer_body: null,
          answered_by_email: null,
          answered_at: null,
          moderation_note: null,
          moderated_at: null,
          status: "pending",
          created_at: new Date("2026-05-01T00:00:00Z").toISOString(),
        },
      ],
    });
    const res = await request(makeApp()).get("/admin/shop/product-questions");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].status).toBe("pending");
    expect(res.body.nextCursor).toBeNull();
  });
});

describe("PATCH /admin/shop/product-questions/:id", () => {
  it("answers a pending question + audits with non-PHI envelope", async () => {
    mockAdmin.current = ADMIN;
    // Atomic update returns the row when status was 'pending'.
    stageSupabaseResponse("shop_product_questions", "update", {
      data: {
        id: "q_1",
        product_id: "prod_1",
        question_body: "Does this work at 10cm pressure?",
      },
    });

    const answer = "Yes — the cushion seals reliably from 4 to 20 cmH2O.";
    const res = await request(makeApp())
      .patch("/admin/shop/product-questions/q_1")
      .send({ action: "answer", answerBody: answer });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("answered");

    const updates = getSupabaseWritePayloads(
      "shop_product_questions",
      "update",
    );
    expect(updates).toHaveLength(1);
    const update = updates[0] as Record<string, unknown>;
    expect(update.status).toBe("answered");
    expect(update.answer_body).toBe(answer);

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

  it("409s when the atomic UPDATE returns 0 rows (already moderated)", async () => {
    mockAdmin.current = ADMIN;
    // Atomic update returns null (WHERE status='pending' excluded the row).
    stageSupabaseResponse("shop_product_questions", "update", { data: null });
    // Fallback select finds the row with a non-pending status.
    stageSupabaseResponse("shop_product_questions", "select", {
      data: { status: "answered" },
    });

    const res = await request(makeApp())
      .patch("/admin/shop/product-questions/q_1")
      .send({ action: "answer", answerBody: "another" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_moderated");
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("404s when the row does not exist at all", async () => {
    mockAdmin.current = ADMIN;
    // Atomic update returns null.
    stageSupabaseResponse("shop_product_questions", "update", { data: null });
    // Fallback select also finds nothing.
    stageSupabaseResponse("shop_product_questions", "select", { data: null });

    const res = await request(makeApp())
      .patch("/admin/shop/product-questions/q_missing")
      .send({ action: "answer", answerBody: "x" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("rejects with audit length-only metadata (no note text)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_product_questions", "update", {
      data: {
        id: "q_1",
        product_id: "prod_1",
        question_body: "How do I beat traffic?",
      },
    });
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
