// Shared core for the Office Ally batch-submit flow.
//
// Extracted from `routes/admin/billing-batch-submit.ts` (the original
// home of this code) so the new resubmit route at
// `POST /admin/office-ally-submissions/:id/resubmit` can reuse the
// exact same preflight + EDI build + transport + persistence sequence
// without the two paths drifting.
//
// The function returns a discriminated-union result so the calling
// route can map outcomes to HTTP status codes without leaking
// implementation details. PHI never leaves this module: only claim
// IDs, control numbers, and a coarse upload-result message ever
// appear in the return value.

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import {
  allocateControlNumbers,
  controlNumbersFromValue,
  type ControlNumbers,
  build837P,
  createOfficeAllyAdapter,
  type ClaimDetail,
  type OtherSubscriberDetail,
  type ProviderRef,
} from "@workspace/resupply-integrations-office-ally";

import {
  countOutstandingByClaim,
  seedDefaultRequirementsForClaim,
} from "./bill-hold";
import {
  gateCoverageEligibility,
  type CoverageBlock,
} from "./coverage-eligibility";
import { getCachedEligibility, verifyEligibility } from "./eligibility-verifier";
import {
  resolveBillingIdentity,
  resolveClearinghouse,
} from "./identity-resolver";
import { isFeatureEnabled } from "../feature-flags";
import { reserveIsa13Value } from "./isa13-counter";
import { logger } from "../logger";
import { publishEvent } from "../webhooks/publisher";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;
type ClaimRow = Database["resupply"]["Tables"]["insurance_claims"]["Row"];

/**
 * Cap on fresh real-time 270s the eligibility precheck will fire in a
 * single batch (deduped per coverage). Bounds the synchronous request:
 * at ~1-2s per real-time round-trip this keeps the worst case to ~20s,
 * and a large batch is almost always already-verified (cache hits)
 * anyway. Coverages beyond the cap are blocked until eligibility is checked.
 */
const MAX_PRECHECK_REALTIME_REFRESHES = 10;
const MANUAL_SUBMIT_ELIGIBILITY_FRESH_DAYS = 90;

