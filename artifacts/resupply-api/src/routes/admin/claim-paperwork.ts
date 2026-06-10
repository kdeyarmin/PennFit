// Claim signed-paperwork ledger + bill-hold admin API.
//
// Backs the per-claim "what's still needed" panel, the patient-card
// paperwork list, the bill-hold worklist report, and the manual
// inbound-fax → requirement link. The hold itself is computed + enforced
// in lib/billing/bill-hold.ts and lib/billing/office-ally-batch.ts; these
// routes are the CSR's read + write surface over the ledger.
//
// Permissions mirror the rest of the billing/chart surface: patients.read
// to view, patients.update to mutate, reports.read for the worklist.
//
// PHI posture: requirement types, labels, status, and ids only. Patient
// display names on the worklist come from the same join the other admin
// worklists use (an admin-gated response, never a log line).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  listClaimRequirements,
  listPatientRequirements,
  outstandingLabels,
  recomputeBillHold,
  satisfyRequirement,
  seedDefaultRequirementsForClaim,
  type PaperworkRequirementRow,
  type RequirementType,
} from "../../lib/billing/bill-hold";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

const REQUIREMENT_TYPES = [
  "prescription",
  "swo",
  "cmn",
  "dwo",
  "aob",
  "abn",
  "proof_of_delivery",
  "medical_records",
  "face_to_face",
  "sleep_study",
  "agreement",
  "other",
] as const;

const REQUIREMENT_TYPE_LABELS: Record<RequirementType, string> = {
  prescription: "Signed prescription / Standard Written Order",
  swo: "Standard Written Order",
  cmn: "Certificate of Medical Necessity",
  dwo: "Detailed Written Order",
  aob: "Assignment of Benefits",
  abn: "Advance Beneficiary Notice",
  proof_of_delivery: "Signed proof of delivery",
  medical_records: "Supporting medical records",
  face_to_face: "Face-to-face evaluation note",
  sleep_study: "Sleep study report",
  agreement: "Patient agreement / financial responsibility",
  other: "Other required document",
};

function holdSummary(rows: PaperworkRequirementRow[]) {
  const missing = outstandingLabels(rows);
  return {
    held: missing.length > 0,
    outstanding: missing,
    requirements: rows,
  };
}

const uuid = z.string().uuid();

// ── GET /admin/claims/:claimId/paperwork ─────────────────────────────
router.get(
  "/admin/claims/:claimId/paperwork",
  requirePermission("patients.read"),
  async (req, res) => {
    const claimId = uuid.safeParse(req.params.claimId);
    if (!claimId.success) {
      res.status(400).json({ error: "invalid_claim_id" });
      return;
    }
    const rows = await listClaimRequirements(claimId.data);
    res.json(holdSummary(rows));
  },
);

// ── GET /admin/patients/:patientId/paperwork ─────────────────────────
router.get(
  "/admin/patients/:patientId/paperwork",
  requirePermission("patients.read"),
  async (req, res) => {
    const patientId = uuid.safeParse(req.params.patientId);
    if (!patientId.success) {
      res.status(400).json({ error: "invalid_patient_id" });
      return;
    }
    const rows = await listPatientRequirements(patientId.data);
    res.json(holdSummary(rows));
  },
);

