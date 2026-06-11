// Bill hold — the claim-level signed-paperwork gate.
//
// A claim is HELD (cannot be transmitted to the clearinghouse) while it has
// any OUTSTANDING + REQUIRED row in `claim_paperwork_requirements`. The hold
// lifts the moment the last such row is satisfied — whether a CSR marks it
// by hand, the patient e-signs a portal packet, a chart upload lands, or a
// signed copy is faxed back to our Telnyx number and auto-matched here.
//
// `insurance_claims.bill_hold` is a denormalised cache of that EXISTS check.
// It exists so list/worklist queries don't sub-aggregate the ledger on every
// row; `recomputeBillHold()` keeps it in step on every change. The
// batch-submit gate (office-ally-batch.ts) NEVER trusts the cache alone — it
// re-reads the live outstanding count for the claims in the batch — so a
// drifted flag can never release a claim that still owes paperwork.
//
// PHI posture: this module deals in requirement types, labels, status, and
// ids. The document bytes live in object storage / patient_documents under
// their own ACL; nothing here logs patient identifiers beyond the uuids the
// caller already holds.

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export type RequirementType =
  | "prescription"
  | "swo"
  | "cmn"
  | "dwo"
  | "aob"
  | "abn"
  | "proof_of_delivery"
  | "medical_records"
  | "face_to_face"
  | "sleep_study"
  | "agreement"
  | "other";

export type RequirementStatus =
  | "outstanding"
  | "satisfied"
  | "waived"
  | "voided";

export type SatisfiedVia =
  | "inbound_fax"
  | "upload"
  | "esign"
  | "portal"
  | "mail"
  | "manual";

export interface PaperworkRequirementRow {
  id: string;
  claim_id: string | null;
  patient_id: string;
  requirement_type: RequirementType;
  label: string;
  status: RequirementStatus;
  required: boolean;
  sent_at: string | null;
  sent_via: string | null;
  expected_return_fax_e164: string | null;
  reminder_count: number;
  last_reminded_at: string | null;
  satisfied_at: string | null;
  satisfied_via: string | null;
  satisfied_by_email: string | null;
  satisfied_inbound_fax_id: string | null;
  satisfied_document_id: string | null;
  source_manual_document_id: string | null;
  source_packet_id: string | null;
  waived_reason: string | null;
  notes: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
}

/** Default required set seeded onto a new DME claim. These are the three
 *  documents an auditor asks for on a post-pay review of a CPAP/DME claim.
 *  CMN/DWO are HCPCS-specific and added per claim by the CSR rather than
 *  blanket-seeded. */
export interface DefaultRequirementSpec {
  requirementType: RequirementType;
  label: string;
  required: boolean;
}

export const DEFAULT_CLAIM_PAPERWORK: DefaultRequirementSpec[] = [
  {
    requirementType: "prescription",
    label: "Signed prescription / Standard Written Order",
    required: true,
  },
  {
    requirementType: "proof_of_delivery",
    label: "Signed proof of delivery",
    required: true,
  },
  {
    requirementType: "aob",
    label: "Assignment of Benefits",
    required: true,
  },
];

const REQUIREMENT_COLUMNS =
  "id, claim_id, patient_id, requirement_type, label, status, required, sent_at, sent_via, expected_return_fax_e164, reminder_count, last_reminded_at, satisfied_at, satisfied_via, satisfied_by_email, satisfied_inbound_fax_id, satisfied_document_id, source_manual_document_id, source_packet_id, waived_reason, notes, created_by_email, created_at, updated_at";

// ── Pure helpers (unit-tested without a DB) ──────────────────────────

/** A claim is held iff at least one required requirement is still
 *  outstanding. Pure so the rule is exercised without a database. */
export function shouldHold(
  rows: Pick<PaperworkRequirementRow, "status" | "required">[],
): boolean {
  return rows.some((r) => r.required && r.status === "outstanding");
}

/** The labels of the outstanding required requirements — the
 *  "what's still needed" summary for a reminder / worklist row. */
export function outstandingLabels(
  rows: Pick<PaperworkRequirementRow, "status" | "required" | "label">[],
): string[] {
  return rows
    .filter((r) => r.required && r.status === "outstanding")
    .map((r) => r.label);
}

export interface FaxMatchResult {
  /** The single outstanding requirement the fax satisfies, or null. */
  matched: PaperworkRequirementRow | null;
  /** True when >1 outstanding requirement matched — we refuse to guess. */
  ambiguous: boolean;
}

/**
 * Pick which outstanding requirement an inbound fax satisfies. We only
 * auto-satisfy when EXACTLY ONE outstanding requirement expects a return
 * from this fax number — never guess between several (a false release is
 * worse than a manual link). Pure.
 */
