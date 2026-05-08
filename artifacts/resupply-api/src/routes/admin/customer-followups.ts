// /admin/shop/customers/:userId/followups — CSR-scheduled callback
// reminders per shop customer (Phase 17).
//
//   GET    /admin/shop/customers/:userId/followups          — list (open only)
//   GET    /admin/shop/customers/:userId/followups?include=completed — full history
//   POST   /admin/shop/customers/:userId/followups          — create
//   PATCH  /admin/shop/customers/:userId/followups/:id/complete — mark complete
//
// Distinct from shop_customer_notes: notes are passive history;
// followups are active commitments by a specific CSR to do something
// by a specific time. The split keeps "what happened" separate from
// "what I owe" so the customer-360 panel renders each cleanly.
//
// Lifecycle:
//   open (completed_at IS NULL) → completed (completed_at + by populated).
// No edit / delete. A CSR who needs to revise just creates a new
// followup; the previous one stays as the audit trail.
//
// PHI / log posture: bodies are plain text. Audit envelopes record
// customer_id + body_length + due_at — never the body.

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  shopCustomerFollowups,
  shopCustomers,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { rateLimit } from "../../middlewares/rate-limit";

const router: IRouter = Router();

// Per-admin rate limit on followup writes (B-07). create + complete
// are CSR queue actions, low-impact individually but worth a per-
// actor cap so a scripted abuser can't churn the table. 60/hour
// matches the existing adminReturnLifecycleLimiter envelope for
// non-financial admin write workflows. Keyed by adminUserId
// (populated by requireAdmin which runs first).
const adminFollowupMutationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  name: "admin_customer_followup_mutation",
  keyFn: (req) => req.adminUserId ?? "unknown",
});

const userIdParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

const followupIdParam = z.string().trim().uuid();

const createSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, "Followup body cannot be empty.")
      .max(2000, "Followup body must be 2000 characters or fewer."),
    dueAt: z
      .string()
      .datetime({ message: "dueAt must be an ISO 8601 timestamp." }),
  })
  .strict();

