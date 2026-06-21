// Shared core for creating ONE insurance claim from a fulfillment.
//
// Extracted from routes/admin/fulfillment-to-claim.ts so the single-claim
// route AND the batch-create route
// (routes/admin/billing-batch-create-claims.ts) run the IDENTICAL
// build → duplicate-guard → insert header → insert lines → initial event →
// bill-hold seed → audit sequence and can never diverge (same posture as the
// shared denial-analysis-runner / denial-rate modules).
//
// Returns a discriminated result for the EXPECTED outcomes (created /
// claim_exists / fulfillment_not_found). UNEXPECTED DB errors THROW, so the
// single route surfaces a 500 unchanged and the batch route can isolate the
// failure per item (its loop wraps each call in try/catch).
//
// PHI posture: reads PHI via the builder but never logs it; the audit row
// captures structural metadata only.

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { seedDefaultRequirementsForClaim } from "./bill-hold";
import {
  buildClaimFromFulfillment,
  buildClaimLineRows,
  type ProposedClaim,
} from "./claim-builder";

export interface CreateClaimFromFulfillmentInput {
  fulfillmentId: string;
  /** Tenant whose org-scoped client owns the INSERTs. */
  orgId: string;
  actorEmail: string | null;
  actorUserId: string | null;
  /**
   * Seed the signed-paperwork hold set after insert. Resolve the
   * `billing.bill_hold` flag ONCE at the caller and pass it in (a batch
   * resolves it a single time for the whole batch rather than per item).
   */
  billHoldEnabled: boolean;
  dateOfServiceOverride?: string | null;
  payerProfileIdOverride?: string | null;
  /** Free-text note appended to the initial event row. */
  note?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type CreateClaimResult =
  | {
      status: "created";
      claimId: string;
      lineCount: number;
      proposed: ProposedClaim;
    }
  | {
      status: "claim_exists";
      claimId: string | null;
      existingStatus: string | null;
    }
  | { status: "fulfillment_not_found" };

function isOpenFulfillmentUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505" &&
    "message" in err &&
    typeof (err as { message?: unknown }).message === "string" &&
    (err as { message: string }).message.includes(
      "insurance_claims_open_fulfillment_uidx",
    )
  );
}

/**
 * Build + persist a single draft claim from a fulfillment. See the file
 * header for the contract (structured statuses for expected outcomes;
 * throws for unexpected DB errors).
 */
