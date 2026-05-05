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

import { and, desc, eq, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getDbPool, shopProductQuestions } from "@workspace/resupply-db";

import { encodeCompositeCursor, parseCompositeCursor } from "../../lib/cursor";
import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.string().trim().min(1).max(200);

const LIST_DEFAULT_LIMIT = 25;
const LIST_MAX_LIMIT = 100;

const listQuery = z
  .object({
    status: z
      .enum(["pending", "answered", "rejected"])
      .optional()
      .default("pending"),
    cursor: z.string().min(1).max(120).optional(),
    limit: z
      .union([z.number().int(), z.string()])
      .optional()
      .transform((v) => {
        if (v == null) return LIST_DEFAULT_LIMIT;
        const n = typeof v === "number" ? v : Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n <= 0) return LIST_DEFAULT_LIMIT;
        return Math.min(Math.max(1, Math.floor(n)), LIST_MAX_LIMIT);
      }),
  })
  .strict();

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
  const parse = listQuery.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { status, cursor, limit } = parse.data;

  const parsedCursor = parseCompositeCursor(cursor);
  if (!parsedCursor.ok) {
    res.status(400).json({ error: "invalid_cursor" });
    return;
  }

  const db = drizzle(getDbPool());

  const cursorClause =
    parsedCursor.date && parsedCursor.id
      ? or(
          lt(shopProductQuestions.createdAt, parsedCursor.date),
          and(
            eq(shopProductQuestions.createdAt, parsedCursor.date),
            lt(shopProductQuestions.id, parsedCursor.id),
          ),
        )
      : undefined;

  const clauses = [
    eq(shopProductQuestions.status, status),
    cursorClause,
  ].filter((c): c is NonNullable<typeof c> => c != null);
  // clauses always has at least the status filter, so the array is non-empty.
  // When there's no cursor it's length 1 (no wrapping and()); with a cursor
  // it's length 2 and we need and() to combine both predicates.
  const whereClause =
    clauses.length === 1
      ? clauses[0]!
      : and(clauses[0]!, clauses[1]!);

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
    .where(whereClause)
    .orderBy(desc(shopProductQuestions.createdAt), desc(shopProductQuestions.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = trimmed[trimmed.length - 1];
  const nextCursor =
    hasMore && lastRow
      ? encodeCompositeCursor(lastRow.createdAt, lastRow.id)
      : null;

  res.json({
    items: trimmed.map((r) => ({
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
    nextCursor,
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
    const now = new Date();

    if (bodyParsed.data.action === "answer") {
      const { answerBody: answer } = bodyParsed.data;
      // Atomic: only update when status is still 'pending'. If 0 rows are
      // returned the question was already moderated by another CSR (race),
      // or never existed.
      const updated = await db
        .update(shopProductQuestions)
        .set({
          status: "answered",
          answerBody: answer,
          answeredByEmail: req.adminEmail ?? "<unknown>",
          answeredByUserId: req.adminUserId ?? null,
          answeredAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(shopProductQuestions.id, id),
            eq(shopProductQuestions.status, "pending"),
          ),
        )
        .returning({
          id: shopProductQuestions.id,
          productId: shopProductQuestions.productId,
          questionBody: shopProductQuestions.questionBody,
        });

      if (updated.length === 0) {
        const existing = await db
          .select({ status: shopProductQuestions.status })
          .from(shopProductQuestions)
          .where(eq(shopProductQuestions.id, id))
          .limit(1);
        if (!existing[0]) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        res.status(409).json({
          error: "already_moderated",
          message: `This question is already ${existing[0].status}.`,
        });
        return;
      }

      const row = updated[0]!;
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

    // reject — same atomic guard
    const { moderationNote } = bodyParsed.data;
    const updated = await db
      .update(shopProductQuestions)
      .set({
        status: "rejected",
        moderationNote: moderationNote ?? null,
        moderatedAt: now,
        moderatedBy: req.adminUserId ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(shopProductQuestions.id, id),
          eq(shopProductQuestions.status, "pending"),
        ),
      )
      .returning({
        id: shopProductQuestions.id,
        productId: shopProductQuestions.productId,
        questionBody: shopProductQuestions.questionBody,
      });

    if (updated.length === 0) {
      const existing = await db
        .select({ status: shopProductQuestions.status })
        .from(shopProductQuestions)
        .where(eq(shopProductQuestions.id, id))
        .limit(1);
      if (!existing[0]) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.status(409).json({
        error: "already_moderated",
        message: `This question is already ${existing[0].status}.`,
      });
      return;
    }

    const row = updated[0]!;
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
