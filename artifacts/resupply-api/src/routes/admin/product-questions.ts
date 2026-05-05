// /admin/shop/product-questions — CSR moderation queue + answer
// flow for customer-submitted product Q&A (Phase A.5 / feature #24).
//
//   GET   /admin/shop/product-questions?status=pending  — queue
//   PATCH /admin/shop/product-questions/:id            — answer or reject
//
// Audit verbs:
//   shop_product_question.answer  — admin posted an answer (→ answered)
//   shop_product_question.reject  — admin rejected (→ rejected)
//
// PHI / log posture: bodies are public-shop content (no PHI). Audit
// envelope still logs structurally — product_id + question_length +
// answer_length — so we can spot anomalies without parsing prose.

import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getDbPool, shopProductQuestions } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.string().trim().min(1).max(200);

const answerBody = z
  .object({
    action: z.literal("answer"),
    answerBody: z.string().trim().min(1).max(2000),
  })
  .strict();

const rejectBody = z
  .object({
    action: z.literal("reject"),
    moderationNote: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

const patchBody = z.union([answerBody, rejectBody]);

router.get("/admin/shop/product-questions", requireAdmin, async (req, res) => {
  const status = (req.query.status as string | undefined) ?? "pending";
  if (!["pending", "answered", "rejected"].includes(status)) {
    res.status(400).json({ error: "invalid_status" });
    return;
  }

  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      id: shopProductQuestions.id,
      productId: shopProductQuestions.productId,
      askerDisplayName: shopProductQuestions.askerDisplayName,
      askerEmail: shopProductQuestions.askerEmail,
      questionBody: shopProductQuestions.questionBody,
      answerBody: shopProductQuestions.answerBody,
      answeredByEmail: shopProductQuestions.answeredByEmail,
      answeredAt: shopProductQuestions.answeredAt,
      moderationNote: shopProductQuestions.moderationNote,
      moderatedAt: shopProductQuestions.moderatedAt,
      status: shopProductQuestions.status,
      createdAt: shopProductQuestions.createdAt,
    })
    .from(shopProductQuestions)
    .where(eq(shopProductQuestions.status, status))
    .orderBy(desc(shopProductQuestions.createdAt))
    .limit(100);

  res.json({
    questions: rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      askerDisplayName: r.askerDisplayName,
      askerEmail: r.askerEmail,
      questionBody: r.questionBody,
      answerBody: r.answerBody,
      answeredByEmail: r.answeredByEmail,
      answeredAt: r.answeredAt ? r.answeredAt.toISOString() : null,
      moderationNote: r.moderationNote,
      moderatedAt: r.moderatedAt ? r.moderatedAt.toISOString() : null,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

router.patch(
  "/admin/shop/product-questions/:id",
  requireAdmin,
  async (req, res) => {
    const idCheck = idParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const id = idCheck.data;

    const bodyParsed = patchBody.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const db = drizzle(getDbPool());

    const existing = await db
      .select({
        id: shopProductQuestions.id,
        productId: shopProductQuestions.productId,
        questionBody: shopProductQuestions.questionBody,
        status: shopProductQuestions.status,
      })
      .from(shopProductQuestions)
      .where(eq(shopProductQuestions.id, id))
      .limit(1);
    const row = existing[0];
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (row.status !== "pending") {
      res.status(409).json({
        error: "already_moderated",
        message: `This question is already ${row.status}.`,
      });
      return;
    }

    const now = new Date();
    if (bodyParsed.data.action === "answer") {
      const { answerBody: answer } = bodyParsed.data;
      await db
        .update(shopProductQuestions)
        .set({
          status: "answered",
          answerBody: answer,
          answeredByEmail: req.adminEmail ?? "<unknown>",
          answeredByUserId: req.adminUserId ?? null,
          answeredAt: now,
          updatedAt: now,
        })
        .where(eq(shopProductQuestions.id, id));

      await logAudit({
        action: "shop_product_question.answer",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "shop_product_questions",
        targetId: id,
        metadata: {
          product_id: row.productId,
          question_length: row.questionBody.length,
          answer_length: answer.length,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn({ err }, "shop_product_question.answer audit write failed");
      });

      res.json({ id, status: "answered", answeredAt: now.toISOString() });
      return;
    }

    // reject
    const { moderationNote } = bodyParsed.data;
    await db
      .update(shopProductQuestions)
      .set({
        status: "rejected",
        moderationNote: moderationNote ?? null,
        moderatedAt: now,
        moderatedBy: req.adminUserId ?? null,
        updatedAt: now,
      })
      .where(eq(shopProductQuestions.id, id));

    await logAudit({
      action: "shop_product_question.reject",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_product_questions",
      targetId: id,
      metadata: {
        product_id: row.productId,
        question_length: row.questionBody.length,
        // moderation_note length only — never the note content, so a
        // moderator's free-form comment doesn't end up in the audit
        // log searchable text.
        moderation_note_length: moderationNote?.length ?? 0,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "shop_product_question.reject audit write failed");
    });

    res.json({ id, status: "rejected", moderatedAt: now.toISOString() });
  },
);

export default router;