export function pickFaxMatch(
  outstandingForNumber: PaperworkRequirementRow[],
): FaxMatchResult {
  if (outstandingForNumber.length === 1) {
    return { matched: outstandingForNumber[0]!, ambiguous: false };
  }
  return { matched: null, ambiguous: outstandingForNumber.length > 1 };
}

// ── DB-bound operations ──────────────────────────────────────────────

/** List every paperwork requirement tracked against a claim. */
export async function listClaimRequirements(
  claimId: string,
  supabase: SupabaseClient = getSupabaseServiceRoleClient(),
): Promise<PaperworkRequirementRow[]> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("claim_paperwork_requirements")
    .select(REQUIREMENT_COLUMNS)
    .eq("claim_id", claimId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as PaperworkRequirementRow[];
}

/** List every paperwork requirement tracked against a patient. */
export async function listPatientRequirements(
  patientId: string,
  supabase: SupabaseClient = getSupabaseServiceRoleClient(),
): Promise<PaperworkRequirementRow[]> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("claim_paperwork_requirements")
    .select(REQUIREMENT_COLUMNS)
    .eq("patient_id", patientId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as PaperworkRequirementRow[];
}

/**
 * Count outstanding REQUIRED requirements per claim for a set of claim ids.
 * The authoritative "is this held?" read used by the batch-submit gate —
 * it never trusts the denormalised bill_hold flag. Returns a Map keyed by
 * claim id; absent / zero means not held.
 */
export async function countOutstandingByClaim(
  claimIds: string[],
  supabase: SupabaseClient = getSupabaseServiceRoleClient(),
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (claimIds.length === 0) return counts;
  const { data, error } = await supabase
    .schema("resupply")
    .from("claim_paperwork_requirements")
    .select("claim_id")
    .in("claim_id", claimIds)
    .eq("status", "outstanding")
    .eq("required", true);
  if (error) throw error;
  for (const row of data ?? []) {
    const cid = (row as { claim_id: string | null }).claim_id;
    if (cid) counts.set(cid, (counts.get(cid) ?? 0) + 1);
  }
  return counts;
}

export interface RecomputeOpts {
  supabase?: SupabaseClient;
  /** Stamped on the release columns when the hold lifts. */
  actorEmail?: string | null;
  /** When the hold transitions (set or lift), append a claim event. */
  writeEvent?: boolean;
}

export interface RecomputeResult {
  claimId: string;
  held: boolean;
  /** True when this call flipped the claim's held state. */
  changed: boolean;
  outstandingCount: number;
}

/**
 * Recompute and persist a claim's bill_hold flag from its live requirement
 * ledger. Idempotent: a no-op when the cached flag already matches reality.
 * On a transition it stamps the release bookkeeping and (optionally) writes
 * an insurance_claim_events row so the hold history is reconstructable.
 */
export async function recomputeBillHold(
  claimId: string,
  opts: RecomputeOpts = {},
): Promise<RecomputeResult> {
  const supabase = opts.supabase ?? getSupabaseServiceRoleClient();

  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("claim_paperwork_requirements")
    .select("status, required, label")
    .eq("claim_id", claimId);
  if (error) throw error;
  const reqRows = (rows ?? []) as Pick<
    PaperworkRequirementRow,
    "status" | "required" | "label"
  >[];
  const held = shouldHold(reqRows);
  const outstandingCount = reqRows.filter(
    (r) => r.required && r.status === "outstanding",
  ).length;

  const { data: claim, error: claimErr } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("id, bill_hold, status")
    .eq("id", claimId)
    .limit(1)
    .maybeSingle();
  if (claimErr) throw claimErr;
  if (!claim) {
    return { claimId, held, changed: false, outstandingCount };
  }

  const wasHeld = claim.bill_hold === true;
  if (wasHeld === held) {
    // Cache already correct — refresh the reason text only when held so a
    // newly-added requirement updates "waiting on N item(s)" without an
    // extra event.
    if (held) {
      const labels = outstandingLabels(reqRows);
      const { error: reasonErr } = await supabase
        .schema("resupply")
        .from("insurance_claims")
        .update({
          bill_hold_reason: holdReason(labels),
          bill_hold_updated_at: new Date().toISOString(),
        })
        .eq("id", claimId);
      if (reasonErr) {
        logger.warn(
          { err: reasonErr.message, claimId },
          "bill-hold: hold-reason refresh failed (non-fatal)",
        );
      }
    }
    return { claimId, held, changed: false, outstandingCount };
  }

  const nowIso = new Date().toISOString();
  const labels = outstandingLabels(reqRows);
  const { error: flipErr } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .update({
      bill_hold: held,
      bill_hold_reason: held ? holdReason(labels) : null,
      bill_hold_updated_at: nowIso,
      bill_hold_released_at: held ? null : nowIso,
      bill_hold_released_by: held ? null : (opts.actorEmail ?? "system"),
      updated_at: nowIso,
    })
    .eq("id", claimId);
  if (flipErr) {
    logger.error(
      { err: flipErr.message, claimId, held },
      "bill-hold: bill_hold flip failed — claim hold state is stale",
    );
    return { claimId, held: wasHeld, changed: false, outstandingCount };
  }

  if (opts.writeEvent) {
    const { error: eventErr } = await supabase
      .schema("resupply")
      .from("insurance_claim_events")
      .insert({
        claim_id: claimId,
        event_type: "note",
        note: held
          ? `Bill hold placed — waiting on: ${labels.join(", ")}.`
          : "Bill hold released — all required paperwork is on file.",
        actor_email: opts.actorEmail ?? "system",
      });
    if (eventErr) {
      logger.warn(
        { err: eventErr.message, claimId },
        "bill-hold: claim event write failed",
      );
    }
  }

  return { claimId, held, changed: true, outstandingCount };
}

