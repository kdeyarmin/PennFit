// /admin/patients/:id/manual-claims — hand-keyed claim entry for the
// exception path (Biller #32, Phase 5).
//
//   POST /admin/patients/:id/manual-claims
//
// Every claim normally originates from a shipped fulfillment. This is
// the exception: a CORRECTED (frequency 7), VOID/REPLACEMENT (8), or
// paper-backup ORIGINAL (1) claim keyed by a biller. It lands as a
// `draft` feeding the SAME draft→scrub→submit pipeline as a
// fulfillment-derived claim — it just carries `entry_source` =
// manual/adjustment plus the X12 resubmission fields (migration 0195).
//
// The validation rule "frequency 7/8 requires the original claim number"
// is a pure, unit-tested helper (validateManualClaim) so the cross-field
// constraint lives in one place. patients.update-gated, audited (ids +
// frequency only — no clinical content).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";

import { seedDefaultRequirementsForClaim } from "../../lib/billing/bill-hold";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { redactDbErr } from "../../lib/redact-db-err";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.string().trim().uuid();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ClaimFrequencyCode = "1" | "7" | "8";

export interface ManualClaimInput {
  payerName: string;
  dateOfService: string;
  claimFrequencyCode: ClaimFrequencyCode;
  originalClaimNumber?: string | null;
  insuranceCoverageId?: string | null;
  claimNumber?: string | null;
  notes?: string | null;
}

export interface ManualClaimValidation {
  ok: boolean;
  error?: string;
  /** "manual" for an original (1); "adjustment" for a replacement/void (7/8). */
  entrySource: "manual" | "adjustment";
}

/**
 * Pure: the cross-field rule the Zod object can't express alone — a
 * replacement (7) or void (8) MUST reference the original payer claim
 * number, and an original (1) must NOT carry one (it'd be meaningless /
 * misleading on the 837). Also derives entry_source from the frequency.
 * Unit-tested directly.
 */
export function validateManualClaim(
  input: Pick<ManualClaimInput, "claimFrequencyCode" | "originalClaimNumber">,
): ManualClaimValidation {
  const isAdjustment =
    input.claimFrequencyCode === "7" || input.claimFrequencyCode === "8";
  const hasOriginal =
    typeof input.originalClaimNumber === "string" &&
    input.originalClaimNumber.trim().length > 0;

  if (isAdjustment && !hasOriginal) {
    return {
      ok: false,
      error:
        "originalClaimNumber is required for a replacement (7) or void (8) claim",
      entrySource: "adjustment",
    };
  }
  if (!isAdjustment && hasOriginal) {
    return {
      ok: false,
      error: "originalClaimNumber is only valid for frequency 7 or 8",
      entrySource: "manual",
    };
  }
  return { ok: true, entrySource: isAdjustment ? "adjustment" : "manual" };
}

// A claim line: HCPCS + units + charge (+ optional comma-joined modifiers and
// a description). Mirrors insurance_claim_line_items (migration 0118) so a
// manually-keyed claim can carry the lines the 837 builder / preflight need.
const lineItem = z
  .object({
    hcpcsCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{4,12}$/, "HCPCS shape")
      .transform((s) => s.toUpperCase()),
    modifier: z.string().trim().max(32).nullable().optional(),
    description: z.string().trim().max(240).nullable().optional(),
    quantity: z.number().int().min(1).max(9999).default(1),
    billedCents: z.number().int().min(0).max(100_000_000),
  })
  .strict();

const createBody = z
  .object({
    payerName: z.string().trim().min(1).max(120),
    dateOfService: z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
    claimFrequencyCode: z.enum(["1", "7", "8"]).default("1"),
    originalClaimNumber: z.string().trim().max(64).nullable().optional(),
    insuranceCoverageId: z.string().uuid().nullable().optional(),
    payerProfileId: z.string().uuid().nullable().optional(),
    claimNumber: z.string().trim().max(64).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    lines: z.array(lineItem).max(50).optional(),
  })
  .strict();

// A duplicate is blocked only against still-active claims; a claim already
// resolved (paid / denied / closed) may legitimately be re-keyed (rebill).
const TERMINAL_CLAIM_STATUSES = "(paid,denied,closed)";