// ── POST /admin/claims/:claimId/paperwork ────────────────────────────
const addBody = z
  .object({
    requirementType: z.enum(REQUIREMENT_TYPES),
    label: z.string().trim().min(1).max(200).optional(),
    required: z.boolean().optional(),
    expectedReturnFaxE164: z
      .string()
      .trim()
      .max(20)
      .regex(/^\+?[0-9]+$/, "must be digits / E.164")
      .optional(),
    sentVia: z
      .enum(["fax", "email", "esign", "portal", "mail", "manual"])
      .optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

router.post(
  "/admin/claims/:claimId/paperwork",
  requirePermission("patients.update"),
  adminRateLimit({ name: "bill_hold.add_requirement", preset: "mutation" }),
  async (req, res) => {
    const claimId = uuid.safeParse(req.params.claimId);
    if (!claimId.success) {
      res.status(400).json({ error: "invalid_claim_id" });
      return;
    }
    const parsed = addBody.safeParse(req.body);
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
    const { data: claim, error: claimErr } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select("id, patient_id")
      .eq("id", claimId.data)
      .limit(1)
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claim) {
      res.status(404).json({ error: "claim_not_found" });
      return;
    }

    const nowSent = parsed.data.sentVia != null;
    const { data: inserted, error: insErr } = await supabase
      .schema("resupply")
      .from("claim_paperwork_requirements")
      .insert({
        claim_id: claim.id,
        patient_id: claim.patient_id,
        requirement_type: parsed.data.requirementType,
        label:
          parsed.data.label ??
          REQUIREMENT_TYPE_LABELS[parsed.data.requirementType],
        required: parsed.data.required ?? true,
        expected_return_fax_e164: parsed.data.expectedReturnFaxE164 ?? null,
        sent_via: parsed.data.sentVia ?? null,
        sent_at: nowSent ? new Date().toISOString() : null,
        notes: parsed.data.notes ?? null,
        created_by_email: req.adminEmail ?? "unknown",
      })
      .select("id")
      .single();
    if (insErr) throw insErr;

    const recompute = await recomputeBillHold(claim.id, {
      supabase,
      actorEmail: req.adminEmail ?? null,
      writeEvent: true,
    });
    await audit(req, "bill_hold.requirement_added", inserted.id, {
      claim_id: claim.id,
      requirement_type: parsed.data.requirementType,
    });
    res.status(201).json({ id: inserted.id, billHold: recompute });
  },
);

// ── POST /admin/claims/:claimId/paperwork/seed-defaults ──────────────
router.post(
  "/admin/claims/:claimId/paperwork/seed-defaults",
  requirePermission("patients.update"),
  adminRateLimit({ name: "bill_hold.seed_defaults", preset: "mutation" }),
  async (req, res) => {
    const claimId = uuid.safeParse(req.params.claimId);
    if (!claimId.success) {
      res.status(400).json({ error: "invalid_claim_id" });
      return;
    }
    const result = await seedDefaultRequirementsForClaim(claimId.data, {
      createdByEmail: req.adminEmail ?? null,
    });
    await audit(req, "bill_hold.requirements_seeded", claimId.data, {
      created: result.created,
    });
    res.json(result);
  },
);

// ── PATCH /admin/claim-paperwork/:id ─────────────────────────────────
const patchBody = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    required: z.boolean().optional(),
    status: z.enum(["outstanding", "waived", "voided"]).optional(),
    waivedReason: z.string().trim().max(2000).optional(),
    expectedReturnFaxE164: z
      .string()
      .trim()
      .max(20)
      .regex(/^\+?[0-9]+$/)
      .optional(),
    markSentVia: z
      .enum(["fax", "email", "esign", "portal", "mail", "manual"])
      .optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "empty patch" });

router.patch(
  "/admin/claim-paperwork/:id",
  requirePermission("patients.update"),
  adminRateLimit({ name: "bill_hold.patch_requirement", preset: "mutation" }),
  async (req, res) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) {
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
    const { data: existing, error: readErr } = await supabase
      .schema("resupply")
      .from("claim_paperwork_requirements")
      .select("id, claim_id, status")
      .eq("id", id.data)
      .limit(1)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!existing) {
      res.status(404).json({ error: "requirement_not_found" });
      return;
    }

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.label != null) patch.label = parsed.data.label;
    if (parsed.data.required != null) patch.required = parsed.data.required;
    if (parsed.data.status != null) {
      patch.status = parsed.data.status;
      if (parsed.data.status === "waived") {
        patch.waived_reason = parsed.data.waivedReason ?? "Waived by CSR";
      }
    }
    if (parsed.data.waivedReason != null) {
      patch.waived_reason = parsed.data.waivedReason;
    }
    if (parsed.data.expectedReturnFaxE164 != null) {
      patch.expected_return_fax_e164 = parsed.data.expectedReturnFaxE164;
    }
    if (parsed.data.markSentVia != null) {
      patch.sent_via = parsed.data.markSentVia;
      patch.sent_at = new Date().toISOString();
    }
    if (parsed.data.notes != null) patch.notes = parsed.data.notes;

    const { error: updErr } = await supabase
      .schema("resupply")
      .from("claim_paperwork_requirements")
      .update(patch)
      .eq("id", id.data);
    if (updErr) throw updErr;

    let billHold = null;
    if (existing.claim_id) {
      billHold = await recomputeBillHold(existing.claim_id, {
        supabase,
        actorEmail: req.adminEmail ?? null,
        writeEvent: true,
      });
    }
    await audit(req, "bill_hold.requirement_updated", id.data, {
      status: parsed.data.status ?? null,
    });
    res.json({ ok: true, billHold });
  },
);