export interface BatchSubmitInput {
  claimIds: string[];
  usageIndicator?: "P" | "T";
  /** When provided, the new office_ally_submissions row records this
   *  as `parent_submission_id` so the dashboard can show the chain. */
  parentSubmissionId?: string | null;
  adminEmail: string | null;
  adminUserId: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type BatchSubmitResult =
  | {
      ok: true;
      submissionId: string;
      claimCount: number;
      isaControlNumber: string;
      gsControlNumber: string;
      fileSizeBytes: number;
      transport: string;
      uploadOk: boolean;
      uploadError: string | null;
    }
  | {
      ok: false;
      kind:
        | "no_claims_matched"
        | "some_claims_not_found"
        | "batch_payer_mismatch"
        | "non_draft_claims_in_batch"
        | "payer_not_electronic"
        | "claim_missing_required_data"
        | "eligibility_blocked"
        | "bill_hold"
        | "concurrent_submission";
      detail: Record<string, unknown>;
    };

/**
 * Release claimed claims back to 'draft' (conflict loser, or transport
 * failure — nothing reached the clearinghouse, so the claims must stay
 * retryable). Conditional on 'submitting' so it can never stomp a row
 * a competing winner already flipped to 'submitted'. Best-effort: on a
 * write error the rows stay visibly stuck in 'submitting' (flip back to
 * 'draft' by hand) rather than risking a double transmission.
 */
async function releaseClaimsToDraft(
  supabase: SupabaseClient,
  claimIds: string[],
): Promise<void> {
  const { error } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .update({ status: "draft", updated_at: new Date().toISOString() })
    .in("id", claimIds)
    .eq("status", "submitting");
  if (error) {
    logger.error(
      { err: error.message, claimCount: claimIds.length },
      "office-ally-batch: failed to release claimed claims back to draft — claims are stuck in 'submitting'; flip to 'draft' by hand",
    );
  }
}

async function findUninitializedBillHoldClaims(
  supabase: SupabaseClient,
  claimIds: string[],
): Promise<Set<string>> {
  const uninitialized = new Set(claimIds);
  if (claimIds.length === 0) return uninitialized;
  const { data, error } = await supabase
    .schema("resupply")
    .from("claim_paperwork_requirements")
    .select("claim_id")
    .in("claim_id", claimIds);
  if (error) throw error;
  for (const row of data ?? []) {
    const claimId = (row as { claim_id: string | null }).claim_id;
    if (claimId) uninitialized.delete(claimId);
  }
  return uninitialized;
}

async function findEligibilityBlocksForSubmit(input: {
  supabase: SupabaseClient;
  claims: ClaimRow[];
  payerName: string;
  adminEmail: string | null;
}): Promise<
  Array<{
    claimId: string;
    reason:
      | "no_coverage"
      | "eligibility_missing_or_stale"
      | "eligibility_inactive"
      | "prior_auth_required"
      | "eligibility_lookup_failed";
    payerName: string;
    eligibilityCheckId: string | null;
  }>
> {
  const blocks: Array<{
    claimId: string;
    reason:
      | "no_coverage"
      | "eligibility_missing_or_stale"
      | "eligibility_inactive"
      | "prior_auth_required"
      | "eligibility_lookup_failed";
    payerName: string;
    eligibilityCheckId: string | null;
  }> = [];
  const coverageToClaims = new Map<string, ClaimRow[]>();
  for (const claim of input.claims) {
    if (!claim.insurance_coverage_id) {
      blocks.push({
        claimId: claim.id,
        reason: "no_coverage",
        payerName: input.payerName,
        eligibilityCheckId: null,
      });
      continue;
    }
    const list = coverageToClaims.get(claim.insurance_coverage_id) ?? [];
    list.push(claim);
    coverageToClaims.set(claim.insurance_coverage_id, list);
  }

  const refreshEnabled = await isFeatureEnabled(
    "billing.eligibility_precheck_refresh",
  );
  const clearinghouse = refreshEnabled
    ? await resolveClearinghouse({ supabase: input.supabase })
    : null;
  const realtimeAvailable = !!clearinghouse?.realtimeConfig;
  let freshChecks = 0;
  const freshnessMs =
    MANUAL_SUBMIT_ELIGIBILITY_FRESH_DAYS * 24 * 60 * 60 * 1000;

  for (const [coverageId, claimsForCoverage] of coverageToClaims) {
    let latest: Awaited<ReturnType<typeof getCachedEligibility>> | null;
    try {
      latest = await getCachedEligibility(coverageId, freshnessMs);
      if (
        !latest &&
        realtimeAvailable &&
        freshChecks < MAX_PRECHECK_REALTIME_REFRESHES
      ) {
        await verifyEligibility({
          insuranceCoverageId: coverageId,
          patientId: claimsForCoverage[0]!.patient_id,
          requestedByEmail:
            input.adminEmail ?? "system:eligibility-precheck",
        });
        freshChecks += 1;
        latest = await getCachedEligibility(coverageId, freshnessMs);
      }
    } catch (err) {
      logger.warn(
        {
          event: "billing.eligibility_precheck.failed_closed",
          coverageId,
          errName: err instanceof Error ? err.name : "unknown",
        },
        "billing: eligibility precheck failed; blocking submit",
      );
      for (const claim of claimsForCoverage) {
        blocks.push({
          claimId: claim.id,
          reason: "eligibility_lookup_failed",
          payerName: input.payerName,
          eligibilityCheckId: null,
        });
      }
      continue;
    }

    const reason =
      !latest
        ? "eligibility_missing_or_stale"
        : latest.is_active !== true
          ? "eligibility_inactive"
          : latest.requires_prior_auth === true
            ? "prior_auth_required"
            : null;
    if (!reason) continue;
    for (const claim of claimsForCoverage) {
      blocks.push({
        claimId: claim.id,
        reason,
        payerName: input.payerName,
        eligibilityCheckId: latest?.id ?? null,
      });
    }
  }

  return blocks;
}

export async function executeOfficeAllyBatchSubmit(
  input: BatchSubmitInput,
): Promise<BatchSubmitResult> {
  const supabase = getSupabaseServiceRoleClient();

  const { data: claims, error } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("*")
    .in("id", input.claimIds);
  if (error) throw error;
  if (!claims || claims.length === 0) {
    return { ok: false, kind: "no_claims_matched", detail: {} };
  }
  if (claims.length !== input.claimIds.length) {
    const missing = input.claimIds.filter(
      (id) => !claims.some((c) => c.id === id),
    );
    return {
      ok: false,
      kind: "some_claims_not_found",
      detail: { missing },
    };
  }

  const payerProfileIds = [...new Set(claims.map((c) => c.payer_profile_id))];
  if (payerProfileIds.length !== 1 || !payerProfileIds[0]) {
    return {
      ok: false,
      kind: "batch_payer_mismatch",
      detail: {
        message:
          "all claims in a batch must reference the same payer_profile_id",
      },
    };
  }

  const draftIssues = claims.filter((c) => c.status !== "draft");
  if (draftIssues.length > 0) {
    return {
      ok: false,
      kind: "non_draft_claims_in_batch",
      detail: { claimIds: draftIssues.map((c) => c.id) },
    };
  }

  // Bill hold — a claim with outstanding REQUIRED signed paperwork is not
  // released for billing. Re-reads the live ledger (never the denormalised
  // bill_hold flag) so a drifted cache can't let an under-documented claim
  // out the door. Feature-flagged so it can be turned off whole-cloth, and
  // inert for any claim that has no requirements tracked against it.
  if (await isFeatureEnabled("billing.bill_hold")) {
    const uninitialized = await findUninitializedBillHoldClaims(
      supabase,
      claims.map((c) => c.id),
    );
    const initializationFailures: Array<{
      claimId: string;
      reason: string;
    }> = [];
    for (const claimId of uninitialized) {
      try {
        await seedDefaultRequirementsForClaim(claimId, {
          supabase,
          createdByEmail: input.adminEmail ?? "system:office-ally-submit",
        });
      } catch (err) {
        logger.warn(
          {
            event: "billing.bill_hold.initialize_failed",
            claimId,
            errName: err instanceof Error ? err.name : "unknown",
          },
          "office-ally-batch: bill-hold initialization failed; blocking submit",
        );
        initializationFailures.push({
          claimId,
          reason: "paperwork_checklist_uninitialized",
        });
      }
    }
    if (initializationFailures.length > 0) {
      return {
        ok: false,
        kind: "bill_hold",
        detail: { held: initializationFailures },
      };
    }
    const outstanding = await countOutstandingByClaim(
      claims.map((c) => c.id),
      supabase,
    );
    const heldClaimIds = claims
      .filter((c) => (outstanding.get(c.id) ?? 0) > 0)
      .map((c) => ({
        claimId: c.id,
        outstandingCount: outstanding.get(c.id)!,
      }));
    if (heldClaimIds.length > 0) {
      return { ok: false, kind: "bill_hold", detail: { held: heldClaimIds } };
    }
  }

  const { data: payer } = await supabase
    .schema("resupply")
    .from("payer_profiles")
    .select(
      "id, payer_legal_name, office_ally_payer_id, paper_only, claim_format, is_active, edi_enrollment_status",
    )
    .eq("id", payerProfileIds[0])
    .limit(1)
    .maybeSingle();
  if (
    !payer ||
    !payer.is_active ||
    payer.paper_only ||
    !payer.office_ally_payer_id ||
    payer.edi_enrollment_status !== "enrolled"
  ) {
    return {
      ok: false,
      kind: "payer_not_electronic",
      detail: {
        message:
          "payer must be active + electronic + carry an office_ally_payer_id + edi_enrollment_status='enrolled'",
        ediEnrollmentStatus: payer?.edi_enrollment_status ?? null,
      },
    };
  }

  const eligibilityBlocks = await findEligibilityBlocksForSubmit({
    supabase,
    claims: claims as ClaimRow[],
    payerName: payer.payer_legal_name,
    adminEmail: input.adminEmail,
  });
  if (eligibilityBlocks.length > 0) {
    return {
      ok: false,
      kind: "eligibility_blocked",
      detail: { blocked: eligibilityBlocks },
    };
  }

  // Legacy eligibility precheck (feature-flagged). Before we transmit, consult
  // each claim's most recent parsed 270/271. A coverage that is
  // explicitly inactive or flags prior-auth-required would deny, so we
  // hold the whole batch and hand the offending claims back for the CSR
  // to re-verify / fix. FAIL OPEN: a missing/stale result, no coverage,
  // or ANY lookup error allows the claim through — the same posture as
  // the order-confirm guard (resupply.eligibility_enforcement). Runs
  // before the EDI build so a blocked batch transmits nothing.
  //
  // When billing.eligibility_precheck_refresh is ALSO on and real-time
  // eligibility is configured, a coverage with no recent result is checked
  // fresh (real-time 270) instead of failing open — deduped per coverage
  // and capped per batch so a large batch can't fan out into a slow
  // synchronous request.
  if (await isFeatureEnabled("billing.eligibility_precheck")) {
    const refreshEnabled = await isFeatureEnabled(
      "billing.eligibility_precheck_refresh",
    );
    const realtimeAvailable = refreshEnabled
      ? !!(await resolveClearinghouse({ supabase })).realtimeConfig
      : false;

    // Dedup coverages — verify each at most once even if several claims in
    // the batch share it.
    const coverageToPatient = new Map<string, string>();
    for (const claim of claims) {
      if (
        claim.insurance_coverage_id &&
        !coverageToPatient.has(claim.insurance_coverage_id)
      ) {
        coverageToPatient.set(claim.insurance_coverage_id, claim.patient_id);
      }
    }

    const blockByCoverage = new Map<string, CoverageBlock>();
    let freshChecks = 0;
    for (const [coverageId, patientId] of coverageToPatient) {
      try {
        const allowRefresh =
          realtimeAvailable && freshChecks < MAX_PRECHECK_REALTIME_REFRESHES;
        const { block, refreshed } = await gateCoverageEligibility(
          coverageId,
          patientId,
          payer.payer_legal_name,
          {
            refreshIfStale: allowRefresh,
            requestedByEmail: input.adminEmail ?? "system:eligibility-precheck",
          },
        );
        if (refreshed) freshChecks += 1;
        if (block) blockByCoverage.set(coverageId, block);
      } catch (err) {
        logger.warn(
          {
            event: "billing.eligibility_precheck.failed",
            coverageId,
            errName: err instanceof Error ? err.name : "unknown",
          },
          "billing: eligibility precheck failed; allowing claim (fail open)",
        );
      }
    }

    if (blockByCoverage.size > 0) {
      const blocked = claims
        .filter(
          (c) =>
            c.insurance_coverage_id &&
            blockByCoverage.has(c.insurance_coverage_id),
        )
        .map((c) => {
          const block = blockByCoverage.get(c.insurance_coverage_id!)!;
          return {
            claimId: c.id,
            reason: block.reason,
            payerName: block.payerName,
            eligibilityCheckId: block.eligibilityCheckId,
          };
        });
      return { ok: false, kind: "eligibility_blocked", detail: { blocked } };
    }
  }

  const detailEntries: ClaimDetail[] = [];
  for (const claim of claims) {
    const detail = await buildOneDetail(
      supabase,
      claim,
      payer.payer_legal_name,
      payer.office_ally_payer_id,
    );
    if (!detail) {
      return {
        ok: false,
        kind: "claim_missing_required_data",
        detail: { claimId: claim.id },
      };
    }
    detailEntries.push(detail);
  }

  // Atomically claim the batch BEFORE any transport work: flip every
  // claim draft → 'submitting' in one conditional UPDATE. The earlier
  // "all claims are draft" read is only advisory — the SFTP upload below
  // can take 60s+ (×3 retries), and during that window a second submit
  // (operator double-click, the auto-submit tick, a resubmit) used to
  // pass the same read and transmit the SAME claims under a fresh ISA13:
  // both files accepted, duplicate claims billed to the payer
  // (docs/app-review-2026-06-10.md P1-1). With the conditional UPDATE
  // exactly one submitter wins each claim; a partial win means someone
  // else is mid-flight, so we release what we took and report the
  // conflict. The 'submitting' state is admitted by migration 0298.
  const claimedAtIso = new Date().toISOString();
  const batchClaimIds = claims.map((c) => c.id);
  const { data: claimedRows, error: batchClaimErr } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .update({ status: "submitting", updated_at: claimedAtIso })
    .in("id", batchClaimIds)
    .eq("status", "draft")
    .select("id");
  if (batchClaimErr) throw batchClaimErr;
  const claimedIds = (claimedRows ?? []).map((r) => r.id as string);
  if (claimedIds.length !== claims.length) {
    if (claimedIds.length > 0) {
      await releaseClaimsToDraft(supabase, claimedIds);
    }
    return {
      ok: false,
      kind: "concurrent_submission",
      detail: {
        message:
          "another submission claimed part of this batch first — nothing was transmitted",
        claimIds: batchClaimIds.filter((id) => !claimedIds.includes(id)),
      },
    };
  }

  // Atomic reservation first (counter table, migration 0308) — unique
  // by construction across BOTH the claims and eligibility pools and
  // race-free under concurrency. The legacy MAX-read below survives
  // only as the pre-migration fallback; see lib/billing/isa13-counter.
  const reservedIsa = await reserveIsa13Value(supabase);
  let control: ControlNumbers;
  if (reservedIsa !== null) {
    control = controlNumbersFromValue(reservedIsa, Date.now());
  } else {
    const { data: priorHigh, error: priorHighErr } = await supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .select("isa_control_number")
      .order("isa_control_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    // Throw on a read error rather than allocating blind: the
    // allocator's monotonicity guarantee DEPENDS on previousHighest. A
    // swallowed error here falls back to the time-derived base alone,
    // which can re-mint a used interchange control number — Office
    // Ally rejects the reused ISA13 at the 999 and the file needs
    // manual replay.
    if (priorHighErr) throw priorHighErr;
    control = allocateControlNumbers({
      submittedAt: Date.now(),
      sequence: 1,
      previousHighest: priorHigh?.isa_control_number ?? undefined,
    });
  }

  // Guard: any exception before the upload is purely pre-flight; nothing
  // reached the clearinghouse, so release the claimed batch back to 'draft'.
  const fileName = `PF-BATCH-${control.interchangeControlNumber}.txt`;
  let identity: Awaited<ReturnType<typeof resolveBillingIdentity>>;
  let submission: Awaited<
    ReturnType<ReturnType<typeof createOfficeAllyAdapter>["submitClaims"]>
  >;
  try {
    identity = await resolveBillingIdentity({ supabase });
    const adapter = createOfficeAllyAdapter({
      submitterOverride: identity.submitter,
      billingProviderOverride: identity.billingProvider,
      usageIndicatorOverride: identity.usageIndicator,
    });
    submission = await adapter.submitClaims({
      control,
      fileName,
      usageIndicatorOverride: input.usageIndicator,
      claims: detailEntries,
    });
  } catch (err) {
    // Pre-upload failure — nothing was transmitted. Release the claims so
    // the operator can retry the batch from a clean state.
    await releaseClaimsToDraft(supabase, claimedIds);
    throw err;
  }

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
      submitted_by_email: input.adminEmail ?? "unknown",
      attempted_claim_ids: claims.map((c) => c.id),
      parent_submission_id: input.parentSubmissionId ?? null,
    })
    .select("id")
    .single();
  if (subErr) {
    if (submission.upload.ok) {
      // The file was transmitted to the clearinghouse but we couldn't
      // persist the submission row. The claims are still 'submitting' —
      // releasing them to 'draft' here would risk a second transmission
      // of the same batch. Log the ISA control number so an operator can
      // reconcile the clearinghouse acknowledgement against the DB.
      logger.error(
        {
          err: subErr.message,
          claimIds: claimedIds,
          isaControlNumber: submission.interchangeControlNumber,
        },
        "office-ally-batch: submission row insert failed after successful upload — claims left in 'submitting' for manual reconciliation",
      );
    } else {
      // Upload did not succeed — release claims to draft so the operator
      // can retry without manual intervention.
      await releaseClaimsToDraft(supabase, claimedIds);
    }
    throw subErr;
  }

