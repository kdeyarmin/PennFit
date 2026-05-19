// POST /admin/billing/batch-submit-office-ally
//
// Bulk-submit N draft claims in a single 837P interchange envelope.
// Massive cost win vs. one-file-per-claim: Office Ally's file
// management overhead is per-file, not per-claim, and ops teams batch
// 25-100 claims per upload as the industry-standard pattern.
//
// Body: { claimIds: string[] }
//
// Preconditions enforced per claim:
//   * status === 'draft'
//   * payer_profile_id set + electronically billable
//   * insurance_coverage_id + line items present
//   * patient address structured
//   * payer_profile_id is the SAME across all claims in the batch
//     (one 837P interchange = one receiver = one payer)
//
// Side effects:
//   * one office_ally_submissions row with claim_count = N.
//   * status='submitted' + submitted_at + office_ally_submission_id
//     on each successful claim.
//   * one insurance_claim_events 'submitted' row per claim.
//   * one audit_log row + per-claim publishEvent('claim.submitted').

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import {
  allocateControlNumbers,
  createOfficeAllyAdapter,
  type ClaimDetail,
} from "@workspace/resupply-integrations-office-ally";

import { resolveBillingIdentity } from "../../lib/billing/identity-resolver";
import { logger } from "../../lib/logger";
import { publishEvent } from "../../lib/webhooks/publisher";
import {
  requireAdmin,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const body = z
  .object({
    claimIds: z.array(z.string().uuid()).min(1).max(100),
    usageIndicator: z.enum(["P", "T"]).optional(),
  })
  .strict();

type ClaimRow = Database["resupply"]["Tables"]["insurance_claims"]["Row"];

router.post(
  "/admin/billing/batch-submit-office-ally",
  requireAdmin,
  async (req, res) => {
    const parsed = body.safeParse(req.body);
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
    const { data: claims, error } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select("*")
      .in("id", parsed.data.claimIds);
    if (error) throw error;
    if (!claims || claims.length === 0) {
      res.status(404).json({ error: "no_claims_matched" });
      return;
    }
    if (claims.length !== parsed.data.claimIds.length) {
      const missing = parsed.data.claimIds.filter(
        (id) => !claims.some((c) => c.id === id),
      );
      res
        .status(409)
        .json({ error: "some_claims_not_found", missing });
      return;
    }
    // Single-payer batch enforcement.
    const payerProfileIds = [
      ...new Set(claims.map((c) => c.payer_profile_id)),
    ];
    if (payerProfileIds.length !== 1 || !payerProfileIds[0]) {
      res.status(409).json({
        error: "batch_payer_mismatch",
        message:
          "all claims in a batch must reference the same payer_profile_id",
      });
      return;
    }
    const draftIssues = claims.filter((c) => c.status !== "draft");
    if (draftIssues.length > 0) {
      res.status(409).json({
        error: "non_draft_claims_in_batch",
        claimIds: draftIssues.map((c) => c.id),
      });
      return;
    }

    // Load payer + per-claim coverage + lines + patient up-front.
    const { data: payer } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select(
        "id, payer_legal_name, office_ally_payer_id, paper_only, claim_format, is_active",
      )
      .eq("id", payerProfileIds[0])
      .limit(1)
      .maybeSingle();
    if (
      !payer ||
      !payer.is_active ||
      payer.paper_only ||
      !payer.office_ally_payer_id
    ) {
      res.status(409).json({
        error: "payer_not_electronic",
        message:
          "payer must be active + electronic + carry an office_ally_payer_id",
      });
      return;
    }

    // Build per-claim ClaimDetail entries.
    const detailEntries: ClaimDetail[] = [];
    const claimContextById = new Map<string, ClaimRow>();
    for (const claim of claims) {
      claimContextById.set(claim.id, claim);
      const detail = await buildOneDetail(supabase, claim, payer.payer_legal_name, payer.office_ally_payer_id);
      if (!detail) {
        res.status(409).json({
          error: "claim_missing_required_data",
          claimId: claim.id,
        });
        return;
      }
      detailEntries.push(detail);
    }

    // Allocate control numbers monotonically against prior OA submissions.
    const { data: priorHigh } = await supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .select("isa_control_number")
      .order("isa_control_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const control = allocateControlNumbers({
      submittedAt: Date.now(),
      sequence: 1,
      previousHighest: priorHigh?.isa_control_number ?? undefined,
    });

    // Resolve identity + submit.
    const identity = await resolveBillingIdentity({ supabase });
    const adapter = createOfficeAllyAdapter({
      submitterOverride: identity.submitter,
      billingProviderOverride: identity.billingProvider,
      usageIndicatorOverride: identity.usageIndicator,
    });
    const fileName = `PF-BATCH-${control.interchangeControlNumber}.txt`;
    const submission = await adapter.submitClaims({
      control,
      fileName,
      usageIndicatorOverride: parsed.data.usageIndicator,
      claims: detailEntries,
    });

    // Persist OA submission row.
    const status = submission.upload.ok
      ? identity.source === "stub"
        ? "queued"
        : "uploaded"
      : "transport_failed";
    const { data: subRow, error: subErr } = await supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .insert({
        file_name: fileName,
        isa_control_number: submission.interchangeControlNumber,
        gs_control_number: submission.groupControlNumber,
        status,
        file_size_bytes: submission.fileSizeBytes,
        claim_count: submission.claimCount,
        rejection_reason: submission.upload.ok
          ? null
          : submission.upload.message.slice(0, 2000),
        submitted_by_email: req.adminEmail ?? "unknown",
      })
      .select("id")
      .single();
    if (subErr) throw subErr;

    // Per-claim advance.
    if (submission.upload.ok) {
      const nowIso = new Date().toISOString();
      for (const claim of claims) {
        await supabase
          .schema("resupply")
          .from("insurance_claims")
          .update({
            status: "submitted",
            submitted_at: nowIso,
            claim_number: submission.interchangeControlNumber,
            office_ally_submission_id: subRow.id,
            updated_at: nowIso,
          })
          .eq("id", claim.id);
        await supabase
          .schema("resupply")
          .from("insurance_claim_events")
          .insert({
            claim_id: claim.id,
            event_type: "submitted",
            payer_ref: submission.interchangeControlNumber,
            note: `Submitted in batch of ${claims.length} (${submission.transport}).`,
            actor_email: req.adminEmail ?? "unknown",
          });
        void publishEvent({
          eventType: "claim.submitted",
          payload: {
            claim_id: claim.id,
            patient_id: claim.patient_id,
            payer_profile_id: payer.id,
            office_ally_submission_id: subRow.id,
            batch_size: claims.length,
            transport: submission.transport,
          },
        });
      }
    }

    await logAudit({
      action: submission.upload.ok
        ? "insurance_claim.batch_submit_office_ally"
        : "insurance_claim.batch_submit_office_ally_failed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "office_ally_submissions",
      targetId: subRow.id,
      metadata: {
        claim_count: claims.length,
        payer_profile_id: payer.id,
        transport: submission.transport,
        upload_ok: submission.upload.ok,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "insurance_claim.batch_submit audit write failed",
      );
    });

    res.status(submission.upload.ok ? 201 : 502).json({
      ok: submission.upload.ok,
      submissionId: subRow.id,
      claimCount: claims.length,
      isaControlNumber: submission.interchangeControlNumber,
      gsControlNumber: submission.groupControlNumber,
      fileSizeBytes: submission.fileSizeBytes,
      transport: submission.transport,
      uploadError: submission.upload.ok ? null : submission.upload.message,
    });
  },
);