// ── POST /admin/claim-paperwork/:id/satisfy ──────────────────────────
const satisfyBody = z
  .object({
    via: z
      .enum(["upload", "esign", "portal", "mail", "manual"])
      .optional()
      .default("manual"),
    documentId: z.string().uuid().optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

router.post(
  "/admin/claim-paperwork/:id/satisfy",
  requirePermission("patients.update"),
  adminRateLimit({ name: "bill_hold.satisfy", preset: "mutation" }),
  async (req, res) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = satisfyBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    try {
      const { requirement, recompute } = await satisfyRequirement(id.data, {
        via: parsed.data.via,
        actorEmail: req.adminEmail ?? null,
        documentId: parsed.data.documentId ?? null,
        note: parsed.data.note ?? null,
      });
      await audit(req, "bill_hold.requirement_satisfied", id.data, {
        via: parsed.data.via,
        claim_id: requirement.claim_id,
      });
      res.json({ requirement, billHold: recompute });
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        res.status(404).json({ error: "requirement_not_found" });
        return;
      }
      throw err;
    }
  },
);

// ── POST /admin/claim-paperwork/:id/remind ───────────────────────────
// Records a reminder against the requirement (who chased it / how often).
// Surfaced on the worklist so the team can see what's been nudged and what
// is going stale; the opt-in sweep auto-bumps overdue rows.
router.post(
  "/admin/claim-paperwork/:id/remind",
  requirePermission("patients.update"),
  adminRateLimit({ name: "bill_hold.remind", preset: "mutation" }),
  async (req, res) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: existing, error: readErr } = await supabase
      .schema("resupply")
      .from("claim_paperwork_requirements")
      .select("id, status, reminder_count")
      .eq("id", id.data)
      .limit(1)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!existing) {
      res.status(404).json({ error: "requirement_not_found" });
      return;
    }
    if (existing.status !== "outstanding") {
      res.status(409).json({ error: "not_outstanding" });
      return;
    }
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("claim_paperwork_requirements")
      .update({
        reminder_count: (existing.reminder_count ?? 0) + 1,
        last_reminded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id.data);
    if (updErr) throw updErr;
    await audit(req, "bill_hold.requirement_reminded", id.data, {
      reminder_count: (existing.reminder_count ?? 0) + 1,
    });
    res.json({ ok: true, reminderCount: (existing.reminder_count ?? 0) + 1 });
  },
);

// ── POST /admin/inbound-faxes/:faxId/link-paperwork ──────────────────
// Manual fallback for the auto-match: a CSR links a triaged inbound fax to
// the requirement it satisfies, releasing the claim.
const linkBody = z.object({ requirementId: z.string().uuid() }).strict();