  if (submission.upload.ok) {
    const nowIso = new Date().toISOString();
    for (const claim of claims) {
      const { error: claimUpdateErr } = await supabase
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
      if (claimUpdateErr) {
        logger.error(
          {
            err: claimUpdateErr.message,
            claimId: claim.id,
            submissionId: subRow.id,
          },
          "office-ally-batch: claim status update failed — claim uploaded but not marked submitted",
        );
      }
      const { error: claimEventErr } = await supabase
        .schema("resupply")
        .from("insurance_claim_events")
        .insert({
          claim_id: claim.id,
          event_type: "submitted",
          payer_ref: submission.interchangeControlNumber,
          note:
            input.parentSubmissionId != null
              ? `Resubmitted (parent ${input.parentSubmissionId}) in batch of ${claims.length} (${submission.transport}).`
              : `Submitted in batch of ${claims.length} (${submission.transport}).`,
          actor_email: input.adminEmail ?? "unknown",
        });
      if (claimEventErr) {
        logger.warn(
          {
            err: claimEventErr.message,
            claimId: claim.id,
            submissionId: subRow.id,
          },
          "office-ally-batch: claim event insert failed (non-fatal)",
        );
      }
      void publishEvent({
        eventType: "claim.submitted",
        payload: {
          claim_id: claim.id,
          patient_id: claim.patient_id,
          payer_profile_id: payer.id,
          office_ally_submission_id: subRow.id,
          parent_submission_id: input.parentSubmissionId ?? null,
          batch_size: claims.length,
          transport: submission.transport,
        },
      });
    }
  } else {
    // Transport failed — nothing reached the clearinghouse. Release the
    // claimed batch back to 'draft' so the operator can retry it.
    await releaseClaimsToDraft(supabase, claimedIds);
  }

