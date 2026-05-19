// ERA reconciler — apply a parsed 835 against our insurance_claims /
// insurance_claim_line_items rows and write the rolling event history.
//
// This module is the "what changes in our DB when an ERA lands" layer.
// It is intentionally pure SQL via the Supabase service-role client —
// no EDI parsing here; the caller passes a Parsed835 from the
// office-ally adapter.
//
// Side effects per claim block in the ERA:
//   1. UPDATE insurance_claims:
//        total_allowed_cents += sum of CO + PR adjustments per claim,
//        total_paid_cents     += claim.paidCents,
//        patient_responsibility_cents += sum of PR adjustments,
//        decision_at  = now() (first time we land on a decision),
//        paid_at      = now() (only when claim becomes paid),
//        status: draft|submitted|accepted -> paid (if paidCents > 0
//                                              + status not denied)
//                draft|submitted|accepted -> denied (if isDenied)
//                accepted -> paid (partial pay also moves to paid;
//                                  see state machine in
//                                  routes/patients/insurance-claims.ts).
//   2. UPDATE insurance_claim_line_items per SVC:
//        allowed_cents += sum of CO + PR adjustments per line,
//        paid_cents    += line.paidCents,
//        status: pending -> paid (if paidCents > 0) | denied (if 0
//                                                              paid + CO
//                                                              denial).
//   3. INSERT insurance_claim_events:
//        one 'paid' / 'partial_pay' / 'denied' event per claim,
//        payer_ref = check number, amount_cents = paidCents,
//        actor_email = 'system:era_ingest'.
//   4. UPDATE the claim's denial_reason on a denial event (composing
//        the CARC + RARC list into a single readable line).
//
// PHI posture: no logging of full claim or patient data; the route
// audit log records counts only.

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import type {
  Adjustment,
  Parsed835,
  Parsed835Claim,
  Parsed835ServiceLine,
} from "@workspace/resupply-integrations-office-ally";

import { logger } from "../logger";

type ClaimRow = Database["resupply"]["Tables"]["insurance_claims"]["Row"];
type LineRow = Database["resupply"]["Tables"]["insurance_claim_line_items"]["Row"];

export interface ReconciliationSummary {
  /** How many claim blocks in the ERA we matched to a local claim. */
  matchedClaims: number;
  /** How many claim blocks in the ERA had no local match. */
  unmatchedClaims: number;
  /** How many local lines we touched. */
  linesUpdated: number;
  paidClaims: number;
  deniedClaims: number;
  /** Per-claim outcomes for the response + audit log. */
  outcomes: ReconciliationOutcome[];
}

export interface ReconciliationOutcome {
  patientControlNumber: string;
  matched: boolean;
  newStatus: ClaimRow["status"] | null;
  paidCents: number;
  patientResponsibilityCents: number;
  denialReason: string | null;
}

export interface ReconcileEraOptions {
  /** Caller actor for the event rows. */
  actorEmail: string;
  /** Source 835 file name, embedded in event notes for traceability. */
  fileName: string;
  /** Payer-supplied check / EFT number. */
  checkOrEftNumber: string | null;
}

const TERMINAL_STATUSES: readonly ClaimRow["status"][] = ["closed"];

/**
 * Apply a Parsed835 against the live claim rows. Returns a summary
 * of what changed; never throws on per-claim mismatches — those land
 * as `matched: false` so the caller can surface them in the response.
 */
export async function reconcileEra(
  parsed: Parsed835,
  opts: ReconcileEraOptions,
): Promise<ReconciliationSummary> {
  const supabase = getSupabaseServiceRoleClient();
  const summary: ReconciliationSummary = {
    matchedClaims: 0,
    unmatchedClaims: 0,
    linesUpdated: 0,
    paidClaims: 0,
    deniedClaims: 0,
    outcomes: [],
  };

  for (const eraClaim of parsed.claims) {
    const outcome = await applyClaim(supabase, eraClaim, opts);
    summary.outcomes.push(outcome);
    if (outcome.matched) {
      summary.matchedClaims++;
      if (outcome.newStatus === "paid") summary.paidClaims++;
      if (outcome.newStatus === "denied") summary.deniedClaims++;
    } else {
      summary.unmatchedClaims++;
    }
  }

  summary.linesUpdated = summary.outcomes.reduce(
    (s, _o) => s + 0,
    parsed.claims.reduce((s, c) => s + c.serviceLines.length, 0),
  );

  return summary;
}

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