router.post(
  "/admin/patients/:id/manual-claims",
  requirePermission("patients.update"),
  adminRateLimit({ name: "manual_claim.create", preset: "sensitive" }),
  async (req, res) => {
    const idCheck = idParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = createBody.safeParse(req.body ?? {});
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

    const check = validateManualClaim(b);
    if (!check.ok) {
      res
        .status(400)
        .json({ error: "invalid_adjustment", message: check.error });
      return;
    }

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: patient, error: patientErr } = await supabase
      .from("patients")
      .select("id")
      .eq("id", idCheck.data)
      .limit(1)
      .maybeSingle();
    if (patientErr) {
      res
        .status(500)
        .json({ error: "query_failed", message: patientErr.message });
      return;
    }
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    // Duplicate guard: reject if a still-active claim already exists for the
    // same patient + payer + date-of-service + frequency (+ original claim
    // number for an adjustment). Prevents a biller double-keying the same
    // claim and double-submitting it to the payer. Resolved claims
    // (paid/denied/closed) don't block a legitimate rebill.
    let dupQuery = supabase
      .from("insurance_claims")
      .select("id")
      .eq("patient_id", idCheck.data)
      .eq("payer_name", b.payerName)
      .eq("date_of_service", b.dateOfService)
      .eq("claim_frequency_code", b.claimFrequencyCode)
      .not("status", "in", TERMINAL_CLAIM_STATUSES);
    if (check.entrySource === "adjustment" && b.originalClaimNumber) {
      dupQuery = dupQuery.eq("original_claim_number", b.originalClaimNumber);
    }
    const { data: dup, error: dupErr } = await dupQuery.limit(1).maybeSingle();
    if (dupErr) {
      res.status(500).json({ error: "query_failed", message: dupErr.message });
      return;
    }
    if (dup) {
      res.status(409).json({
        error: "duplicate_claim",
        message:
          "an active claim already exists for this patient, payer, date of service and frequency",
        existingClaimId: (dup as { id: string }).id,
      });
      return;
    }

    const lines = b.lines ?? [];
    const totalBilledCents = lines.reduce((sum, l) => sum + l.billedCents, 0);

    const { data: row, error } = await supabase
      .from("insurance_claims")
      .insert({
        patient_id: idCheck.data,
        insurance_coverage_id: b.insuranceCoverageId ?? null,
        payer_profile_id: b.payerProfileId ?? null,
        payer_name: b.payerName,
        claim_number: b.claimNumber ?? null,
        date_of_service: b.dateOfService,
        fulfillment_id: null,
        status: "draft",
        total_billed_cents: totalBilledCents,
        claim_frequency_code: b.claimFrequencyCode,
        original_claim_number: b.originalClaimNumber ?? null,
        entry_source: check.entrySource,
        notes: b.notes ?? null,
      })
      .select("id")
      .single();
    if (error) {
      res.status(500).json({ error: "insert_failed", message: error.message });
      return;
    }
    const newId = (row as Record<string, unknown>).id as string;

    // Insert the claim lines. There's no cross-statement transaction, so if
    // the line insert fails we delete the just-created header rather than
    // leave an unsubmittable line-less draft behind.
    if (lines.length > 0) {
      const { error: lineErr } = await supabase
        .from("insurance_claim_line_items")
        .insert(
          lines.map((l) => ({
            claim_id: newId,
            hcpcs_code: l.hcpcsCode,
            modifier: l.modifier ?? null,
            description: l.description ?? null,
            quantity: l.quantity,
            billed_cents: l.billedCents,
          })),
        );
      if (lineErr) {
        await supabase.from("insurance_claims").delete().eq("id", newId);
        res
          .status(500)
          .json({ error: "line_insert_failed", message: lineErr.message });
        return;
      }
    }

    // Seed the default signed-paperwork requirement set (bill hold). Gated
    // by the flag; never fails claim creation.
    if (await isFeatureEnabled("billing.bill_hold", req.orgId)) {
      try {
        await seedDefaultRequirementsForClaim(newId, {
          supabase: supabase.raw(),
          createdByEmail: req.adminEmail ?? null,
        });
      } catch (err) {
        const { error: holdErr } = await supabase
          .from("insurance_claims")
          .update({
            bill_hold: true,
            bill_hold_reason:
              "Paperwork checklist failed to initialize; regenerate before billing.",
            bill_hold_updated_at: new Date().toISOString(),
          })
          .eq("id", newId);
        if (holdErr) {
          logger.warn(
            { err: holdErr, claimId: newId },
            "manual-claim: fail-safe bill-hold flag failed",
          );
        }
        logger.warn(
          { err, claimId: newId },
          "manual-claim: bill-hold seed failed (non-fatal)",
        );
      }
    }

    await logAudit({
      action: "insurance_claim.manual_create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "insurance_claims",
      targetId: newId,
      metadata: {
        patient_id: idCheck.data,
        entry_source: check.entrySource,
        claim_frequency_code: b.claimFrequencyCode,
        line_count: lines.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err: redactDbErr(err) },
        "insurance_claim.manual_create audit write failed",
      );
    });

    res.status(201).json({
      id: newId,
      entrySource: check.entrySource,
      claimFrequencyCode: b.claimFrequencyCode,
      lineCount: lines.length,
      totalBilledCents,
    });
  },
);

export default router;
