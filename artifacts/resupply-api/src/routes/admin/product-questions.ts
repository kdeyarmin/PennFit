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

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { encodeCompositeCursor, parseCompositeCursor } from "../../lib/cursor";
import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";

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

// Customer-question moderation queue + answer flow. Treated as
// CSR-tier inbox work — every role that handles inbound questions
// uses this surface. `conversations.manage` matches the access
// matrix on the rest of the customer-facing inbox.
router.get("/admin/shop/product-questions", requirePermission("conversations.manage"), async (req, res) => {
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

  const supabase = getSupabaseServiceRoleClient();

  // Cursor is composite (created_at, id) so we get strict ordering
  // even when many rows share a created_at. PostgREST `.or()` supports
  // this with `created_at.lt.<iso>,and(created_at.eq.<iso>,id.lt.<id>)`.
  // The cursor values are already either UUIDs or PostgREST-safe ISO
  // timestamps, so no metachar smuggling is possible.
  let questionsQuery = supabase
    .schema("resupply")
    .from("shop_product_questions")
    .select(
      "id, product_id, asker_display_name, asker_email, question_body, answer_body, answered_by_email, answered_at, moderation_note, moderated_at, status, created_at",
    )
    .eq("status", status)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (parsedCursor.date && parsedCursor.id) {
    const cursorIso = parsedCursor.date.toISOString();
    questionsQuery = questionsQuery.or(
      `created_at.lt.${cursorIso},and(created_at.eq.${cursorIso},id.lt.${parsedCursor.id})`,
    );
  }
  const { data: rows, error } = await questionsQuery;
  if (error) throw error;

  const all = rows ?? [];
  const hasMore = all.length > limit;
  const trimmed = hasMore ? all.slice(0, limit) : all;
  const lastRow = trimmed[trimmed.length - 1];
  const nextCursor =
    hasMore && lastRow
      ? encodeCompositeCursor(new Date(lastRow.created_at), lastRow.id)
      : null;

  res.json({
    items: trimmed.map((r) => ({
      id: r.id,
      productId: r.product_id,
      askerDisplayName: r.asker_display_name,
      askerEmail: r.asker_email,
      questionBody: r.question_body,
      answerBody: r.answer_body,
      answeredByEmail: r.answered_by_email,
      answeredAt: r.answered_at,
      moderationNote: r.moderation_note,
      moderatedAt: r.moderated_at,
      status: r.status,
      createdAt: r.created_at,
    })),
    nextCursor,
  });
});

router.patch(
  "/admin/shop/product-questions/:id",
  // Answer / approve / reject — same scope as the read above.
  requirePermission("conversations.manage"),
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

    const supabase = getSupabaseServiceRoleClient();
    const now = new Date();
    const nowIso = now.toISOString();

    if (bodyParsed.data.action === "answer") {
      const { answerBody: answer } = bodyParsed.data;
      // Atomic: only update when status is still 'pending'. If no row is
      // returned the question was already moderated by another CSR (race),
      // or never existed. PostgREST has no native UPDATE...RETURNING with
      // an extra WHERE — but `.update().eq().eq("status","pending").select()`
      // is the equivalent: PostgREST only updates rows matching all
      // filters and returns just those rows.
      const { data: updatedRow, error: updateErr } = await supabase
        .schema("resupply")
        .from("shop_product_questions")
        .update({
          status: "answered",
          answer_body: answer,
          answered_by_email: req.adminEmail ?? "<unknown>",
          answered_by_user_id: req.adminUserId ?? null,
          answered_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", id)
        .eq("status", "pending")
        .select("id, product_id, question_body")
        .limit(1)
        .maybeSingle();
      if (updateErr) throw updateErr;

      if (!updatedRow) {
        const { data: existing, error: existErr } = await supabase
          .schema("resupply")
          .from("shop_product_questions")
          .select("status")
          .eq("id", id)
          .limit(1)
          .maybeSingle();
        if (existErr) throw existErr;
        if (!existing) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        res.status(409).json({
          error: "already_moderated",
          message: `This question is already ${existing.status}.`,
        });
        return;
      }

      await logAudit({
        action: "shop_product_question.answer",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "shop_product_questions",
        targetId: id,
        metadata: {
          product_id: updatedRow.product_id,
          question_length: updatedRow.question_body.length,
          answer_length: answer.length,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn({ err }, "shop_product_question.answer audit write failed");
      });

      res.json({ id, status: "answered", answeredAt: nowIso });
      return;
    }

    // reject — same atomic guard
    const { moderationNote } = bodyParsed.data;
    const { data: updatedRow, error: updateErr } = await supabase
      .schema("resupply")
      .from("shop_product_questions")
      .update({
        status: "rejected",
        moderation_note: moderationNote ?? null,
        moderated_at: nowIso,
        moderated_by: req.adminUserId ?? null,
        updated_at: nowIso,
      })
      .eq("id", id)
      .eq("status", "pending")
      .select("id, product_id, question_body")
      .limit(1)
      .maybeSingle();
    if (updateErr) throw updateErr;

    if (!updatedRow) {
      const { data: existing, error: existErr } = await supabase
        .schema("resupply")
        .from("shop_product_questions")
        .select("status")
        .eq("id", id)
        .limit(1)
        .maybeSingle();
      if (existErr) throw existErr;
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.status(409).json({
        error: "already_moderated",
        message: `This question is already ${existing.status}.`,
      });
      return;
    }

    await logAudit({
      action: "shop_product_question.reject",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_product_questions",
      targetId: id,
      metadata: {
        product_id: updatedRow.product_id,
        question_length: updatedRow.question_body.length,
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

    res.json({ id, status: "rejected", moderatedAt: nowIso });
  },
);

export default router;