router.get(
  "/admin/shop/customers/:userId/followups",
  requireAdmin,
  async (req, res) => {
    const parsed = userIdParam.safeParse(req.params.userId);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    const userId = parsed.data;
    // `?include=completed` switches from the default open-only view
    // to the full history. The split exists because the customer-360
    // panel almost always wants the open queue, and the longer the
    // customer's history the slower it'd be to filter client-side.
    const includeCompleted = req.query.include === "completed";

    const db = drizzle(getDbPool());

    const exists = await db
      .select({ id: shopCustomers.customerId })
      .from(shopCustomers)
      .where(eq(shopCustomers.customerId, userId))
      .limit(1);
    if (exists.length === 0) {
      res.status(404).json({ error: "customer_not_found" });
      return;
    }

    const baseQuery = db
      .select({
        id: shopCustomerFollowups.id,
        body: shopCustomerFollowups.body,
        dueAt: shopCustomerFollowups.dueAt,
        completedAt: shopCustomerFollowups.completedAt,
        completedByEmail: shopCustomerFollowups.completedByEmail,
        createdByEmail: shopCustomerFollowups.createdByEmail,
        createdAt: shopCustomerFollowups.createdAt,
      })
      .from(shopCustomerFollowups)
      .where(
        includeCompleted
          ? eq(shopCustomerFollowups.customerId, userId)
          : and(
              eq(shopCustomerFollowups.customerId, userId),
              isNull(shopCustomerFollowups.completedAt),
            ),
      )
      .orderBy(
        // Open queue: ascending due_at (most overdue first). Full
        // history: descending due_at (most recent first).
        includeCompleted
          ? desc(shopCustomerFollowups.dueAt)
          : asc(shopCustomerFollowups.dueAt),
      );
    // Open queue is always small; cap it cheaply. For full history
    // we do NOT cap — the caller explicitly requested the complete
    // audit trail and truncating it would break that contract.
    const rows = await (includeCompleted ? baseQuery : baseQuery.limit(100));

    req.log?.info(
      {
        userId,
        count: rows.length,
        includeCompleted,
        adminEmail: req.adminEmail,
      },
      "admin.shop.customer.followups.list",
    );

    res.json({
      followups: rows.map((r) => ({
        id: r.id,
        body: r.body,
        dueAt: r.dueAt.toISOString(),
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
        completedByEmail: r.completedByEmail,
        createdByEmail: r.createdByEmail,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  },
);

router.post(
  "/admin/shop/customers/:userId/followups",
  requireAdmin,
  adminFollowupMutationLimiter,
  async (req, res) => {
    const idCheck = userIdParam.safeParse(req.params.userId);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    const userId = idCheck.data;

    const bodyParsed = createSchema.safeParse(req.body);
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
    const { body, dueAt } = bodyParsed.data;

    const db = drizzle(getDbPool());

    const exists = await db
      .select({ id: shopCustomers.customerId })
      .from(shopCustomers)
      .where(eq(shopCustomers.customerId, userId))
      .limit(1);
    if (exists.length === 0) {
      res.status(404).json({ error: "customer_not_found" });
      return;
    }

    const inserted = await db
      .insert(shopCustomerFollowups)
      .values({
        customerId: userId,
        body,
        dueAt: new Date(dueAt),
        createdByEmail: req.adminEmail ?? "<unknown>",
        createdByUserId: req.adminUserId ?? null,
      })
      .returning({
        id: shopCustomerFollowups.id,
        createdAt: shopCustomerFollowups.createdAt,
        dueAt: shopCustomerFollowups.dueAt,
      });
    const row = inserted[0];
    if (!row) {
      throw new Error("INSERT returned no rows");
    }

    await logAudit({
      action: "shop_customer.followup.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_customer_followups",
      targetId: row.id,
      metadata: {
        customer_id: userId,
        body_length: body.length,
        due_at: row.dueAt.toISOString(),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "shop_customer.followup.create audit write failed");
    });

    res.status(201).json({
      id: row.id,
      dueAt: row.dueAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    });
  },
);

router.patch(
  "/admin/shop/customers/:userId/followups/:id/complete",
  requireAdmin,
  adminFollowupMutationLimiter,
  async (req, res) => {
    const idCheck = userIdParam.safeParse(req.params.userId);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    const userId = idCheck.data;

    const fIdCheck = followupIdParam.safeParse(req.params.id);
    if (!fIdCheck.success) {
      res.status(400).json({ error: "invalid_followup_id" });
      return;
    }
    const followupId = fIdCheck.data;

    const db = drizzle(getDbPool());

    const existing = await db
      .select({
        id: shopCustomerFollowups.id,
        customerId: shopCustomerFollowups.customerId,
        completedAt: shopCustomerFollowups.completedAt,
        body: shopCustomerFollowups.body,
        dueAt: shopCustomerFollowups.dueAt,
      })
      .from(shopCustomerFollowups)
      .where(eq(shopCustomerFollowups.id, followupId))
      .limit(1);
    const row = existing[0];
    if (!row) {
      res.status(404).json({ error: "followup_not_found" });
      return;
    }
    // Defence-in-depth: ensure the followup actually belongs to the
    // userId in the path. A CSR with the followup UUID could otherwise
    // target it on any customer's URL; not exploitable today (admin
    // is admin) but the URL contract should hold.
    if (row.customerId !== userId) {
      res.status(404).json({ error: "followup_not_found" });
      return;
    }
    if (row.completedAt !== null) {
      res.status(409).json({
        error: "already_completed",
        message: "This followup is already marked complete.",
      });
      return;
    }

    const now = new Date();
    const updated = await db
      .update(shopCustomerFollowups)
      .set({
        completedAt: now,
        completedByEmail: req.adminEmail ?? "<unknown>",
        completedByUserId: req.adminUserId ?? null,
      })
      .where(
        and(
          eq(shopCustomerFollowups.id, followupId),
          isNull(shopCustomerFollowups.completedAt),
        ),
      )
      .returning({
        id: shopCustomerFollowups.id,
        completedAt: shopCustomerFollowups.completedAt,
      });
    const updatedRow = updated[0];
    if (!updatedRow) {
      res.status(409).json({
        error: "already_completed",
        message: "This followup is already marked complete.",
      });
      return;
    }

    await logAudit({
      action: "shop_customer.followup.complete",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_customer_followups",
      targetId: followupId,
      metadata: {
        customer_id: userId,
        body_length: row.body.length,
        due_at: row.dueAt.toISOString(),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "shop_customer.followup.complete audit write failed",
      );
    });

    res.json({
      id: updatedRow.id,
      completedAt: updatedRow.completedAt
        ? updatedRow.completedAt.toISOString()
        : null,
    });
  },
);

export default router;