export async function createClaimFromFulfillment(
  input: CreateClaimFromFulfillmentInput,
): Promise<CreateClaimResult> {
  const supabase = getOrgScopedClient(input.orgId);

  // Duplicate guard FIRST: refuse when this fulfillment already has an open
  // (non-denied/closed) claim. A double-click — or two CSRs working the
  // same "fulfillments to bill" row, or the same id passed twice in a
  // batch — otherwise creates two draft claims with identical lines for
  // ONE shipment. Denied/closed claims don't block (a re-bill after a
  // denial is legitimate). Running this BEFORE the builder short-circuits
  // its heavy read walk (coverages, payer profiles, sleep studies,
  // prescriptions, fee schedules) for an already-claimed fulfillment — the
  // batch path in particular skips that wasted work on every duplicate id.
  const { data: existingClaim, error: existingClaimErr } = await supabase
    .from("insurance_claims")
    .select("id, status")
    .eq("fulfillment_id", input.fulfillmentId)
    .not("status", "in", "(denied,closed)")
    .limit(1)
    .maybeSingle();
  if (existingClaimErr) throw existingClaimErr;
  if (existingClaim) {
    return {
      status: "claim_exists",
      claimId: existingClaim.id,
      existingStatus: existingClaim.status,
    };
  }

  // Build the proposed claim from the fulfillment. The builder reads THIS
  // tenant's fulfillment / patient / coverage / payer data through its
  // org-scoped client, so it must carry the caller's orgId.
  let proposed: ProposedClaim;
  try {
    proposed = await buildClaimFromFulfillment({
      orgId: input.orgId,
      fulfillmentId: input.fulfillmentId,
      dateOfServiceOverride: input.dateOfServiceOverride ?? null,
      payerProfileIdOverride: input.payerProfileIdOverride ?? null,
    });
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      return { status: "fulfillment_not_found" };
    }
    throw err;
  }

  // Insert the claim header.
  const { data: claimRow, error: claimErr } = await supabase
    .from("insurance_claims")
    .insert({
      patient_id: proposed.patientId,
      insurance_coverage_id: proposed.insuranceCoverageId,
      secondary_coverage_id: proposed.secondaryCoverageId,
      payer_name: proposed.payerName,
      date_of_service: proposed.dateOfService,
      fulfillment_id: proposed.fulfillmentId,
      payer_profile_id: proposed.payerProfileId,
      referring_provider_id: proposed.referringProviderId,
      rendering_provider_id: proposed.renderingProviderId,
      status: "draft",
      total_billed_cents: proposed.lines.reduce(
        (s, l) => s + l.billedCents * l.quantity,
        0,
      ),
    })
    .select("id")
    .single();
  if (claimErr) {
    // Concurrency: the per-fulfillment open-claim unique index fired
    // between our guard read and this insert. Resolve to the winner.
    if (isOpenFulfillmentUniqueViolation(claimErr)) {
      const { data: raceWinner } = await supabase
        .from("insurance_claims")
        .select("id, status")
        .eq("fulfillment_id", input.fulfillmentId)
        .not("status", "in", "(denied,closed)")
        .limit(1)
        .maybeSingle();
      return {
        status: "claim_exists",
        claimId: raceWinner?.id ?? null,
        existingStatus: raceWinner?.status ?? null,
      };
    }
    throw claimErr;
  }

  // Insert the line items (carrying the per-unit COGS snapshot the builder
  // resolved from product_costs — migration 0193).
  if (proposed.lines.length > 0) {
    const lineRows = buildClaimLineRows(
      claimRow.id,
      proposed.lines,
      new Date().toISOString(),
    );
    const { error: lineErr } = await supabase
      .from("insurance_claim_line_items")
      .insert(lineRows);
    if (lineErr) throw lineErr;
  }

  // Initial event row capturing the builder breadcrumbs.
  const noteParts: string[] = [
    `Built from fulfillment ${proposed.fulfillmentId} by ${input.actorEmail ?? "unknown"}.`,
  ];
  if (input.note) noteParts.push(input.note);
  if (proposed.builderNotes.length > 0) {
    noteParts.push(`Builder notes: ${proposed.builderNotes.join(" ")}`);
  }
  const { error: claimEventErr } = await supabase
    .from("insurance_claim_events")
    .insert({
      claim_id: claimRow.id,
      event_type: "note",
      note: noteParts.join(" "),
      actor_email: input.actorEmail ?? "unknown",
    });
  if (claimEventErr) {
    logger.warn(
      { err: claimEventErr.message, claimId: claimRow.id },
      "create-claim-from-fulfillment: event insert failed (non-fatal)",
    );
  }

  await logAudit({
    action: "insurance_claim.create_from_fulfillment",
    adminEmail: input.actorEmail,
    adminUserId: input.actorUserId,
    targetTable: "insurance_claims",
    targetId: claimRow.id,
    metadata: {
      patient_id: proposed.patientId,
      fulfillment_id: proposed.fulfillmentId,
      payer_profile_id: proposed.payerProfileId,
      line_count: proposed.lines.length,
      builder_notes_count: proposed.builderNotes.length,
    },
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  }).catch((err) => {
    logger.warn(
      { err },
      "insurance_claim.create_from_fulfillment audit write failed",
    );
  });

  // Seed the default signed-paperwork requirement set so the new claim is
  // held until its prescription / POD / AOB are on file. Best-effort +
  // gated by the bill_hold flag (resolved by the caller). Never fails claim
  // creation.
  if (input.billHoldEnabled) {
    try {
      await seedDefaultRequirementsForClaim(claimRow.id, {
        supabase: supabase.raw(),
        createdByEmail: input.actorEmail ?? null,
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
        .eq("id", claimRow.id);
      if (holdErr) {
        logger.warn(
          { err: holdErr, claimId: claimRow.id },
          "create-claim-from-fulfillment: fail-safe bill-hold flag failed",
        );
      }
      logger.warn(
        { err, claimId: claimRow.id },
        "create-claim-from-fulfillment: bill-hold seed failed (non-fatal)",
      );
    }
  }

  return {
    status: "created",
    claimId: claimRow.id,
    lineCount: proposed.lines.length,
    proposed,
  };
}
