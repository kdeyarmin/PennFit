// /admin/claim-templates — frequently-used line-item shapes.
//
//   GET   /admin/claim-templates?payerProfileId=
//   POST  /admin/claim-templates                              admin-only
//   PATCH /admin/claim-templates/:id                          admin-only
//   POST  /admin/patients/:id/insurance-claims/:claimId/apply-template
//         body: { templateId }
//     — stamps a template's lines onto an existing draft claim.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  type TemplateLine,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";

const router: IRouter = Router();

type Row = Database["resupply"]["Tables"]["claim_templates"]["Row"];

const HCPCS_RE = /^[A-Z]\d{4}$/;
const MOD_CSV_RE = /^([A-Z0-9]{2})(,[A-Z0-9]{2})*$/;
const ICD10_RE = /^[A-Z]\d{2}(\.[A-Z0-9]{1,4})?$/;

const templateLineSchema = z.object({
  hcpcs: z
    .string()
    .trim()
    .max(12)
    .transform((s) => s.toUpperCase())
    .refine((s) => HCPCS_RE.test(s), "must be a HCPCS code like E0601"),
  modifiers: z
    .string()
    .trim()
    .max(32)
    .transform((s) => s.toUpperCase())
    .refine(
      (s) => s === "" || MOD_CSV_RE.test(s),
      "must be a CSV of 2-char modifiers",
    ),
  units: z.number().int().min(1).max(9999),
  billed_cents: z.number().int().min(0),
  description: z.string().trim().max(240).optional(),
});

const upsertBody = z
  .object({
    slug: z.string().trim().min(2).max(80).regex(/^[a-z0-9_]+$/),
    displayName: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000).nullable().optional(),
    lines: z.array(templateLineSchema).min(1).max(20),
    defaultDiagnosisCodes: z
      .array(
        z
          .string()
          .trim()
          .max(12)
          .transform((s) => s.toUpperCase())
          .refine((s) => ICD10_RE.test(s), "ICD-10 format"),
      )
      .max(12)
      .default([]),
    scopedPayerProfileId: z.string().uuid().nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .strict();

const patchBody = upsertBody.partial();

const idParam = z.object({ id: z.string().uuid() });

const applyParams = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
});
const applyBody = z.object({ templateId: z.string().uuid() }).strict();

function rowToApi(r: Row) {
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    description: r.description,
    lines: r.lines_json.lines,
    defaultDiagnosisCodes: r.default_diagnosis_codes,
    scopedPayerProfileId: r.scoped_payer_profile_id,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get(
  "/admin/claim-templates",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  let query = supabase
    .schema("resupply")
    .from("claim_templates")
    .select(
      "id, slug, display_name, description, lines_json, default_diagnosis_codes, scoped_payer_profile_id, is_active, created_at, updated_at",
    )
    .order("display_name", { ascending: true })
    .limit(200);
  const payerProfileId =
    typeof req.query.payerProfileId === "string"
      ? req.query.payerProfileId
      : undefined;
  if (payerProfileId) {
    query = query.or(
      `scoped_payer_profile_id.eq.${payerProfileId},scoped_payer_profile_id.is.null`,
    );
  }
  const { data, error } = await query;
  if (error) throw error;
  res.json({ templates: (data ?? []).map(rowToApi) });
});

router.post(
  "/admin/claim-templates",
  requireAdminOnly,
  adminRateLimit({ name: "claim_templates.create", preset: "sensitive" }),
  async (req, res) => {
  const parsed = upsertBody.safeParse(req.body);
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
  const b = parsed.data;
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("claim_templates")
    .insert({
      slug: b.slug,
      display_name: b.displayName,
      description: b.description ?? null,
      lines_json: { lines: b.lines as TemplateLine[] },
      default_diagnosis_codes: b.defaultDiagnosisCodes,
      scoped_payer_profile_id: b.scopedPayerProfileId ?? null,
      is_active: b.isActive,
    })
    .select("id")
    .single();
  if (error) {
    if (typeof error.code === "string" && error.code === "23505") {
      res.status(409).json({ error: "slug_conflict" });
      return;
    }
    throw error;
  }
  await logAudit({
    action: "claim_template.create",
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    targetTable: "claim_templates",
    targetId: data.id,
    metadata: { slug: b.slug, line_count: b.lines.length },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err }, "claim_template.create audit write failed");
  });
  res.status(201).json({ id: data.id });
});

