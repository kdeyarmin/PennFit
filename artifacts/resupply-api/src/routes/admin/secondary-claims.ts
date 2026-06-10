// Biller #28 — secondary / coordination-of-benefits claims.
//
//   GET  /admin/billing/secondary-eligible   (reports.read)
//     Primary claims the primary payer has PAID that carry a secondary
//     coverage + a patient-responsibility balance, and don't yet have a
//     secondary claim. The biller's COB worklist.
//
//   POST /admin/claims/:id/generate-secondary (admin.tools.manage)
//     Roll the balance the primary left to the secondary payer: create a
//     new 'secondary' claim (same services / line items) carrying a
//     SNAPSHOT of the primary's adjudication (paid / contractual / patient
//     responsibility) for the 837 2320/2330 COB loop. Status 'draft' — the
//     biller reviews + submits through the normal batch path.
//
// The COB math is a pure, tested helper. PHI posture: money + ids only in
// logs — never patient detail.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

export interface PrimaryClaimTotals {
  status: string;
  payer_sequence?: string | null;
  total_billed_cents: number;
  total_allowed_cents: number;
  total_paid_cents: number;
  patient_responsibility_cents: number;
  secondary_coverage_id: string | null;
}

export type CobDerivation =
  | {
      eligible: true;
      cob: {
        primaryPaidCents: number;
        contractualCents: number;
        patientRespCents: number;
        /** What the primary left for the secondary to consider. */
        billableToSecondaryCents: number;
      };
    }
  | {
      eligible: false;
      reason:
        | "not_primary"
        | "no_secondary_coverage"
        | "primary_not_paid"
        | "no_balance";
    };

/**
 * Pure: derive the COB amounts a secondary claim needs from the primary's
 * adjudicated totals. Slice 1 handles the canonical case — the primary
 * PAID part of the claim and left a patient-responsibility balance the
 * secondary may cover. Denied-primary COB (full balance forwarded) is a
 * follow-up. No I/O — unit-tested directly.
 */
export function deriveSecondaryCob(p: PrimaryClaimTotals): CobDerivation {
  if ((p.payer_sequence ?? "primary") !== "primary") {
    return { eligible: false, reason: "not_primary" };
  }
  if (!p.secondary_coverage_id) {
    return { eligible: false, reason: "no_secondary_coverage" };
  }
  if (p.status !== "paid") {
    return { eligible: false, reason: "primary_not_paid" };
  }
  const contractualCents = Math.max(
    0,
    p.total_billed_cents - p.total_allowed_cents,
  );
  const patientRespCents = Math.max(0, p.patient_responsibility_cents);
  if (patientRespCents <= 0) {
    return { eligible: false, reason: "no_balance" };
  }
  return {
    eligible: true,
    cob: {
      primaryPaidCents: p.total_paid_cents,
      contractualCents,
      patientRespCents,
      billableToSecondaryCents: patientRespCents,
    },
  };
}

export interface EligibleCandidate {
  id: string;
  patient_id: string;
  payer_name: string;
  total_billed_cents: number;
  total_paid_cents: number;
  patient_responsibility_cents: number;
  status: string;
  payer_sequence?: string | null;
  secondary_coverage_id: string | null;
  total_allowed_cents: number;
}

export interface EligibleItem {
  claimId: string;
  patientId: string;
  primaryPayerName: string;
  billedCents: number;
  primaryPaidCents: number;
  patientResponsibilityCents: number;
}

/**
 * Pure: filter the candidate primaries to those eligible for a secondary
 * claim AND not already having one. `existingSecondaryPrimaryIds` is the
 * set of primary-claim ids that already spawned a secondary.
 */