function holdReason(labels: string[]): string {
  if (labels.length === 0) return "Waiting on signed paperwork.";
  return `Waiting on: ${labels.join(", ")}.`;
}

export interface SatisfyOpts {
  supabase?: SupabaseClient;
  via: SatisfiedVia;
  actorEmail?: string | null;
  inboundFaxId?: string | null;
  documentId?: string | null;
  note?: string | null;
}

/**
 * Mark a requirement satisfied ("returned signed") and recompute the
 * claim's hold. No-op (returns the row) if it is already satisfied — so a
 * duplicate inbound fax or a double-click can't thrash the hold. Returns
 * the updated row and the recompute result (null when not tied to a claim).
 */
export async function satisfyRequirement(
  requirementId: string,
  opts: SatisfyOpts,
): Promise<{
  requirement: PaperworkRequirementRow;
  recompute: RecomputeResult | null;
}> {
  const supabase = opts.supabase ?? getSupabaseServiceRoleClient();

  const { data: existing, error: readErr } = await supabase
    .schema("resupply")
    .from("claim_paperwork_requirements")
    .select(REQUIREMENT_COLUMNS)
    .eq("id", requirementId)
    .limit(1)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!existing) {
    throw new Error(`paperwork requirement ${requirementId} not found`);
  }
  const row = existing as PaperworkRequirementRow;
  if (row.status === "satisfied") {
    return { requirement: row, recompute: null };
  }

  const nowIso = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .schema("resupply")
    .from("claim_paperwork_requirements")
    .update({
      status: "satisfied",
      satisfied_at: nowIso,
      satisfied_via: opts.via,
      satisfied_by_email: opts.actorEmail ?? null,
      satisfied_inbound_fax_id: opts.inboundFaxId ?? null,
      satisfied_document_id: opts.documentId ?? null,
      notes: opts.note ?? row.notes,
      updated_at: nowIso,
    })
    .eq("id", requirementId)
    .select(REQUIREMENT_COLUMNS)
    .single();
  if (updErr) throw updErr;
  const requirement = updated as PaperworkRequirementRow;

  let recompute: RecomputeResult | null = null;
  if (requirement.claim_id) {
    recompute = await recomputeBillHold(requirement.claim_id, {
      supabase,
      actorEmail: opts.actorEmail ?? null,
      writeEvent: true,
    });
  }
  return { requirement, recompute };
}

/**
 * Seed the default required paperwork set onto a claim that has none yet.
 * Idempotent — a claim that already carries any requirement row is left
 * untouched (so a re-run / a CSR's hand-tailored set is never clobbered).
 * Auto-satisfies the rows already provable on file (AOB acknowledged, a
 * signed Rx/DWO present) so a fully-documented claim is never falsely held.
 * Recomputes the hold at the end. Returns the number of rows created.
 */
export async function seedDefaultRequirementsForClaim(
  claimId: string,
  opts: { supabase?: SupabaseClient; createdByEmail?: string | null } = {},
): Promise<{ created: number; held: boolean }> {
  const supabase = opts.supabase ?? getSupabaseServiceRoleClient();

  const { data: claim, error: claimErr } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("id, patient_id")
    .eq("id", claimId)
    .limit(1)
    .maybeSingle();
  if (claimErr) throw claimErr;
  if (!claim) return { created: 0, held: false };

  const { data: existing, error: existErr } = await supabase
    .schema("resupply")
    .from("claim_paperwork_requirements")
    .select("id")
    .eq("claim_id", claimId)
    .limit(1);
  if (existErr) throw existErr;
  if (existing && existing.length > 0) {
    const rec = await recomputeBillHold(claimId, { supabase });
    return { created: 0, held: rec.held };
  }

  const onFile = await resolveOnFile(supabase, claim.patient_id);
  const nowIso = new Date().toISOString();
  const inserts = DEFAULT_CLAIM_PAPERWORK.map((spec) => {
    const sat = onFile[spec.requirementType];
    return {
      claim_id: claimId,
      patient_id: claim.patient_id,
      requirement_type: spec.requirementType,
      label: spec.label,
      required: spec.required,
      status: sat ? "satisfied" : "outstanding",
      satisfied_at: sat ? nowIso : null,
      satisfied_via: sat ? sat.via : null,
      satisfied_document_id: sat?.documentId ?? null,
      created_by_email: opts.createdByEmail ?? "system",
    };
  });
  const { error: insErr } = await supabase
    .schema("resupply")
    .from("claim_paperwork_requirements")
    .insert(inserts);
  if (insErr) throw insErr;

  const rec = await recomputeBillHold(claimId, {
    supabase,
    actorEmail: opts.createdByEmail ?? null,
    writeEvent: true,
  });
  return { created: inserts.length, held: rec.held };
}

