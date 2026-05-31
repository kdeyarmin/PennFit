// /admin/patients/:patientId/alert-message-overrides — admin CRUD for
// per-patient overrides of the alert library (sister to the global
// /admin/alerts surface and a patient-keyed analogue of
// /admin/shop/customers/:userId/message-template-overrides).
//
// Endpoints:
//   POST   /admin/patients/alert-message-overrides/list
//          — list every override for one patient (patientId in body).
//   POST   /admin/patients/:patientId/alert-message-overrides
//          — create an override for (alert_key, channel). Required
//            note explaining WHY.
//   PATCH  /admin/patients/:patientId/alert-message-overrides/:id
//          — edit override fields or toggle isActive.
//   DELETE /admin/patients/:patientId/alert-message-overrides/:id
//          — soft-delete via isActive=false (the row stays as the
//            audit anchor; isActive=true reactivates).
//
// The dispatch path (lib/alerts/dispatch.ts) layers an active override
// per-field on top of the global alert message; a partial override
// (e.g. just the SMS body) inherits the not-overridden fields. An
// override with isActive=false SUPPRESSES the alert for that patient
// on that channel.
//
// Editor enforcement matches the global alert path:
//   * Each {{var}} in subject / body_html / body_text must be in the
//     parent alert_definition's allowed_variables. The endpoint
//     fetches the definition to validate.
//   * SMS bodies must be plain ASCII (a non-GSM-7 char triples the
//     Twilio segment cost).
//
// Audit: every write logs `alert_message_override.{create,update}`
// with a metadata-only envelope (patient_id, alert_key, channel,
// fields_changed). Bodies stay OUT of the envelope.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  getSupabaseServiceRoleClient,
  type Database,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { isAsciiOnly } from "../../lib/message-templates/sms";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

type OverrideRow =
  Database["resupply"]["Tables"]["alert_message_overrides"]["Row"];
type OverrideUpdate =
  Database["resupply"]["Tables"]["alert_message_overrides"]["Update"];

const router: IRouter = Router();

const overrideMutationLimiter = adminRateLimit({
  name: "alert_message_override.mutation",
  preset: "sensitive",
});

const channelEnum = z.enum(["email", "sms", "voice"]);
const patientIdParam = z.string().uuid();
const overrideIdParam = z.string().uuid();
const listBody = z.object({ patientId: z.string().uuid() }).strict();
const alertKeyShape = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/);

const createBody = z
  .object({
    alertKey: alertKeyShape,
    channel: channelEnum,
    subject: z.string().trim().max(1000).nullable().optional(),
    bodyHtml: z.string().trim().max(200000).nullable().optional(),
    bodyText: z.string().trim().max(50000).nullable().optional(),
    isActive: z.boolean().optional(),
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
  patientId: string;
  alertKey: string;
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

const OVERRIDE_COLUMNS =
  "id, patient_id, alert_key, channel, subject, body_html, body_text, is_active, note, created_by, updated_by, created_at, updated_at";

function serialize(row: OverrideRow): OverrideView {
  return {
    id: row.id,
    patientId: row.patient_id,
    alertKey: row.alert_key,
    channel: row.channel,
    subject: row.subject ?? null,
    bodyHtml: row.body_html ?? null,
    bodyText: row.body_text ?? null,
    isActive: row.is_active,
    note: row.note ?? null,
    createdAt: row.created_at,
    createdBy: row.created_by ?? null,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? null,
  };
}

/** Names of `{{snake_case}}` tokens in `s` that aren't in `allowed`. */
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

/** Fetch the parent alert's allowed_variables (empty if no such alert). */
async function allowedVariablesForAlert(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  alertKey: string,
): Promise<{ exists: boolean; allowed: string[] }> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("alert_definitions")
    .select("allowed_variables")
    .eq("key", alertKey)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { exists: false, allowed: [] };
  return { exists: true, allowed: data.allowed_variables ?? [] };
}

router.post(
  "/admin/patients/alert-message-overrides/list",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const parsed = listBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_patient_id" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("alert_message_overrides")
      .select(OVERRIDE_COLUMNS)
      .eq("patient_id", parsed.data.patientId)
      .order("alert_key", { ascending: true })
      .order("channel", { ascending: true })
      .limit(200);
    if (error) throw error;
    res.json({ overrides: (rows ?? []).map(serialize) });
  },
);