  await logAudit({
    action:
      input.parentSubmissionId != null
        ? "insurance_claim.batch_resubmit_office_ally"
        : submission.upload.ok
          ? "insurance_claim.batch_submit_office_ally"
          : "insurance_claim.batch_submit_office_ally_failed",
    adminEmail: input.adminEmail ?? null,
    adminUserId: input.adminUserId ?? null,
    targetTable: "office_ally_submissions",
    targetId: subRow.id,
    metadata: {
      claim_count: claims.length,
      payer_profile_id: payer.id,
      transport: submission.transport,
      upload_ok: submission.upload.ok,
      parent_submission_id: input.parentSubmissionId ?? null,
    },
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  }).catch((err) => {
    logger.warn({ err }, "insurance_claim.batch_submit audit write failed");
  });

  return {
    ok: true,
    submissionId: subRow.id,
    claimCount: claims.length,
    isaControlNumber: submission.interchangeControlNumber,
    gsControlNumber: submission.groupControlNumber,
    fileSizeBytes: submission.fileSizeBytes,
    transport: submission.transport,
    uploadOk: submission.upload.ok,
    uploadError: submission.upload.ok ? null : submission.upload.message,
  };
}

// Regenerate the 837P EDI payload for an existing submission row.
//
// Used by the "View raw 837P" download in the OA Operations admin
// page. Returns null when the submission row is missing, has no
// attempted_claim_ids, or any linked claim no longer satisfies
// buildOneDetail (rare — happens if a CSR deleted a claim after
// submit). The caller surfaces null as 404.
//
// Uses the *original* ISA/GS control numbers from the submission row
// so the regenerated text matches what was actually uploaded — the
// download is for audit + support tickets, not a new transmission.
export async function buildEdiPayloadForSubmission(
  submissionId: string,
): Promise<{ payload: string; usageIndicator: "P" | "T" } | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: sub } = await supabase
    .schema("resupply")
    .from("office_ally_submissions")
    .select("id, isa_control_number, gs_control_number, attempted_claim_ids")
    .eq("id", submissionId)
    .limit(1)
    .maybeSingle();
  if (!sub) return null;
  const claimIds = sub.attempted_claim_ids ?? [];
  if (claimIds.length === 0) return null;

  const { data: claims } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("*")
    .in("id", claimIds);
  if (!claims || claims.length === 0) return null;

  const payerProfileIds = [...new Set(claims.map((c) => c.payer_profile_id))];
  if (payerProfileIds.length !== 1 || !payerProfileIds[0]) return null;
  const { data: payer } = await supabase
    .schema("resupply")
    .from("payer_profiles")
    .select("payer_legal_name, office_ally_payer_id")
    .eq("id", payerProfileIds[0])
    .limit(1)
    .maybeSingle();
  if (!payer || !payer.office_ally_payer_id) return null;

  const details: ClaimDetail[] = [];
  for (const claim of claims) {
    const d = await buildOneDetail(
      supabase,
      claim,
      payer.payer_legal_name,
      payer.office_ally_payer_id,
    );
    if (!d) return null;
    details.push(d);
  }

  const identity = await resolveBillingIdentity({ supabase });
  const built = build837P({
    submitter: identity.submitter,
    receiver: { interchangeId: "OFFCLY", organizationName: "OFFICE ALLY" },
    billingProvider: identity.billingProvider,
    claims: details,
    control: {
      interchangeControlNumber: sub.isa_control_number,
      groupControlNumber: sub.gs_control_number,
      transactionSetControlNumber: "0001",
      builtAt: Date.now(),
    },
    usageIndicator: identity.usageIndicator,
  });
  return { payload: built.payload, usageIndicator: identity.usageIndicator };
}

