// /admin/shop/customers/:userId/message-template-overrides — admin
// CRUD for per-customer message-template overrides (Phase 3 of
// docs/proposals/customer-message-templates.md).
//
// Endpoints:
//   GET    /admin/shop/customers/:userId/message-template-overrides
//          — list every override for one customer.
//   POST   /admin/shop/customers/:userId/message-template-overrides
//          — create an override for (template_key, channel). Required
//            note explaining WHY.
//   PATCH  /admin/shop/customers/:userId/message-template-overrides/:id
//          — edit override fields or toggle isActive.
//   DELETE /admin/shop/customers/:userId/message-template-overrides/:id
//          — soft-delete via isActive=false (the row stays as the
//            audit anchor; isActive=true reactivates).
//
// Sister to /admin/message-templates which manages the global
// library. The lookup at lib/message-templates/lookup.ts layers
// override-on-global so a partial override (e.g. just the SMS
// body) inherits the not-overridden fields from the global.
//
// Editor enforcement matches the global path:
//   * Each {{var}} in subject / body_html / body_text must be in
//     the LINKED global template's allowedVariables. The endpoint
//     fetches the global to validate; if no global exists (override-
//     before-global), the validation falls back to "any token
//     stays literal" — same as the render path's behaviour.
//
// Audit: every write logs `message_template_override.{create,
// update}` with metadata-only envelope ({customer_id, template_key,
// channel, fields_changed, has_note}). Bodies stay OUT of the
// envelope — same posture as the global library's audit row.

import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  messageTemplates,
  shopCustomerMessageTemplateOverrides,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { rateLimit } from "../../middlewares/rate-limit";

const router: IRouter = Router();

// Per-admin rate limit on override writes (B-07 envelope). 30/hour
// is plenty of headroom for legitimate ops work while bounding a
// compromised admin's blast radius.
const adminOverrideMutationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  name: "admin_message_template_override_mutation",
  keyFn: (req) => req.adminUserId ?? "unknown",
});

const channelEnum = z.enum(["email", "sms", "voice", "push"]);

// shop_customers.customer_id — same shape the rest of the admin
// surface uses (UUID, Stripe customer id, or auth.users id).
const userIdParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const overrideIdParam = z.string().uuid();

const templateKeyShape = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/);

const createBody = z
  .object({
    templateKey: templateKeyShape,
    channel: channelEnum,
    subject: z.string().trim().max(1000).nullable().optional(),
    bodyHtml: z.string().trim().max(200000).nullable().optional(),
    bodyText: z.string().trim().max(50000).nullable().optional(),
    isActive: z.boolean().optional(),
    // Required on create per the proposal — captures WHY the
    // override exists. Empty / whitespace-only is rejected.
    note: z.string().trim().min(3).max(2000),
  })
  .strict();

const patchBody = z
  .object({
    subject: z.string().trim().max(1000).nullable().optional(),
    bodyHtml: z.string().trim().max(200000).nullable().optional(),
    bodyText: z.string().trim().max(50000).nullable().optional(),
    isActive: z.boolean().optional(),
    note: z.string().trim().min(3).max(2000).optional(),
  })
  .strict();

interface OverrideView {
  id: string;
  customerId: string;
  templateKey: string;
  channel: string;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  isActive: boolean;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

function serialize(
  row: typeof shopCustomerMessageTemplateOverrides.$inferSelect,
): OverrideView {
  return {
    id: row.id,
    customerId: row.customerId,
    templateKey: row.templateKey,
    channel: row.channel,
    subject: row.subject ?? null,
    bodyHtml: row.bodyHtml ?? null,
    bodyText: row.bodyText ?? null,
    isActive: row.isActive,
    note: row.note ?? null,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy ?? null,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy ?? null,
  };
}

/** Mirror the global path's pre-flight check: any `{{var}}` in
 *  the new content that isn't in the linked global's allowedVariables
 *  is rejected. When no linked global exists yet, every token stays
 *  literal (matches the renderer's behaviour). */
function disallowedTokens(
  s: string | null | undefined,
  allowed: ReadonlyArray<string>,
): string[] {
  if (!s) return [];
  const found = new Set<string>();
  const allowedSet = new Set(allowed);
  for (const m of s.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)) {
    const name = m[1]!;
    if (!allowedSet.has(name)) found.add(name);
  }
  return [...found];
}