router.post(
  "/admin/inbound-faxes/:faxId/link-paperwork",
  requirePermission("patients.update"),
  adminRateLimit({ name: "bill_hold.link_fax", preset: "mutation" }),
  async (req, res) => {
    const faxId = uuid.safeParse(req.params.faxId);
    if (!faxId.success) {
      res.status(400).json({ error: "invalid_fax_id" });
      return;
    }
    const parsed = linkBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: fax, error: faxErr } = await supabase
      .schema("resupply")
      .from("inbound_faxes")
      .select("id, status")
      .eq("id", faxId.data)
      .limit(1)
      .maybeSingle();
    if (faxErr) throw faxErr;
    if (!fax) {
      res.status(404).json({ error: "fax_not_found" });
      return;
    }
    try {
      const { requirement, recompute } = await satisfyRequirement(
        parsed.data.requirementId,
        {
          via: "manual",
          actorEmail: req.adminEmail ?? null,
          inboundFaxId: faxId.data,
        },
      );
      // Mark the fax triaged so it leaves the "new" queue.
      const { error: faxStatusErr } = await supabase
        .schema("resupply")
        .from("inbound_faxes")
        .update({ status: "triaged" })
        .eq("id", faxId.data);
      if (faxStatusErr) {
        logger.warn(
          { err: faxStatusErr.message, faxId: faxId.data },
          "bill-hold: fax status update failed",
        );
      }
      await audit(req, "bill_hold.fax_linked", parsed.data.requirementId, {
        fax_id: faxId.data,
        claim_id: requirement.claim_id,
      });
      res.json({ requirement, billHold: recompute });
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        res.status(404).json({ error: "requirement_not_found" });
        return;
      }
      throw err;
    }
  },
);

// ── GET /admin/billing/bill-hold-worklist ────────────────────────────
// The report: every claim currently on bill hold, with what it's waiting
// on, oldest-held first. reports.read.
router.get(
  "/admin/billing/bill-hold-worklist",
  requirePermission("reports.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data: claims, error } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, patient_id, payer_name, date_of_service, total_billed_cents, bill_hold_reason, bill_hold_updated_at",
      )
      .eq("bill_hold", true)
      .order("bill_hold_updated_at", { ascending: true })
      .limit(500);
    if (error) throw error;
    const claimRows = claims ?? [];
    if (claimRows.length === 0) {
      res.json({ items: [], count: 0, totalHeldCents: 0 });
      return;
    }

    const claimIds = claimRows.map((c) => c.id);
    const { data: reqs, error: reqErr } = await supabase
      .schema("resupply")
      .from("claim_paperwork_requirements")
      .select(
        "claim_id, label, requirement_type, reminder_count, last_reminded_at",
      )
      .in("claim_id", claimIds)
      .eq("status", "outstanding")
      .eq("required", true);
    if (reqErr) throw reqErr;
    const outstandingByClaim = new Map<
      string,
      { label: string; requirementType: string }[]
    >();
    for (const r of reqs ?? []) {
      const cid = (r as { claim_id: string | null }).claim_id;
      if (!cid) continue;
      const list = outstandingByClaim.get(cid) ?? [];
      list.push({
        label: (r as { label: string }).label,
        requirementType: (r as { requirement_type: string }).requirement_type,
      });
      outstandingByClaim.set(cid, list);
    }

    const patientIds = [...new Set(claimRows.map((c) => c.patient_id))];
    const { data: patients } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, legal_first_name, legal_last_name")
      .in("id", patientIds);
    const nameById = new Map<string, string>();
    for (const p of patients ?? []) {
      nameById.set(
        (p as { id: string }).id,
        `${(p as { legal_first_name: string | null }).legal_first_name ?? ""} ${
          (p as { legal_last_name: string | null }).legal_last_name ?? ""
        }`.trim(),
      );
    }

    const items = claimRows.map((c) => ({
      claimId: c.id,
      patientId: c.patient_id,
      patientName: nameById.get(c.patient_id) ?? "(unknown patient)",
      payerName: c.payer_name,
      dateOfService: c.date_of_service,
      totalBilledCents: c.total_billed_cents,
      heldSince: c.bill_hold_updated_at,
      reason: c.bill_hold_reason,
      outstanding: outstandingByClaim.get(c.id) ?? [],
    }));
    res.json({
      items,
      count: items.length,
      totalHeldCents: items.reduce((s, i) => s + (i.totalBilledCents ?? 0), 0),
    });
  },
);

async function audit(
  req: {
    adminEmail?: string;
    adminUserId?: string;
    ip?: string;
    get?: (h: string) => string | undefined;
  },
  action: string,
  targetId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await logAudit({
    action,
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    targetTable: "claim_paperwork_requirements",
    targetId,
    metadata,
    ip: req.ip ?? null,
    userAgent: req.get?.("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err, action }, "bill-hold: audit write failed");
  });
}

export default router;
