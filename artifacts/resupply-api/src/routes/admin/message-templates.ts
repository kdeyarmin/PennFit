// /admin/message-templates — read + update for the customer-message
// template library (Phase 1; see docs/proposals/customer-message-templates.md).
//
// Endpoints:
//   GET    /admin/message-templates                 — paginated list, filterable
//   GET    /admin/message-templates/:id             — single row
//   PATCH  /admin/message-templates/:id             — update editable fields
//
// Phase 1 deliberately does NOT include POST or DELETE. Templates
// are seeded by code (paired with each renderer migration) and
// disabled via the `isActive` flag rather than deleted — the row is
// the audit anchor for "this template existed and someone edited
// it." The admin UI in Phase 2 will surface only these three verbs.
//
// Editor enforcement:
//   * The Zod schema rejects fields outside the editable allowlist
//     (templateKey, channel, allowedVariables — those are part of
//     the call-site contract and must not drift via UI edit).
//   * Variable token syntax in the new body / subject is checked:
//     any `{{var}}` reference that isn't in the row's
//     allowedVariables is rejected with a 400 + the offending
//     token list, so an admin can't accidentally introduce a
//     placeholder the call site never substitutes (which would
//     ship the literal `{{ssn}}` to the customer).
//
// Cache invalidation:
//   The render path (lib/resupply-templates) caches lookups for 5
//   minutes. After a PATCH, edits take up to 5 min to propagate.
//   Phase 4 may add an explicit invalidation hop (pg-boss broadcast
//   or stripping the cache entry on edit) if that latency is felt.
//
// Audit:
//   Every PATCH writes a `message_template.update` audit row with a
//   metadata-only envelope: {template_key, channel, fields_changed,
//   old_lengths, new_lengths}. Bodies are NEVER in the audit metadata
//   (treat templates as content that may quote PHI-shaped patterns
//   even though the Zod schema rules out actual PHI).

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

type MessageTemplateRow =
  Database["resupply"]["Tables"]["message_templates"]["Row"];
type MessageTemplateUpdate =
  Database["resupply"]["Tables"]["message_templates"]["Update"];

const router: IRouter = Router();

// Per-admin rate limit on template writes (B-07 envelope). 30/hour
// is plenty of headroom for legitimate copy edits while bounding a
// compromised admin's blast radius. Reads are not rate-limited.
const adminMessageTemplateMutationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  name: "admin_message_template_mutation",
  keyFn: (req) => req.adminUserId ?? "unknown",
});

const channelEnum = z.enum(["email", "sms", "voice", "push"]);

const idParam = z.string().uuid();

const listQuery = z
  .object({
    templateKey: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9_.-]*$/)
      .optional(),
    channel: channelEnum.optional(),
    includeInactive: z.enum(["0", "1"]).optional(),
  })
  .strict();

const patchBody = z
  .object({
    subject: z.string().trim().max(1000).nullable().optional(),
    bodyHtml: z.string().trim().max(200000).nullable().optional(),
    bodyText: z.string().trim().min(1).max(50000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

interface MessageTemplateView {
  id: string;
  templateKey: string;
  channel: string;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string;
  allowedVariables: string[];
  isActive: boolean;
  updatedAt: string;
  updatedBy: string | null;
  createdAt: string;
  createdBy: string | null;
}

function serialize(row: MessageTemplateRow): MessageTemplateView {
  return {
    id: row.id,
    templateKey: row.template_key,
    channel: row.channel,
    subject: row.subject ?? null,
    bodyHtml: row.body_html ?? null,
    bodyText: row.body_text,
    allowedVariables: row.allowed_variables ?? [],
    isActive: row.is_active,
    // PostgREST returns timestamptz as ISO string already.
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? null,
    createdAt: row.created_at,
    createdBy: row.created_by ?? null,
  };
}

/**
 * Scan a string for `{{snake_case}}` tokens and return any names
 * that aren't in `allowed`. Mirrors the substitution regex in
 * `@workspace/resupply-templates`'s applyVariables so the editor's
 * pre-flight check matches what the renderer will actually do.
 */
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

router.get("/admin/message-templates", requireAdmin, async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_query",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const includeInactive = parsed.data.includeInactive === "1";

  const supabase = getSupabaseServiceRoleClient();
  let templatesQuery = supabase
    .schema("resupply")
    .from("message_templates")
    .select(
      "id, template_key, channel, subject, body_html, body_text, allowed_variables, is_active, updated_at, updated_by, created_at, created_by",
    )
    .order("template_key", { ascending: true })
    .order("channel", { ascending: true })
    .limit(500);
  if (parsed.data.templateKey) {
    templatesQuery = templatesQuery.eq("template_key", parsed.data.templateKey);
  }
  if (parsed.data.channel) {
    templatesQuery = templatesQuery.eq("channel", parsed.data.channel);
  }
  if (!includeInactive) {
    templatesQuery = templatesQuery.eq("is_active", true);
  }
  const { data: rows, error } = await templatesQuery;
  if (error) throw error;
  res.json({ templates: (rows ?? []).map(serialize) });
});

router.get(
  "/admin/message-templates/:id",
  requireAdmin,
  async (req, res) => {
    const idCheck = idParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("message_templates")
      .select(
        "id, template_key, channel, subject, body_html, body_text, allowed_variables, is_active, updated_at, updated_by, created_at, created_by",
      )
      .eq("id", idCheck.data)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "template_not_found" });
      return;
    }
    res.json({ template: serialize(row) });
  },
);