export async function buildOneDetail(
  supabase: SupabaseClient,
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
    { data: renderingProvider },
    { data: referringProvider },
    { data: secondaryCoverage },
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
      .select("hcpcs_code, modifier, billed_cents, quantity, narrative")
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
    claim.rendering_provider_id
      ? supabase
          .schema("resupply")
          .from("providers")
          .select("legal_name, npi")
          .eq("id", claim.rendering_provider_id)
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    claim.referring_provider_id
      ? supabase
          .schema("resupply")
          .from("providers")
          .select("legal_name, npi, practice_address")
          .eq("id", claim.referring_provider_id)
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    claim.secondary_coverage_id
      ? supabase
          .schema("resupply")
          .from("insurance_coverages")
          .select("member_id, payer_name, policyholder_relationship")
          .eq("id", claim.secondary_coverage_id)
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  if (!coverage || !patient || !lines || lines.length === 0) return null;
  const addr = patient.address as {
    line1?: string;
    city?: string;
    state?: string;
    zip?: string;
  } | null;
  if (!addr?.line1 || !addr.city || !addr.state || !addr.zip) return null;
  const primaryDx = sleep?.diagnosis_icd10 ?? "G47.33";
  const subscriberAddress = {
    line1: addr.line1,
    city: addr.city,
    state: addr.state,
    zip: addr.zip,
  };

  // Payer sequence drives both the destination SBR01 (2000B) and which
  // COB loop we emit. A secondary/tertiary claim is billed downstream
  // and must disclose the PRIOR (primary) payer's adjudication.
  const payerSequence = (claim.payer_sequence as string | null) ?? "primary";
  const payerResponsibility: "P" | "S" | "T" =
    payerSequence === "tertiary"
      ? "T"
      : payerSequence === "secondary"
        ? "S"
        : "P";

  // Loop 2320/2330. Downstream claim → disclose the primary that already
  // paid (AMT*D from the generation-time snapshot). Primary claim that
  // merely has a secondary on file → disclose that secondary (no prior
  // payment yet). Money in cents; no PHI is logged from here.
  let otherSubscriber: OtherSubscriberDetail | null = null;
  if (payerResponsibility !== "P") {
    otherSubscriber = await loadPrimaryCobDisclosure(
      supabase,
      claim,
      {
        firstName: patient.legal_first_name,
        lastName: patient.legal_last_name,
        dateOfBirth: patient.date_of_birth,
      },
      subscriberAddress,
    );
  } else if (secondaryCoverage) {
    otherSubscriber = {
      payerResponsibility: "S",
      priorPayerPaidCents: null,
      subscriber: {
        firstName: patient.legal_first_name,
        lastName: patient.legal_last_name,
        dateOfBirth: patient.date_of_birth,
        gender: "U",
        memberId: secondaryCoverage.member_id,
        address: subscriberAddress,
        relationshipCode: relationshipFor(
          secondaryCoverage.policyholder_relationship,
        ),
      },
      payer: {
        organizationName: secondaryCoverage.payer_name,
        // The secondary coverage carries only a free-text payer_name (no
        // structured payer_profile link), so we cannot emit a real payer id.
        // Send the name only (the 837P builder omits NM108/09) rather than a
        // name-as-id that would mis-route the COB loop.
        payerId: "",
      },
    };
  }

  // A2 — line-level ordering-provider loop (2420E NM1*DK). DMEPOS-strict
  // placement of the ordering physician (the prescriber, == our referring
  // provider) so Medicare's PECOS edit binds at the line. Gated behind a
  // seeded-OFF feature flag: this CHANGES the live 837P (adds a loop), so
  // it stays off until a live 277CA test cycle confirms the payer accepts
  // it. When off → byte-identical output. Additive to the existing 2310D
  // referring loop, not a replacement.
  const orderingProvider: ProviderRef | null =
    referringProvider &&
    (await isFeatureEnabled("billing.line_ordering_provider"))
      ? {
          npi: referringProvider.npi,
          firstName: splitFirstName(referringProvider.legal_name),
          lastName: splitLastName(referringProvider.legal_name),
          address: jsonToPostalAddress(referringProvider.practice_address),
        }
      : null;

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
      address: subscriberAddress,
      relationshipCode: relationshipFor(coverage.policyholder_relationship),
    },
    payer: {
      organizationName: payerLegalName,
      payerId,
    },
    serviceLines: lines.map((l) => ({
      hcpcsCode: l.hcpcs_code,
      modifiers: ((l.modifier ?? "") as string)
        .split(",")
        .map((m: string) => m.trim().toUpperCase())
        .filter((m: string) => m.length === 2),
      // EDI 837P SV1-02 expects the EXTENDED line charge — the
      // per-unit billed_cents multiplied by the quantity. Submitting
      // the per-unit amount under-bills every multi-unit line and the
      // payer remits less than the claim total intended. We store
      // per-unit in `insurance_claim_line_items.billed_cents` so that
      // the admin UI can show the per-unit price; the multiplication
      // happens here at the EDI-build boundary.
      billedCents: l.billed_cents * l.quantity,
      units: l.quantity,
      serviceDate: claim.date_of_service,
      diagnosisPointers: [1],
      // Loop 2400 NTE*ADD — Medicare DME requires a narrative (item
      // description + MSRP) on miscellaneous/NOC HCPCS lines. The builder
      // emits the NTE only when this is set; null → no NTE.
      note: (l.narrative as string | null) ?? null,
      // Loop 2420E NM1*DK — flag-gated line-level ordering provider (A2).
      orderingProvider,
    })),
    renderingProvider: renderingProvider
      ? {
          npi: renderingProvider.npi,
          firstName: splitFirstName(renderingProvider.legal_name),
          lastName: splitLastName(renderingProvider.legal_name),
        }
      : null,
    referringProvider: referringProvider
      ? {
          npi: referringProvider.npi,
          firstName: splitFirstName(referringProvider.legal_name),
          lastName: splitLastName(referringProvider.legal_name),
        }
      : null,
    // Loop 2320/2330 — coordination of benefits (computed above).
    payerResponsibility,
    otherSubscriber,
    // CLM05-3 frequency + REF*F8 original ICN for corrected (7) / void (8)
    // claims — without these a replacement/void is transmitted as a brand-new
    // original and the payer adjudicates it as a duplicate (or, worse, pays a
    // claim that was meant to be voided). The DB CHECK limits the column to
    // {1,7,8}; guard anyway so an unexpected value falls back to original.
    claimFrequencyCode:
      claim.claim_frequency_code === "7" || claim.claim_frequency_code === "8"
        ? claim.claim_frequency_code
        : "1",
    originalClaimNumber: claim.original_claim_number,
  };
}