/**
 * Resolve which default requirement types are already provable on file for
 * a patient, so seeding can pre-satisfy them. Conservative: only the two
 * we can read unambiguously (AOB from the click-through acknowledgement
 * store, a signed Rx/DWO from dwo_documents). Proof of delivery is left
 * outstanding — it's generated at delivery and faxed/signed back.
 */
async function resolveOnFile(
  supabase: SupabaseClient,
  patientId: string,
): Promise<
  Partial<
    Record<RequirementType, { via: SatisfiedVia; documentId: string | null }>
  >
> {
  const out: Partial<
    Record<RequirementType, { via: SatisfiedVia; documentId: string | null }>
  > = {};

  const { data: acks } = await supabase
    .schema("resupply")
    .from("patient_form_acknowledgements")
    .select("form_kind")
    .eq("patient_id", patientId);
  if (
    (acks ?? []).some((a) => (a as { form_kind: string }).form_kind === "aob")
  ) {
    out.aob = { via: "esign", documentId: null };
  }

  // A signed, unexpired DWO/SWO covers the prescription requirement.
  const today = new Date().toISOString().slice(0, 10);
  const { data: dwos } = await supabase
    .schema("resupply")
    .from("dwo_documents")
    .select("id, expires_on")
    .eq("patient_id", patientId)
    .gte("expires_on", today)
    .limit(1);
  if (dwos && dwos.length > 0) {
    out.prescription = {
      via: "upload",
      documentId: (dwos[0] as { id: string }).id,
    };
  }

  return out;
}

/**
 * Best-effort auto-match of an inbound fax to an outstanding requirement.
 * Called fire-and-forget from the inbound-fax ingest. Matches by the
 * `expected_return_fax_e164` we recorded when the paperwork was sent out;
 * auto-satisfies ONLY when exactly one outstanding requirement expects a
 * return from this number (never guesses between several). Never throws —
 * a failure just leaves the fax for manual linking in the triage queue.
 */
export async function autoMatchInboundFaxToPaperwork(
  faxId: string,
  fromE164: string | null,
  supabase: SupabaseClient = getSupabaseServiceRoleClient(),
): Promise<{ matched: boolean; requirementId: string | null }> {
  try {
    if (!fromE164) return { matched: false, requirementId: null };
    const normalized = fromE164.trim();
    if (!normalized) return { matched: false, requirementId: null };

    const { data, error } = await supabase
      .schema("resupply")
      .from("claim_paperwork_requirements")
      .select(REQUIREMENT_COLUMNS)
      .eq("expected_return_fax_e164", normalized)
      .eq("status", "outstanding");
    if (error) throw error;
    const candidates = (data ?? []) as PaperworkRequirementRow[];
    const { matched, ambiguous } = pickFaxMatch(candidates);
    if (!matched) {
      if (ambiguous) {
        logger.info(
          { event: "bill_hold.fax_match_ambiguous", count: candidates.length },
          "bill-hold: inbound fax matched multiple outstanding requirements; leaving for manual link",
        );
      }
      return { matched: false, requirementId: null };
    }

    await satisfyRequirement(matched.id, {
      supabase,
      via: "inbound_fax",
      actorEmail: "system:fax-auto-match",
      inboundFaxId: faxId,
    });

    await logAudit({
      action: "bill_hold.paperwork_auto_matched",
      targetTable: "claim_paperwork_requirements",
      targetId: matched.id,
      metadata: {
        requirement_type: matched.requirement_type,
        claim_id: matched.claim_id,
        // from / fax bytes withheld — PHI lives on the row under ACL.
      },
    }).catch(() => undefined);

    return { matched: true, requirementId: matched.id };
  } catch (err) {
    logger.warn(
      {
        event: "bill_hold.fax_auto_match_failed",
        err,
      },
      "bill-hold: inbound fax auto-match failed (non-fatal)",
    );
    return { matched: false, requirementId: null };
  }
}