router.patch(
  "/admin/message-templates/:id",
  requireAdmin,
  adminMessageTemplateMutationLimiter,
  async (req, res) => {
    const idCheck = idParam.safeParse(req.params.id);
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
    const { data: existing, error: existingErr } = await supabase
      .schema("resupply")
      .from("message_templates")
      .select(
        "id, template_key, channel, subject, body_html, body_text, allowed_variables, is_active, updated_at, updated_by, created_at, created_by",
      )
      .eq("id", idCheck.data)
      .limit(1)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (!existing) {
      res.status(404).json({ error: "template_not_found" });
      return;
    }

    // Pre-flight check: every `{{var}}` token in the new content
    // must be in the row's allowedVariables. The check runs against
    // the to-be-applied union (existing values + the patch overrides)
    // so an admin can't sneak in a non-allowlisted placeholder.
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
    const allowed = existing.allowed_variables ?? [];
    const offenders = [
      ...disallowedTokens(nextSubject, allowed),
      ...disallowedTokens(nextBodyHtml, allowed),
      ...disallowedTokens(nextBodyText, allowed),
    ];
    if (offenders.length > 0) {
      res.status(400).json({
        error: "disallowed_variables",
        message:
          "These placeholders are not in the template's allowedVariables list:",
        offending: [...new Set(offenders)],
        allowed,
      });
      return;
    }
    if (
      existing.channel === "sms" &&
      parsed.data.bodyText !== undefined &&
      !isAsciiOnly(parsed.data.bodyText)
    ) {
      res.status(400).json({
        error: "sms_body_text_must_be_ascii",
      });
      return;
    }

    const adminId = req.adminUserId ?? null;
    // Snake-case columns at the write boundary; the Drizzle path's
    // $onUpdateFn that bumped updated_at becomes an explicit JS-side
    // timestamp here since PostgREST won't run it for us.
    const updateValues: MessageTemplateUpdate = {
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

    const { data: updated, error: updateErr } = await supabase
      .schema("resupply")
      .from("message_templates")
      .update(updateValues)
      .eq("id", idCheck.data)
      .select(
        "id, template_key, channel, subject, body_html, body_text, allowed_variables, is_active, updated_at, updated_by, created_at, created_by",
      )
      .limit(1)
      .maybeSingle();
    if (updateErr) throw updateErr;
    if (!updated) {
      res.status(404).json({ error: "template_not_found" });
      return;
    }

    const fieldsChanged: string[] = [];
    for (const k of ["subject", "bodyHtml", "bodyText", "isActive"] as const) {
      if (parsed.data[k] !== undefined) fieldsChanged.push(k);
    }

    void logAudit({
      action: "message_template.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: adminId,
      targetTable: "message_templates",
      targetId: existing.id,
      // Body content stays OUT of the audit envelope (treat templates
      // as content that may quote PHI-shaped patterns even though
      // the editor disallows it). Lengths give ops enough signal to
      // spot a content-blanking edit without leaking the body.
      metadata: {
        template_key: existing.template_key,
        channel: existing.channel,
        fields_changed: fieldsChanged,
        old_lengths: {
          subject: existing.subject?.length ?? null,
          body_html: existing.body_html?.length ?? null,
          body_text: existing.body_text.length,
        },
        new_lengths: {
          subject: nextSubject?.length ?? null,
          body_html: nextBodyHtml?.length ?? null,
          body_text: nextBodyText.length,
        },
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err, templateId: existing.id },
        "message_template.update audit write failed",
      );
    });

    res.json({ template: serialize(updated) });
  },
);

export default router;