async function buildOneDetail(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  claim: ClaimRow,
  payerLegalName: string,
  payerId: string,
): Promise<ClaimDetail | null> {
  if (!claim.insurance_coverage_id) return null;
  const [
    { data: coverage },
    { data: patient },
    { data: lines },
    { data: sleep },
    { data: referringProvider },
  ] = await Promise.all([
    supabase
      .schema("resupply")
      .from("insurance_coverages")
      .select("member_id, policyholder_relationship")
      .eq("id", claim.insurance_coverage_id)
      .limit(1)
      .maybeSingle(),
    supabase
      .schema("resupply")
      .from("patients")
      .select("legal_first_name, legal_last_name, date_of_birth, address")
      .eq("id", claim.patient_id)
      .limit(1)
      .maybeSingle(),
    supabase
      .schema("resupply")
      .from("insurance_claim_line_items")
      .select("hcpcs_code, modifier, billed_cents, quantity")
      .eq("claim_id", claim.id)
      .order("created_at", { ascending: true }),
    supabase
      .schema("resupply")
      .from("sleep_studies")
      .select("diagnosis_icd10")
      .eq("patient_id", claim.patient_id)
      .not("diagnosis_icd10", "is", null)
      .order("study_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    claim.referring_provider_id
      ? supabase
          .schema("resupply")
          .from("providers")
          .select("legal_name, npi")
          .eq("id", claim.referring_provider_id)
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  if (!coverage || !patient || !lines || lines.length === 0) return null;
  const addr = patient.address as
    | { line1?: string; city?: string; state?: string; zip?: string }
    | null;
  if (!addr?.line1 || !addr.city || !addr.state || !addr.zip) return null;
  const primaryDx = sleep?.diagnosis_icd10 ?? "G47.33";
  return {
    internalClaimId: claim.id.slice(0, 38),
    totalBilledCents: claim.total_billed_cents,
    placeOfServiceCode: "12",
    diagnosisCodes: [primaryDx],
    priorAuthNumber: null,
    subscriber: {
      firstName: patient.legal_first_name,
      lastName: patient.legal_last_name,
      dateOfBirth: patient.date_of_birth,
      gender: "U",
      memberId: coverage.member_id,
      address: {
        line1: addr.line1,
        city: addr.city,
        state: addr.state,
        zip: addr.zip,
      },
      relationshipCode:
        coverage.policyholder_relationship === "self"
          ? "18"
          : coverage.policyholder_relationship === "spouse"
            ? "01"
            : coverage.policyholder_relationship === "child"
              ? "19"
              : "G8",
    },
    payer: {
      organizationName: payerLegalName,
      payerId,
    },
    serviceLines: lines.map((l) => ({
      hcpcsCode: l.hcpcs_code,
      modifiers: (l.modifier ?? "")
        .split(",")
        .map((m) => m.trim().toUpperCase())
        .filter((m) => m.length === 2),
      billedCents: l.billed_cents,
      units: l.quantity,
      serviceDate: claim.date_of_service,
      diagnosisPointers: [1],
    })),
    referringProvider: referringProvider
      ? {
          npi: referringProvider.npi,
          firstName: splitFirstName(referringProvider.legal_name),
          lastName: splitLastName(referringProvider.legal_name),
        }
      : null,
  };
}

function splitFirstName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.includes(",")) {
    const [, rest = ""] = trimmed.split(",", 2);
    return rest.trim().split(/\s+/)[0] ?? "";
  }
  return trimmed.split(/\s+/)[0] ?? "";
}
function splitLastName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.includes(",")) return trimmed.split(",", 2)[0]!.trim();
  const parts = trimmed.split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1]! : trimmed;
}

export default router;