router.post(
  "/admin/patients/:patientId/alert-message-overrides",
  requirePermission("admin.tools.manage"),
  overrideMutationLimiter,
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.patientId);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_patient_id" });
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

    const { exists, allowed } = await allowedVariablesForAlert(
      supabase,
      parsed.data.alertKey,
    );
    if (!exists) {
      res.status(404).json({ error: "alert_not_found" });
      return;
    }
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
      parsed.data.bodyText != null &&
      !isAsciiOnly(parsed.data.bodyText)
    ) {
      res.status(400).json({ error: "sms_body_text_must_be_ascii" });
      return;
    }

    const adminId = req.adminUserId ?? null;
    const { data: inserted, error: insertErr } = await supabase
      .schema("resupply")
      .from("alert_message_overrides")
      .insert({
        patient_id: idCheck.data,
        alert_key: parsed.data.alertKey,
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
    if (!inserted) throw new Error("alert override insert returned no rows");

    // Observability only — structured log, NOT an audit write (see
    // CLAUDE.md: resupply-audit is a no-op stub; no new writes).
    logger.info(
      {
        event: "alert_message_override_created",
        patient_id: idCheck.data,
        alert_key: inserted.alert_key,
        channel: inserted.channel,
        is_active: inserted.is_active,
        admin_user_id: adminId,
      },
      "admin created an alert message override",
    );

    res.status(201).json({ override: serialize(inserted) });
  },
);

router.patch(
  "/admin/patients/:patientId/alert-message-overrides/:id",
  requirePermission("admin.tools.manage"),
  overrideMutationLimiter,
  async (req, res) => {
    const patientIdCheck = patientIdParam.safeParse(req.params.patientId);
    if (!patientIdCheck.success) {
      res.status(400).json({ error: "invalid_patient_id" });
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
      .from("alert_message_overrides")
      .select(OVERRIDE_COLUMNS)
      .eq("id", idCheck.data)
      .eq("patient_id", patientIdCheck.data)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!existing) {
      res.status(404).json({ error: "override_not_found" });
      return;
    }

    const { allowed } = await allowedVariablesForAlert(
      supabase,
      existing.alert_key,
    );
    const nextSubject =
      parsed.data.subject !== undefined
        ? parsed.data.subject
        : existing.subject;
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
      parsed.data.bodyText != null &&
      !isAsciiOnly(parsed.data.bodyText)
    ) {
      res.status(400).json({ error: "sms_body_text_must_be_ascii" });
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
      .from("alert_message_overrides")
      .update(updateValues)
      .eq("id", idCheck.data)
      .select(OVERRIDE_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (updateErr) throw updateErr;
    if (!updated) throw new Error("alert override update returned no rows");

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
    // Observability only — structured log, NOT an audit write.
    logger.info(
      {
        event: "alert_message_override_updated",
        patient_id: existing.patient_id,
        alert_key: existing.alert_key,
        channel: existing.channel,
        admin_user_id: adminId,
        fields_changed: fieldsChanged,
      },
      "admin updated an alert message override",
    );

    res.json({ override: serialize(updated) });
  },
);

router.delete(
  "/admin/patients/:patientId/alert-message-overrides/:id",
  requirePermission("admin.tools.manage"),
  overrideMutationLimiter,
  async (req, res) => {
    const patientIdCheck = patientIdParam.safeParse(req.params.patientId);
    if (!patientIdCheck.success) {
      res.status(400).json({ error: "invalid_patient_id" });
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
      .from("alert_message_overrides")
      .select(OVERRIDE_COLUMNS)
      .eq("id", idCheck.data)
      .eq("patient_id", patientIdCheck.data)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!existing) {
      res.status(404).json({ error: "override_not_found" });
      return;
    }
    if (!existing.is_active) {
      res.json({ override: serialize(existing) });
      return;
    }

    const adminId = req.adminUserId ?? null;
    const { data: updated, error: updateErr } = await supabase
      .schema("resupply")
      .from("alert_message_overrides")
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
    if (!updated) throw new Error("alert override deactivate returned no rows");

    // Observability only — structured log, NOT an audit write.
    logger.info(
      {
        event: "alert_message_override_deactivated",
        patient_id: existing.patient_id,
        alert_key: existing.alert_key,
        channel: existing.channel,
        admin_user_id: adminId,
      },
      "admin deactivated an alert message override",
    );

    res.json({ override: serialize(updated) });
  },
);

export default router;
