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
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  type Database,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { isAsciiOnly } from "../../lib/message-templates/sms";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { rateLimit } from "../../middlewares/rate-limit";

type OverrideRow =
  Database["resupply"]["Tables"]["shop_customer_message_template_overrides"]["Row"];
type OverrideUpdate =
  Database["resupply"]["Tables"]["shop_customer_message_template_overrides"]["Update"];

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

function serialize(row: OverrideRow): OverrideView {
  return {
    id: row.id,
    customerId: row.customer_id,
    templateKey: row.template_key,
    channel: row.channel,
    subject: row.subject ?? null,
    bodyHtml: row.body_html ?? null,
    bodyText: row.body_text ?? null,
    isActive: row.is_active,
    note: row.note ?? null,
    // PostgREST returns timestamptz as ISO string already.
    createdAt: row.created_at,
    createdBy: row.created_by ?? null,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? null,
  };
}

const OVERRIDE_COLUMNS =
  "id, customer_id, template_key, channel, subject, body_html, body_text, is_active, note, created_by, updated_by, created_at, updated_at";

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
    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("shop_customer_message_template_overrides")
      .select(OVERRIDE_COLUMNS)
      .eq("customer_id", idCheck.data)
      .order("template_key", { ascending: true })
      .order("channel", { ascending: true })
      .limit(200);
    if (error) throw error;
    res.json({ overrides: (rows ?? []).map(serialize) });
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

    const supabase = getSupabaseServiceRoleClient();

    // Look up the global template (if any) to source the allowed-
    // variables list for the pre-flight check.
    const { data: globalRow, error: globalErr } = await supabase
      .schema("resupply")
      .from("message_templates")
      .select("allowed_variables")
      .eq("template_key", parsed.data.templateKey)
      .eq("channel", parsed.data.channel)
      .limit(1)
      .maybeSingle();
    if (globalErr) throw globalErr;
    const allowed = globalRow?.allowed_variables ?? [];

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
    if (
      parsed.data.channel === "sms" &&
      parsed.data.bodyText !== undefined &&
      parsed.data.bodyText !== null &&
      !isAsciiOnly(parsed.data.bodyText)
    ) {
      res.status(400).json({
        error: "sms_body_text_must_be_ascii",
      });
      return;
    }

    const adminId = req.adminUserId ?? null;
    const { data: inserted, error: insertErr } = await supabase
      .schema("resupply")
      .from("shop_customer_message_template_overrides")
      .insert({
        customer_id: idCheck.data,
        template_key: parsed.data.templateKey,
        channel: parsed.data.channel,
        subject: parsed.data.subject ?? null,
        body_html: parsed.data.bodyHtml ?? null,
        body_text: parsed.data.bodyText ?? null,
        is_active: parsed.data.isActive ?? true,
        note: parsed.data.note,
        created_by: adminId,
        updated_by: adminId,
      })
      .select(OVERRIDE_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (insertErr) {
      if ((insertErr as { code?: string }).code === "23505") {
        res.status(409).json({ error: "override_already_exists" });
        return;
      }
      throw insertErr;
    }
    if (!inserted) {
      throw new Error("override insert returned no rows");
    }

    void logAudit({
      action: "message_template_override.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: adminId,
      targetTable: "shop_customer_message_template_overrides",
      targetId: inserted.id,
      metadata: {
        customer_id: idCheck.data,
        template_key: inserted.template_key,
        channel: inserted.channel,
        fields_set: [
          parsed.data.subject !== undefined ? "subject" : null,
          parsed.data.bodyHtml !== undefined ? "body_html" : null,
          parsed.data.bodyText !== undefined ? "body_text" : null,
        ].filter((s): s is string => s !== null),
        is_active: inserted.is_active,
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

    const supabase = getSupabaseServiceRoleClient();
    const { data: existing, error: lookupErr } = await supabase
      .schema("resupply")
      .from("shop_customer_message_template_overrides")
      .select(OVERRIDE_COLUMNS)
      .eq("id", idCheck.data)
      .eq("customer_id", userIdCheck.data)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!existing) {
      res.status(404).json({ error: "override_not_found" });
      return;
    }

    // Pre-flight allowed-variables check against the linked global.
    const { data: globalRow, error: globalErr } = await supabase
      .schema("resupply")
      .from("message_templates")
      .select("allowed_variables")
      .eq("template_key", existing.template_key)
      .eq("channel", existing.channel)
      .limit(1)
      .maybeSingle();
    if (globalErr) throw globalErr;
    const allowed = globalRow?.allowed_variables ?? [];
    const nextSubject =
      parsed.data.subject !== undefined ? parsed.data.subject : existing.subject;
    const nextBodyHtml =
      parsed.data.bodyHtml !== undefined
        ? parsed.data.bodyHtml
        : existing.body_html;
    const nextBodyText =
      parsed.data.bodyText !== undefined
        ? parsed.data.bodyText
        : existing.body_text;
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
    if (
      existing.channel === "sms" &&
      parsed.data.bodyText !== undefined &&
      parsed.data.bodyText !== null &&
      !isAsciiOnly(parsed.data.bodyText)
    ) {
      res.status(400).json({
        error: "sms_body_text_must_be_ascii",
      });
      return;
    }

    const adminId = req.adminUserId ?? null;
    const updateValues: OverrideUpdate = {
      updated_by: adminId,
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.subject !== undefined)
      updateValues.subject = parsed.data.subject;
    if (parsed.data.bodyHtml !== undefined)
      updateValues.body_html = parsed.data.bodyHtml;
    if (parsed.data.bodyText !== undefined)
      updateValues.body_text = parsed.data.bodyText;
    if (parsed.data.isActive !== undefined)
      updateValues.is_active = parsed.data.isActive;
    if (parsed.data.note !== undefined) updateValues.note = parsed.data.note;

    const { data: updated, error: updateErr } = await supabase
      .schema("resupply")
      .from("shop_customer_message_template_overrides")
      .update(updateValues)
      .eq("id", idCheck.data)
      .select(OVERRIDE_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (updateErr) throw updateErr;
    if (!updated) {
      throw new Error("override update returned no rows");
    }

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
        customer_id: existing.customer_id,
        template_key: existing.template_key,
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

    res.json({ override: serialize(updated) });
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

    const supabase = getSupabaseServiceRoleClient();
    const { data: existing, error: lookupErr } = await supabase
      .schema("resupply")
      .from("shop_customer_message_template_overrides")
      .select(OVERRIDE_COLUMNS)
      .eq("id", idCheck.data)
      .eq("customer_id", userIdCheck.data)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!existing) {
      res.status(404).json({ error: "override_not_found" });
      return;
    }
    if (!existing.is_active) {
      // Already soft-deleted. Idempotent.
      res.json({ override: serialize(existing) });
      return;
    }

    const adminId = req.adminUserId ?? null;
    const { data: updated, error: updateErr } = await supabase
      .schema("resupply")
      .from("shop_customer_message_template_overrides")
      .update({
        is_active: false,
        updated_by: adminId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", idCheck.data)
      .select(OVERRIDE_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (updateErr) throw updateErr;
    if (!updated) {
      throw new Error("override deactivate returned no rows");
    }

    void logAudit({
      action: "message_template_override.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: adminId,
      targetTable: "shop_customer_message_template_overrides",
      targetId: existing.id,
      metadata: {
        customer_id: existing.customer_id,
        template_key: existing.template_key,
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

    res.json({ override: serialize(updated) });
  },
);

export default router;