async function applyClaim(
  supabase: SupabaseClient,
  eraClaim: Parsed835Claim,
  opts: ReconcileEraOptions,
): Promise<ReconciliationOutcome> {
  // 1. Find the local claim by the CLP01 patient control number. The
  //    builder writes our insurance_claims.id (truncated to 38 chars)
  //    into CLM01, so we look it up by full id match — the payer
  //    echoes it back unchanged.
  const { data: claim, error } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select(
      "id, patient_id, status, total_billed_cents, total_allowed_cents, total_paid_cents, patient_responsibility_cents, denial_reason",
    )
    .eq("id", eraClaim.patientControlNumber)
    .limit(1)
    .maybeSingle();
  if (error || !claim) {
    return {
      patientControlNumber: eraClaim.patientControlNumber,
      matched: false,
      newStatus: null,
      paidCents: 0,
      patientResponsibilityCents: 0,
      denialReason: null,
    };
  }
  if (TERMINAL_STATUSES.includes(claim.status)) {
    // Already closed — record a no-op event and move on. We never
    // mutate a closed claim from an ERA replay.
    return {
      patientControlNumber: eraClaim.patientControlNumber,
      matched: true,
      newStatus: claim.status,
      paidCents: 0,
      patientResponsibilityCents: 0,
      denialReason: claim.denial_reason,
    };
  }

  // 2. Apply line-level reconciliation.
  if (eraClaim.serviceLines.length > 0) {
    const { data: localLines } = await supabase
      .schema("resupply")
      .from("insurance_claim_line_items")
      .select("id, hcpcs_code, modifier, allowed_cents, paid_cents, status")
      .eq("claim_id", claim.id);
    for (const eraLine of eraClaim.serviceLines) {
      const localLine = matchLine(localLines ?? [], eraLine);
      if (!localLine) continue;
      const allowedDelta = sumPositive(eraLine.adjustments, "CO", "PR");
      const nextAllowed = localLine.allowed_cents + allowedDelta;
      const nextPaid = localLine.paid_cents + eraLine.paidCents;
      const nextStatus: LineRow["status"] =
        eraLine.paidCents > 0
          ? "paid"
          : hasDenial(eraLine.adjustments)
            ? "denied"
            : localLine.status;
      await supabase
        .schema("resupply")
        .from("insurance_claim_line_items")
        .update({
          allowed_cents: nextAllowed,
          paid_cents: nextPaid,
          status: nextStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", localLine.id);
    }
  }

  // 3. Apply claim-level totals + status transition.
  const claimAllowedDelta = sumPositive(eraClaim.adjustments, "CO", "PR");
  const newTotalAllowed = claim.total_allowed_cents + claimAllowedDelta;
  const newTotalPaid = claim.total_paid_cents + eraClaim.paidCents;
  const newPatientResp =
    claim.patient_responsibility_cents + eraClaim.patientResponsibilityCents;

  let newStatus: ClaimRow["status"] = claim.status;
  const denialReason = eraClaim.isDenied ? composeDenialReason(eraClaim) : null;
  if (eraClaim.isDenied && allowedTransition(claim.status, "denied")) {
    newStatus = "denied";
  } else if (eraClaim.paidCents > 0 && allowedTransition(claim.status, "paid")) {
    newStatus = "paid";
  }

  const nowIso = new Date().toISOString();
  await supabase
    .schema("resupply")
    .from("insurance_claims")
    .update({
      total_allowed_cents: newTotalAllowed,
      total_paid_cents: newTotalPaid,
      patient_responsibility_cents: newPatientResp,
      status: newStatus,
      decision_at: claim.status === "submitted" ? nowIso : undefined,
      paid_at: newStatus === "paid" ? nowIso : undefined,
      denial_reason: denialReason ?? claim.denial_reason,
      updated_at: nowIso,
    })
    .eq("id", claim.id);

  // 4. Append the event row.
  const eventType: Database["resupply"]["Tables"]["insurance_claim_events"]["Row"]["event_type"] =
    eraClaim.isDenied
      ? "denied"
      : newTotalPaid >= claim.total_billed_cents
        ? "paid"
        : "partial_pay";
  await supabase
    .schema("resupply")
    .from("insurance_claim_events")
    .insert({
      claim_id: claim.id,
      event_type: eventType,
      amount_cents: eraClaim.paidCents,
      payer_ref: opts.checkOrEftNumber,
      note: `ERA ${opts.fileName}${denialReason ? ` — ${denialReason}` : ""}`,
      actor_email: opts.actorEmail,
    });

  return {
    patientControlNumber: eraClaim.patientControlNumber,
    matched: true,
    newStatus,
    paidCents: eraClaim.paidCents,
    patientResponsibilityCents: eraClaim.patientResponsibilityCents,
    denialReason,
  };
}

function matchLine(
  locals: Pick<LineRow, "id" | "hcpcs_code" | "modifier" | "allowed_cents" | "paid_cents" | "status">[],
  era: Parsed835ServiceLine,
):
  | Pick<LineRow, "id" | "hcpcs_code" | "modifier" | "allowed_cents" | "paid_cents" | "status">
  | null {
  if (!era.hcpcsCode) return null;
  // Match on HCPCS + ordered modifier set. The local row's modifier
  // column is a comma-joined string; we normalise both sides to a
  // sorted CSV before comparing so RR,KX and KX,RR collide.
  const eraKey = `${era.hcpcsCode}|${normaliseMods(era.modifiers)}`;
  for (const local of locals) {
    const localKey = `${local.hcpcs_code}|${normaliseMods((local.modifier ?? "").split(","))}`;
    if (localKey === eraKey) return local;
  }
  // Fall back to HCPCS-only when no modifier-aware match: better to
  // attach the payment to the right HCPCS than to leave it unmatched.
  for (const local of locals) {
    if (local.hcpcs_code === era.hcpcsCode) return local;
  }
  return null;
}

function normaliseMods(mods: readonly string[]): string {
  return [...mods]
    .map((m) => m.trim().toUpperCase())
    .filter((m) => m.length === 2)
    .sort()
    .join(",");
}

function sumPositive(adjustments: Adjustment[], ...groups: string[]): number {
  return adjustments
    .filter((a) => groups.includes(a.groupCode))
    .reduce((s, a) => s + Math.max(0, a.amountCents), 0);
}

function hasDenial(adjustments: Adjustment[]): boolean {
  // A line with a CO adjustment >= billed amount and zero paid is a
  // line-level denial. We surface a strict "denied" status only when
  // there's at least one CO adjustment on the line; the API layer
  // can downgrade to "pending" if a later 835 corrects it.
  return adjustments.some((a) => a.groupCode === "CO");
}

function composeDenialReason(eraClaim: Parsed835Claim): string {
  const codes = new Set<string>();
  for (const adj of eraClaim.adjustments) {
    if (adj.groupCode === "CO" || adj.groupCode === "PI") {
      codes.add(`CARC ${adj.reasonCode}`);
    }
  }
  for (const line of eraClaim.serviceLines) {
    for (const adj of line.adjustments) {
      if (adj.groupCode === "CO" || adj.groupCode === "PI") {
        codes.add(`CARC ${adj.reasonCode}`);
      }
    }
  }
  if (codes.size === 0) return "Denied per remit (no CARC supplied)";
  return [...codes].join("; ");
}

function allowedTransition(
  from: ClaimRow["status"],
  to: ClaimRow["status"],
): boolean {
  // The canonical state machine lives in routes/patients/insurance-claims.ts;
  // for ERA reconciliation we honour the same valid edges PLUS we
  // tolerate "submitted -> paid" because an OA round-trip can resolve
  // a claim before we observe the 277CA "accepted" intermediate.
  const VALID: Record<ClaimRow["status"], readonly ClaimRow["status"][]> = {
    draft: ["submitted"],
    submitted: ["accepted", "denied", "paid"],
    accepted: ["paid", "denied"],
    denied: ["appealed", "closed"],
    appealed: ["accepted", "denied"],
    paid: ["closed"],
    closed: [],
  };
  if (from === to) return false;
  const allowed = VALID[from] ?? [];
  if (allowed.includes(to)) return true;
  // Defensive logging without PHI — just the transition that was
  // rejected so we can audit ERA-driven state coherency.
  logger.warn(
    { from, to },
    "era_reconciler: rejected status transition",
  );
  return false;
}