router.patch(
  "/admin/claim-templates/:id",
  requireAdminOnly,
  adminRateLimit({ name: "claim_templates.update", preset: "sensitive" }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
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
    const b = parsed.data;
    const update: Database["resupply"]["Tables"]["claim_templates"]["Update"] = {
      updated_at: new Date().toISOString(),
    };
    if (b.slug !== undefined) update.slug = b.slug;
    if (b.displayName !== undefined) update.display_name = b.displayName;
    if (b.description !== undefined) update.description = b.description;
    if (b.lines !== undefined) update.lines_json = { lines: b.lines as TemplateLine[] };
    if (b.defaultDiagnosisCodes !== undefined) update.default_diagnosis_codes = b.defaultDiagnosisCodes;
    if (b.scopedPayerProfileId !== undefined) update.scoped_payer_profile_id = b.scopedPayerProfileId;
    if (b.isActive !== undefined) update.is_active = b.isActive;
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("claim_templates")
      .update(update)
      .eq("id", idParsed.data.id);
    if (error) throw error;
    await logAudit({
      action: "claim_template.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "claim_templates",
      targetId: idParsed.data.id,
      metadata: {
        fields_changed: Object.keys(update).filter((k) => k !== "updated_at"),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "claim_template.update audit write failed");
    });
    res.json({ ok: true });
  },
);

// ── APPLY TEMPLATE TO A DRAFT CLAIM ─────────────────────────────────
router.post(
  "/admin/patients/:id/insurance-claims/:claimId/apply-template",
  requirePermission("patients.update"),
  adminRateLimit({ name: "claim_templates.apply", preset: "mutation" }),
  async (req, res) => {
    const idParsed = applyParams.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = applyBody.safeParse(req.body);
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

    const { data: claim } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select("id, status")
      .eq("id", idParsed.data.claimId)
      .eq("patient_id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!claim) {
      res.status(404).json({ error: "claim_not_found" });
      return;
    }
    if (claim.status !== "draft") {
      res.status(409).json({
        error: "invalid_state",
        message: `claim is in status '${claim.status}'; only draft claims accept templates`,
      });
      return;
    }

    const { data: template } = await supabase
      .schema("resupply")
      .from("claim_templates")
      .select("id, lines_json, default_diagnosis_codes, is_active")
      .eq("id", bodyParsed.data.templateId)
      .limit(1)
      .maybeSingle();
    if (!template || !template.is_active) {
      res.status(404).json({ error: "template_not_found_or_inactive" });
      return;
    }

    const lines = template.lines_json.lines;
    const lineRows = lines.map((l) => ({
      claim_id: claim.id,
      hcpcs_code: l.hcpcs,
      modifier: l.modifiers || null,
      description: l.description ?? null,
      quantity: l.units,
      billed_cents: l.billed_cents,
      status: "pending" as const,
    }));
    const { error: insertErr } = await supabase
      .schema("resupply")
      .from("insurance_claim_line_items")
      .insert(lineRows);
    if (insertErr) throw insertErr;

    // Recompute the header total to match the new line sum.
    const { data: allLines } = await supabase
      .schema("resupply")
      .from("insurance_claim_line_items")
      .select("billed_cents")
      .eq("claim_id", claim.id);
    const newTotal = (allLines ?? []).reduce(
      (s, l) => s + (l.billed_cents ?? 0),
      0,
    );
    await supabase
      .schema("resupply")
      .from("insurance_claims")
      .update({
        total_billed_cents: newTotal,
        updated_at: new Date().toISOString(),
      })
      .eq("id", claim.id);

    await supabase
      .schema("resupply")
      .from("insurance_claim_events")
      .insert({
        claim_id: claim.id,
        event_type: "note",
        note: `Applied template ${template.id} (${lines.length} lines, total ${newTotal}¢).`,
        actor_email: req.adminEmail ?? "unknown",
      });

    await logAudit({
      action: "insurance_claim.apply_template",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "insurance_claims",
      targetId: claim.id,
      metadata: {
        template_id: template.id,
        lines_added: lines.length,
        new_total_cents: newTotal,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "insurance_claim.apply_template audit write failed",
      );
    });

    res.status(201).json({
      ok: true,
      linesAdded: lines.length,
      newTotalCents: newTotal,
    });
  },
);

export default router;