export function filterSecondaryEligible(
  candidates: EligibleCandidate[],
  existingSecondaryPrimaryIds: ReadonlySet<string>,
): EligibleItem[] {
  const out: EligibleItem[] = [];
  for (const c of candidates) {
    if (existingSecondaryPrimaryIds.has(c.id)) continue;
    const d = deriveSecondaryCob(c);
    if (!d.eligible) continue;
    out.push({
      claimId: c.id,
      patientId: c.patient_id,
      primaryPayerName: c.payer_name,
      billedCents: c.total_billed_cents,
      primaryPaidCents: d.cob.primaryPaidCents,
      patientResponsibilityCents: d.cob.patientRespCents,
    });
  }
  // Biggest outstanding balance first — most recoverable.
  return out.sort(
    (a, b) => b.patientResponsibilityCents - a.patientResponsibilityCents,
  );
}

const CLAIM_SELECT =
  "id, patient_id, payer_name, status, payer_sequence, secondary_coverage_id, " +
  "total_billed_cents, total_allowed_cents, total_paid_cents, patient_responsibility_cents, " +
  "date_of_service, fulfillment_id";

router.get(
  "/admin/billing/secondary-eligible",
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const candRes = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(CLAIM_SELECT)
      .eq("payer_sequence", "primary")
      .eq("status", "paid")
      .not("secondary_coverage_id", "is", null)
      .order("patient_responsibility_cents", { ascending: false })
      .limit(500);
    if (candRes.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: candRes.error.message });
      return;
    }
    const candidates = (candRes.data ?? []) as unknown as EligibleCandidate[];

    // Which of these primaries already have a secondary?
    const ids = candidates.map((c) => c.id);
    const existing = new Set<string>();
    if (ids.length > 0) {
      const secRes = await supabase
        .schema("resupply")
        .from("insurance_claims")
        .select("primary_claim_id")
        .eq("payer_sequence", "secondary")
        .in("primary_claim_id", ids);
      if (secRes.error) {
        res
          .status(500)
          .json({ error: "query_failed", message: secRes.error.message });
        return;
      }
      for (const r of (secRes.data ?? []) as Array<{
        primary_claim_id?: string | null;
      }>) {
        if (r.primary_claim_id) existing.add(r.primary_claim_id);
      }
    }

    const items = filterSecondaryEligible(candidates, existing);
    res.json({ eligible: items, count: items.length });
  },
);

const idParam = z.string().uuid();