router.get(
  "/admin/shop/customers/:userId/message-template-overrides",
  requireAdmin,
  async (req, res) => {
    const idCheck = userIdParam.safeParse(req.params.userId);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    const db = drizzle(getDbPool());
    const rows = await db
      .select()
      .from(shopCustomerMessageTemplateOverrides)
      .where(
        eq(
          shopCustomerMessageTemplateOverrides.customerId,
          idCheck.data,
        ),
      )
      .orderBy(
        asc(shopCustomerMessageTemplateOverrides.templateKey),
        asc(shopCustomerMessageTemplateOverrides.channel),
      )
      .limit(200);
    res.json({ overrides: rows.map(serialize) });
  },
);

router.post(
  "/admin/shop/customers/:userId/message-template-overrides",
  requireAdmin,
  adminOverrideMutationLimiter,
  async (req, res) => {
    const idCheck = userIdParam.safeParse(req.params.userId);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const db = drizzle(getDbPool());

    // Look up the global template (if any) to source the allowed-
    // variables list for the pre-flight check.
    const globalRows = await db
      .select()
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.templateKey, parsed.data.templateKey),
          eq(messageTemplates.channel, parsed.data.channel),
        ),
      )
      .limit(1);
    const allowed = globalRows[0]?.allowedVariables ?? [];

    const offenders = [
      ...disallowedTokens(parsed.data.subject, allowed),
      ...disallowedTokens(parsed.data.bodyHtml, allowed),
      ...disallowedTokens(parsed.data.bodyText, allowed),
    ];
    if (offenders.length > 0) {
      res.status(400).json({
        error: "disallowed_variables",
        offending: [...new Set(offenders)],
        allowed,
      });
      return;
    }

    const adminId = req.adminUserId ?? null;
    let inserted;
    try {
      const rows = await db
        .insert(shopCustomerMessageTemplateOverrides)
        .values({
          customerId: idCheck.data,
          templateKey: parsed.data.templateKey,
          channel: parsed.data.channel,
          subject: parsed.data.subject ?? null,
          bodyHtml: parsed.data.bodyHtml ?? null,
          bodyText: parsed.data.bodyText ?? null,
          isActive: parsed.data.isActive ?? true,
          note: parsed.data.note,
          createdBy: adminId,
          updatedBy: adminId,
        })
        .returning();
      inserted = rows[0]!;
    } catch (err) {
      if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
        res.status(409).json({ error: "override_already_exists" });
        return;
      }
      throw err;
    }

    void logAudit({
      action: "message_template_override.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: adminId,
      targetTable: "shop_customer_message_template_overrides",
      targetId: inserted.id,
      metadata: {
        customer_id: idCheck.data,
        template_key: inserted.templateKey,
        channel: inserted.channel,
        fields_set: [
          parsed.data.subject !== undefined ? "subject" : null,
          parsed.data.bodyHtml !== undefined ? "body_html" : null,
          parsed.data.bodyText !== undefined ? "body_text" : null,
        ].filter((s): s is string => s !== null),
        is_active: inserted.isActive,
        has_note: true,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err, overrideId: inserted.id },
        "message_template_override.create audit write failed",
      );
    });

    res.status(201).json({ override: serialize(inserted) });
  },
);