/**
 * Build the 2320/2330 disclosure of the PRIMARY payer for a downstream
 * (secondary/tertiary) claim. The primary payer name comes from the
 * linked primary claim; the prior-paid amount (AMT*D) is the snapshot
 * frozen onto this claim when the secondary was generated (Biller #28),
 * so a later primary adjustment can't silently change what we disclose.
 * Returns null when the link is missing (degrade to no COB loop rather
 * than emit a malformed one).
 */
async function loadPrimaryCobDisclosure(
  supabase: SupabaseClient,
  claim: ClaimRow,
  patientName: { firstName: string; lastName: string; dateOfBirth: string },
  subscriberAddress: {
    line1: string;
    city: string;
    state: string;
    zip: string;
  },
): Promise<OtherSubscriberDetail | null> {
  if (!claim.primary_claim_id) return null;
  const { data: primaryClaim } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("payer_name, insurance_coverage_id, payer_profile_id")
    .eq("id", claim.primary_claim_id)
    .limit(1)
    .maybeSingle();
  if (!primaryClaim?.payer_name) return null;

  let memberId = "";
  let relationship: string | null = null;
  if (primaryClaim.insurance_coverage_id) {
    const { data: cov } = await supabase
      .schema("resupply")
      .from("insurance_coverages")
      .select("member_id, policyholder_relationship")
      .eq("id", primaryClaim.insurance_coverage_id)
      .limit(1)
      .maybeSingle();
    memberId = cov?.member_id ?? "";
    relationship = cov?.policyholder_relationship ?? null;
  }

  // Resolve the primary payer's REAL id from its payer_profile. The primary
  // claim carries a structured payer_profile_id (unlike the free-text
  // secondary coverage), so this is a reliable id lookup — the 837P 2330B
  // "other payer" loop needs a payer id, not a name. Fall back to name-only
  // (empty id) when the profile or its id is missing.
  let otherPayerId = "";
  if (primaryClaim.payer_profile_id) {
    const { data: prof } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select("office_ally_payer_id, edi_5010_payer_id")
      .eq("id", primaryClaim.payer_profile_id)
      .limit(1)
      .maybeSingle();
    otherPayerId = prof?.office_ally_payer_id ?? prof?.edi_5010_payer_id ?? "";
  }

  return {
    payerResponsibility: "P",
    priorPayerPaidCents: claim.cob_primary_paid_cents ?? null,
    subscriber: {
      firstName: patientName.firstName,
      lastName: patientName.lastName,
      dateOfBirth: patientName.dateOfBirth,
      gender: "U",
      memberId,
      address: subscriberAddress,
      relationshipCode: relationshipFor(relationship),
    },
    payer: {
      organizationName: primaryClaim.payer_name,
      payerId: otherPayerId,
    },
  };
}

function relationshipFor(
  r: string | null | undefined,
): "18" | "01" | "19" | "G8" {
  return r === "self"
    ? "18"
    : r === "spouse"
      ? "01"
      : r === "child"
        ? "19"
        : "G8";
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

/**
 * Coerce a provider's `practice_address` jsonb into the 837P PostalAddress
 * shape (loop 2420E N3/N4). Accepts the `zip` / `postalCode` / `postal_code`
 * key variants the address blobs use. Returns null unless line1/city/state/
 * zip are all present — the builder then emits NM1*DK without N3/N4 rather
 * than a malformed partial address.
 */
function jsonToPostalAddress(
  raw: unknown,
): { line1: string; city: string; state: string; zip: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const line1 = str(a.line1);
  const city = str(a.city);
  const state = str(a.state);
  const zip = str(a.zip) || str(a.postalCode) || str(a.postal_code);
  if (!line1 || !city || !state || !zip) return null;
  return { line1, city, state, zip };
}
