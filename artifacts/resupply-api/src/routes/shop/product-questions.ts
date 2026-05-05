// /shop/products/:productId/questions — customer-facing Q&A on
// shop products (Phase A.5 / feature #24 extension).
//
//   GET  /shop/products/:productId/questions  — public list of
//        ANSWERED questions for the product.
//   POST /shop/products/:productId/questions  — auth-gated submit;
//        creates a question with status='pending'. CSRs answer via
//        the admin moderation queue.
//
// Privacy: question + answer bodies are public-shop content. We
// never expose asker_email on the public surface. Display name is
// rendered as "FirstName L." (or "PennPaps customer" fallback).
//
// Why we don't show pending questions publicly: we want the answer
// to land alongside the question so other shoppers see useful Q&A
// pairs. A pending question with no answer yet is just noise.

import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { getDbPool, shopProductQuestions } from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

const productIdParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

const submitBody = z
  .object({
    questionBody: z
      .string()
      .trim()
      .min(10, "Please add a few more words so the team can answer well.")
      .max(1000, "Questions must be 1000 characters or fewer."),
  })
  .strict();

router.get("/shop/products/:productId/questions", async (req, res) => {
  const parsed = productIdParam.safeParse(req.params.productId);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_product_id" });
    return;
  }
  const productId = parsed.data;

  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      id: shopProductQuestions.id,
      askerDisplayName: shopProductQuestions.askerDisplayName,
      questionBody: shopProductQuestions.questionBody,
      answerBody: shopProductQuestions.answerBody,
      answeredAt: shopProductQuestions.answeredAt,
      createdAt: shopProductQuestions.createdAt,
    })
    .from(shopProductQuestions)
    .where(
      and(
        eq(shopProductQuestions.productId, productId),
        eq(shopProductQuestions.status, "answered"),
      ),
    )
    .orderBy(desc(shopProductQuestions.answeredAt))
    .limit(50);

  res.json({
    questions: rows.map((r) => ({
      id: r.id,
      askerDisplayName: r.askerDisplayName,
      questionBody: r.questionBody,
      answerBody: r.answerBody ?? "",
      answeredAt: r.answeredAt ? r.answeredAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

router.post(
  "/shop/products/:productId/questions",
  requireSignedIn,
  async (req, res) => {
    const customerId = req.userCustomerId;
    if (!customerId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }

    const idCheck = productIdParam.safeParse(req.params.productId);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_product_id" });
      return;
    }
    const productId = idCheck.data;

    const bodyParsed = submitBody.safeParse(req.body);
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
    const { questionBody } = bodyParsed.data;

    // Public display name as "FirstName L." matches the shop_reviews
    // convention. Fall back to "PennPaps customer" so the public
    // surface never shows an empty author label.
    const displayName = formatPublicDisplayName(req.shopCustomerDisplayName);
    const askerEmail = (req.shopCustomerEmail ?? "").toLowerCase();

    const db = drizzle(getDbPool());
    const inserted = await db
      .insert(shopProductQuestions)
      .values({
        productId,
        customerId,
        askerDisplayName: displayName,
        askerEmail,
        questionBody,
      })
      .returning({
        id: shopProductQuestions.id,
        status: shopProductQuestions.status,
        createdAt: shopProductQuestions.createdAt,
      });
    const row = inserted[0];
    if (!row) {
      throw new Error("INSERT returned no rows");
    }

    res.status(201).json({
      id: row.id,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    });
  },
);

function formatPublicDisplayName(raw: string | null | undefined): string {
  if (!raw) return "PennPaps customer";
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "PennPaps customer";
  const first = parts[0]!;
  const lastInitial = parts[1]?.[0] ? `${parts[1][0]}.` : "";
  return lastInitial ? `${first} ${lastInitial}` : first;
}

export default router;