router.post(
  "/admin/claims/:id/generate-secondary",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_claim_id" });
      return;
    }
    const primaryId = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    const primaryRes = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(CLAIM_SELECT)
      .eq("id", primaryId)
      .maybeSingle();
    if (primaryRes.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: primaryRes.error.message });
      return;
    }
    if (!primaryRes.data) {
      res.status(404).json({ error: "claim_not_found" });
      return;
    }
    const primary = primaryRes.data as unknown as PrimaryClaimTotals & {
      patient_id: string;
      secondary_coverage_id: string | null;
      date_of_service: string;
      fulfillment_id: string | null;
    };

    const derivation = deriveSecondaryCob(primary);
    if (!derivation.eligible) {
      res.status(409).json({ error: derivation.reason });
      return;
    }
    const { cob } = derivation;

    // Already generated?
    const dupRes = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select("id")
      .eq("payer_sequence", "secondary")
      .eq("primary_claim_id", primaryId)
      .maybeSingle();
    if (dupRes.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: dupRes.error.message });
      return;
    }
    if (dupRes.data) {
      res.status(409).json({
        error: "secondary_exists",
        secondaryClaimId: (dupRes.data as { id: string }).id,
      });
      return;
    }

    // Resolve the secondary payer name.
    const covRes = await supabase
      .schema("resupply")
      .from("insurance_coverages")
      .select("payer_name")
      .eq("id", primary.secondary_coverage_id ?? "")
      .maybeSingle();
    if (covRes.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: covRes.error.message });
      return;
    }
    const secondaryPayerName =
      (covRes.data as { payer_name?: string | null } | null)?.payer_name ??
      "Secondary payer";

    // Resolve the SECONDARY payer's profile so the claim can be batch-
    // submitted (executeOfficeAllyBatchSubmit requires a payer_profile_id).
    // Best-effort by name — null if the payer has no profile yet, in which
    // case the biller sets it before submission. The primary's
    // payer_profile_id would be WRONG here (that's the primary payer).
    let secondaryPayerProfileId: string | null = null;
    if (covRes.data) {
      const escaped = secondaryPayerName.replace(
        /[\\%_]/g,
        (c: string) => `\\${c}`,
      );
      const profRes = await supabase
        .schema("resupply")
        .from("payer_profiles")
        .select("id")
        .ilike("display_name", escaped)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();
      secondaryPayerProfileId =
        (profRes.data as { id?: string } | null)?.id ?? null;
    }

    // Create the secondary claim header (snapshot the COB amounts).
    const insRes = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .insert({
        patient_id: primary.patient_id,
        insurance_coverage_id: primary.secondary_coverage_id,
        payer_name: secondaryPayerName,
        payer_profile_id: secondaryPayerProfileId,
        date_of_service: primary.date_of_service,
        fulfillment_id: primary.fulfillment_id,
        status: "draft",
        total_billed_cents: primary.total_billed_cents,
        payer_sequence: "secondary",
        primary_claim_id: primaryId,
        entry_source: "adjustment",
        claim_frequency_code: "1",
        cob_primary_paid_cents: cob.primaryPaidCents,
        cob_contractual_cents: cob.contractualCents,
        cob_patient_resp_cents: cob.patientRespCents,
      } as unknown as Record<string, unknown>)
      .select("id")
      .maybeSingle();
    if (insRes.error || !insRes.data) {
      // 23505 on insurance_claims_secondary_per_primary_unique
      // (migration 0303): a concurrent generate won the race between
      // our SELECT dedupe and this INSERT. Surface the same 409 the
      // SELECT path produces instead of a 500 — the secondary exists.
      if (insRes.error?.code === "23505") {
        const winner = await supabase
          .schema("resupply")
          .from("insurance_claims")
          .select("id")
          .eq("payer_sequence", "secondary")
          .eq("primary_claim_id", primaryId)
          .maybeSingle();
        res.status(409).json({
          error: "secondary_exists",
          secondaryClaimId: (winner.data as { id: string } | null)?.id ?? null,
        });
        return;
      }
      res.status(500).json({ error: "secondary_create_failed" });
      return;
    }
    const secondaryClaimId = (insRes.data as { id: string }).id;

    // Copy the line items so the secondary is a complete, submittable claim.
    const linesRes = await supabase
      .schema("resupply")
      .from("insurance_claim_line_items")
      .select("hcpcs_code, modifier, description, quantity, billed_cents")
      .eq("claim_id", primaryId);
    if (linesRes.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: linesRes.error.message });
      return;
    }
    const lines = (linesRes.data ?? []) as Array<Record<string, unknown>>;
    if (lines.length > 0) {
      const copyRes = await supabase
        .schema("resupply")
        .from("insurance_claim_line_items")
        .insert(
          lines.map((l) => ({
            claim_id: secondaryClaimId,
            hcpcs_code: String(l.hcpcs_code ?? ""),
            modifier: (l.modifier as string | null) ?? null,
            description: (l.description as string | null) ?? null,
            quantity: typeof l.quantity === "number" ? l.quantity : 1,
            billed_cents:
              typeof l.billed_cents === "number" ? l.billed_cents : 0,
            status: "pending",
          })) as unknown as Record<string, unknown>[],
        );
      if (copyRes.error) {
        // The header exists; surface the partial failure honestly rather
        // than pretend success.
        res.status(500).json({
          error: "line_copy_failed",
          secondaryClaimId,
          message: copyRes.error.message,
        });
        return;
      }
    }

    req.log?.info(
      {
        event: "admin.secondary_claim.generated",
        primary_claim_id: primaryId,
        secondary_claim_id: secondaryClaimId,
        line_count: lines.length,
        adminEmail: req.adminEmail,
      },
      "admin.secondary_claim.generated",
    );

    res.status(201).json({ secondaryClaimId, cob, lineCount: lines.length });
  },
);

export default router;