router.patch(
  "/admin/shop/customers/:userId/message-template-overrides/:id",
  requireAdmin,
  adminOverrideMutationLimiter,
  async (req, res) => {
    const userIdCheck = userIdParam.safeParse(req.params.userId);
    if (!userIdCheck.success) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    const idCheck = overrideIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const db = drizzle(getDbPool());
    const existingRows = await db
      .select()
      .from(shopCustomerMessageTemplateOverrides)
      .where(
        and(
          eq(shopCustomerMessageTemplateOverrides.id, idCheck.data),
          eq(
            shopCustomerMessageTemplateOverrides.customerId,
            userIdCheck.data,
          ),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      res.status(404).json({ error: "override_not_found" });
      return;
    }

    // Pre-flight allowed-variables check against the linked global.
    const globalRows = await db
      .select()
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.templateKey, existing.templateKey),
          eq(messageTemplates.channel, existing.channel),
        ),
      )
      .limit(1);
    const allowed = globalRows[0]?.allowedVariables ?? [];
    const nextSubject =
      parsed.data.subject !== undefined ? parsed.data.subject : existing.subject;
    const nextBodyHtml =
      parsed.data.bodyHtml !== undefined
        ? parsed.data.bodyHtml
        : existing.bodyHtml;
    const nextBodyText =
      parsed.data.bodyText !== undefined
        ? parsed.data.bodyText
        : existing.bodyText;
    const offenders = [
      ...disallowedTokens(nextSubject, allowed),
      ...disallowedTokens(nextBodyHtml, allowed),
      ...disallowedTokens(nextBodyText, allowed),
    ];
    if (offenders.length > 0) {
      res.status(400).json({
        error: "disallowed_variables",
        offending: [...new Set(offenders)],
        allowed,
      });
      return;
    }

    const adminId = req.adminUserId ?? null;
    const updateValues: Partial<
      typeof shopCustomerMessageTemplateOverrides.$inferInsert
    > = {
      updatedBy: adminId,
    };
    if (parsed.data.subject !== undefined)
      updateValues.subject = parsed.data.subject;
    if (parsed.data.bodyHtml !== undefined)
      updateValues.bodyHtml = parsed.data.bodyHtml;
    if (parsed.data.bodyText !== undefined)
      updateValues.bodyText = parsed.data.bodyText;
    if (parsed.data.isActive !== undefined)
      updateValues.isActive = parsed.data.isActive;
    if (parsed.data.note !== undefined) updateValues.note = parsed.data.note;

    const updated = await db
      .update(shopCustomerMessageTemplateOverrides)
      .set(updateValues)
      .where(eq(shopCustomerMessageTemplateOverrides.id, idCheck.data))
      .returning();

    const fieldsChanged: string[] = [];
    for (const k of [
      "subject",
      "bodyHtml",
      "bodyText",
      "isActive",
      "note",
    ] as const) {
      if (parsed.data[k] !== undefined) fieldsChanged.push(k);
    }

    void logAudit({
      action: "message_template_override.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: adminId,
      targetTable: "shop_customer_message_template_overrides",
      targetId: existing.id,
      metadata: {
        customer_id: existing.customerId,
        template_key: existing.templateKey,
        channel: existing.channel,
        fields_changed: fieldsChanged,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err, overrideId: existing.id },
        "message_template_override.update audit write failed",
      );
    });

    res.json({ override: serialize(updated[0]!) });
  },
);

// DELETE = soft delete via isActive=false. The row stays as the
// audit anchor; reactivate by PATCH { isActive: true }.
router.delete(
  "/admin/shop/customers/:userId/message-template-overrides/:id",
  requireAdmin,
  adminOverrideMutationLimiter,
  async (req, res) => {
    const userIdCheck = userIdParam.safeParse(req.params.userId);
    if (!userIdCheck.success) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    const idCheck = overrideIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    const db = drizzle(getDbPool());
    const existingRows = await db
      .select()
      .from(shopCustomerMessageTemplateOverrides)
      .where(
        and(
          eq(shopCustomerMessageTemplateOverrides.id, idCheck.data),
          eq(
            shopCustomerMessageTemplateOverrides.customerId,
            userIdCheck.data,
          ),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      res.status(404).json({ error: "override_not_found" });
      return;
    }
    if (!existing.isActive) {
      // Already soft-deleted. Idempotent.
      res.json({ override: serialize(existing) });
      return;
    }

    const adminId = req.adminUserId ?? null;
    const updated = await db
      .update(shopCustomerMessageTemplateOverrides)
      .set({ isActive: false, updatedBy: adminId })
      .where(eq(shopCustomerMessageTemplateOverrides.id, idCheck.data))
      .returning();

    void logAudit({
      action: "message_template_override.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: adminId,
      targetTable: "shop_customer_message_template_overrides",
      targetId: existing.id,
      metadata: {
        customer_id: existing.customerId,
        template_key: existing.templateKey,
        channel: existing.channel,
        fields_changed: ["isActive"],
        deactivated: true,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err, overrideId: existing.id },
        "message_template_override deactivate audit write failed",
      );
    });

    res.json({ override: serialize(updated[0]!) });
  },
);

export default router;
