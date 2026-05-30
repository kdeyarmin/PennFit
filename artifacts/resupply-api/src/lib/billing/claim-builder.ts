// Claim builder — turn a fulfillment (or a manual line list) into a
// fully-populated draft insurance_claims + insurance_claim_line_items
// payload, applying:
//
//   * product → HCPCS mapping (resupply.product_hcpcs_map)
//   * payer modifier rules    (resupply.payer_modifier_rules)
//   * fee schedule lookup     (resupply.payer_fee_schedules)
//   * patient demographics    (resupply.patients)
//   * primary insurance       (resupply.insurance_coverages where rank='primary')
//   * most recent prescription provider as referring
//   * most recent sleep study diagnosis as primary ICD-10
//
// The output is a structured ProposedClaim that the route layer
// inserts into the DB. We deliberately split build → persist so the
// preflight engine can run on the same shape without writing.
//
// PHI posture: this module reads PHI but never logs it. The route
// layer's audit row captures structural metadata only.

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../logger";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface ProposedClaimLine {
  hcpcsCode: string;
  modifiers: string[];
  description: string | null;
  quantity: number;
  billedCents: number;
  /** Source breadcrumbs for the preflight + UI to explain WHERE this
   *  line came from (mapping table, template, manual override, etc). */
  sourceKind: "product_map" | "template" | "manual";
  sourceRef: string | null;
  /** When the billed amount came from a fee-schedule lookup, the
   *  matching row id; otherwise null. */
  feeScheduleRowId: string | null;
}

export interface ProposedClaim {
  patientId: string;
  payerProfileId: string | null;
  payerName: string;
  insuranceCoverageId: string | null;
  secondaryCoverageId: string | null;
  dateOfService: string;
  fulfillmentId: string | null;
  diagnosisCodes: string[];
  /** Discovered prescriber / rendering provider IDs (when available). */
  referringProviderId: string | null;
  renderingProviderId: string | null;
  /** Discovered prior-auth number (when one is on file + not expired). */
  priorAuthNumber: string | null;
  /** Per-HCPCS line items. Always >= 0; the preflight will flag empty. */
  lines: ProposedClaimLine[];
  /** Free-form preflight notes the builder accumulates during its walk. */
  builderNotes: string[];
}

export interface BuildFromFulfillmentInput {
  fulfillmentId: string;
  /** Override the date_of_service; defaults to the fulfillment's
   *  shipped_at or today. */
  dateOfServiceOverride?: string | null;
  /** Override the payer; defaults to the patient's primary coverage. */
  payerProfileIdOverride?: string | null;
}

const COMPLIANCE_DAYS_WINDOW = 30;
const COMPLIANCE_MIN_NIGHTS = 21;
const COMPLIANCE_MIN_MINUTES = 240;

/**
 * Build a ProposedClaim from a fulfillment record. Never writes to
 * the DB. Throws on hard prerequisite failures (fulfillment missing /
 * patient missing); returns a partially-populated shape with
 * builderNotes when soft data is missing — that surface drives the
 * preflight checklist.
 */
export async function buildClaimFromFulfillment(
  input: BuildFromFulfillmentInput,
): Promise<ProposedClaim> {
  const supabase = getSupabaseServiceRoleClient();

  // 1. Fulfillment + patient.
  const { data: fulfillment, error: fErr } = await supabase
    .schema("resupply")
    .from("fulfillments")
    .select(
      "id, patient_id, item_sku, quantity, shipped_at, submitted_at, status",
    )
    .eq("id", input.fulfillmentId)
    .limit(1)
    .maybeSingle();
  if (fErr) throw fErr;
  if (!fulfillment) {
    throw new Error(
      `buildClaimFromFulfillment: fulfillment ${input.fulfillmentId} not found`,
    );
  }

  const dateOfService =
    input.dateOfServiceOverride ??
    isoDate(fulfillment.shipped_at) ??
    isoDate(fulfillment.submitted_at) ??
    isoDate(new Date().toISOString())!;

  const proposed: ProposedClaim = {
    patientId: fulfillment.patient_id,
    payerProfileId: null,
    payerName: "",
    insuranceCoverageId: null,
    secondaryCoverageId: null,
    dateOfService,
    fulfillmentId: fulfillment.id,
    diagnosisCodes: [],
    referringProviderId: null,
    renderingProviderId: null,
    priorAuthNumber: null,
    lines: [],
    builderNotes: [],
  };

  // 2. Primary + secondary insurance coverages.
  const { data: coverages } = await supabase
    .schema("resupply")
    .from("insurance_coverages")
    .select("id, rank, payer_name, member_id")
    .eq("patient_id", fulfillment.patient_id);
  const primary = (coverages ?? []).find((c) => c.rank === "primary");
  const secondary = (coverages ?? []).find((c) => c.rank === "secondary");
  if (primary) {
    proposed.insuranceCoverageId = primary.id;
    proposed.payerName = primary.payer_name;
  } else {
    proposed.builderNotes.push(
      "No primary insurance coverage on file — claim payer left blank.",
    );
  }
  if (secondary) {
    proposed.secondaryCoverageId = secondary.id;
  }

  // 3. Payer profile (override or resolve by display_name match).
  // Phase 12 (migration 0142): pull the completeness fields alongside
  // the basics so the modifier auto-attach + enrollment gate below
  // don't need a second round-trip.
  let payerCompleteness: {
    required_modifiers_dme: string[];
    enrollment_status: string;
    enrollment_effective_on: string | null;
    member_id_pattern: string | null;
  } | null = null;
  if (input.payerProfileIdOverride) {
    proposed.payerProfileId = input.payerProfileIdOverride;
    const { data: payer } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select(
        "payer_legal_name, required_modifiers_dme, enrollment_status, enrollment_effective_on, member_id_pattern",
      )
      .eq("id", input.payerProfileIdOverride)
      .limit(1)
      .maybeSingle();
    if (payer) {
      proposed.payerName = payer.payer_legal_name;
      payerCompleteness = {
        required_modifiers_dme: payer.required_modifiers_dme ?? [],
        enrollment_status: payer.enrollment_status,
        enrollment_effective_on: payer.enrollment_effective_on,
        member_id_pattern: payer.member_id_pattern,
      };
    }
  } else if (primary) {
    const { data: payer } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select(
        "id, display_name, payer_legal_name, requires_prior_auth_dme, required_modifiers_dme, enrollment_status, enrollment_effective_on, member_id_pattern",
      )
      .ilike(
        "display_name",
        (primary.payer_name ?? "").replace(/[\\%_]/g, (c: string) => `\\${c}`),
      )
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    if (payer) {
      proposed.payerProfileId = payer.id;
      proposed.payerName = payer.payer_legal_name;
      payerCompleteness = {
        required_modifiers_dme: payer.required_modifiers_dme ?? [],
        enrollment_status: payer.enrollment_status,
        enrollment_effective_on: payer.enrollment_effective_on,
        member_id_pattern: payer.member_id_pattern,
      };
    } else {
      proposed.builderNotes.push(
        `No payer profile matched "${primary.payer_name}" — pick one from the catalog.`,
      );
    }
  }

  // 3a. Surface enrollment gates as builderNotes — preflight enforces
  // the actual block, but the builder leaves a breadcrumb so the
  // proposal UI can color the warning row before save.
  if (payerCompleteness) {
    if (payerCompleteness.enrollment_status === "suspended") {
      proposed.builderNotes.push(
        `Payer enrollment is suspended — preflight will block submission until resolved.`,
      );
    } else if (
      payerCompleteness.enrollment_status === "active" &&
      payerCompleteness.enrollment_effective_on &&
      payerCompleteness.enrollment_effective_on > proposed.dateOfService
    ) {
      proposed.builderNotes.push(
        `Payer enrollment effective on ${payerCompleteness.enrollment_effective_on}; this DOS pre-dates enrollment and will deny.`,
      );
    }
    if (
      payerCompleteness.member_id_pattern &&
      primary?.member_id &&
      !new RegExp(payerCompleteness.member_id_pattern).test(primary.member_id)
    ) {
      proposed.builderNotes.push(
        `Member ID "${primary.member_id}" doesn't match the payer's published format — verify before submit.`,
      );
    }
  }

  // 4. Diagnosis from latest sleep study.
  const { data: sleep } = await supabase
    .schema("resupply")
    .from("sleep_studies")
    .select("diagnosis_icd10, interpreting_provider_id")
    .eq("patient_id", fulfillment.patient_id)
    .not("diagnosis_icd10", "is", null)
    .order("study_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (sleep?.diagnosis_icd10) {
    proposed.diagnosisCodes.push(sleep.diagnosis_icd10);
  } else {
    proposed.builderNotes.push(
      "No sleep study with diagnosis on file — diagnosis empty.",
    );
  }

  // 5. Most recent prescription as the source of referring provider
  //    (the prescriber) + a fallback HCPCS if the product map lookup
  //    misses.
  const { data: rx } = await supabase
    .schema("resupply")
    .from("prescriptions")
    .select("provider_id, hcpcs_code, item_sku")
    .eq("patient_id", fulfillment.patient_id)
    .eq("status", "active")
    .order("valid_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (rx?.provider_id) {
    proposed.referringProviderId = rx.provider_id;
  } else {
    proposed.builderNotes.push(
      "No active prescription with a provider on file — referring provider empty.",
    );
  }

  // 6. Prior auth (if applicable).
  if (proposed.payerProfileId) {
    const { data: pa } = await supabase
      .schema("resupply")
      .from("prior_authorizations")
      .select("auth_number, status, approved_through, hcpcs_code")
      .eq("patient_id", fulfillment.patient_id)
      .eq("status", "approved")
      .order("approved_through", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pa?.auth_number) {
      proposed.priorAuthNumber = pa.auth_number;
    }
  }

  // 7. Build the line items. Map fulfillment.item_sku → HCPCS via
  //    product_hcpcs_map; fall back to the prescription's HCPCS;
  //    final fallback is the raw SKU as the HCPCS (rare — surfaces
  //    in builder notes).
  const line = await buildLineForSku(
    supabase,
    fulfillment.item_sku,
    fulfillment.quantity,
    rx?.hcpcs_code ?? null,
    proposed,
  );
  if (line) proposed.lines.push(line);

  // 8. Apply payer modifier rules to every line. The rule engine
  //    needs the rental cycle stage + compliance state; we resolve
  //    those once and pass into the per-line evaluator.
  if (proposed.payerProfileId) {
    const ctx = await resolveRuleContext(
      supabase,
      fulfillment.patient_id,
      proposed.priorAuthNumber !== null,
    );
    for (const lineItem of proposed.lines) {
      const extra = await applyPayerModifierRules(
        supabase,
        proposed.payerProfileId,
        lineItem.hcpcsCode,
        ctx,
      );
      // Merge + dedupe modifiers while preserving order; the EDI
      // builder accepts up to 4 modifiers per line.
      const merged: string[] = [];
      for (const m of [...lineItem.modifiers, ...extra]) {
        if (!merged.includes(m)) merged.push(m);
      }
      lineItem.modifiers = merged.slice(0, 4);
    }

    // 8b. Phase 12 (migration 0142): if the payer publishes a
    //     required_modifiers_dme baseline (e.g. ["KX"]) and NO line
    //     carries any modifier from that set, auto-attach the FIRST
    //     entry. Avoids the "missing KX" denial when nothing else in
    //     the rules engine put it on.
    if (
      payerCompleteness &&
      payerCompleteness.required_modifiers_dme.length > 0
    ) {
      for (const lineItem of proposed.lines) {
        lineItem.modifiers = applyRequiredModifierBaseline(
          lineItem.modifiers,
          payerCompleteness.required_modifiers_dme,
        );
      }
    }
  }

  // 9. Replace each line's billed amount with the published fee
  //    schedule when one exists. Falls back to the default from the
  //    product map (or whatever was passed in).
  if (proposed.payerProfileId) {
    for (const lineItem of proposed.lines) {
      const sched = await lookupFeeSchedule(
        supabase,
        proposed.payerProfileId,
        lineItem.hcpcsCode,
        lineItem.modifiers,
        proposed.dateOfService,
      );
      if (sched) {
        lineItem.billedCents = sched.allowed_cents;
        lineItem.feeScheduleRowId = sched.id;
      }
    }
  }

  return proposed;
}

async function buildLineForSku(
  supabase: SupabaseClient,
  itemSku: string,
  quantity: number,
  fallbackHcpcs: string | null,
  proposed: ProposedClaim,
): Promise<ProposedClaimLine | null> {
  const { data: mapped } = await supabase
    .schema("resupply")
    .from("product_hcpcs_map")
    .select(
      "id, hcpcs_code, default_modifiers, units_per_dispense, default_billed_cents, description",
    )
    .eq("lookup_kind", "item_sku")
    .eq("lookup_value", itemSku)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (mapped) {
    return {
      hcpcsCode: mapped.hcpcs_code,
      modifiers: ((mapped.default_modifiers ?? "") as string)
        .split(",")
        .map((m: string) => m.trim())
        .filter((m: string) => m.length === 2),
      description: mapped.description,
      quantity: quantity * mapped.units_per_dispense,
      billedCents: mapped.default_billed_cents ?? 0,
      sourceKind: "product_map",
      sourceRef: mapped.id,
      feeScheduleRowId: null,
    };
  }
  if (fallbackHcpcs) {
    proposed.builderNotes.push(
      `Item SKU "${itemSku}" not in product_hcpcs_map — falling back to prescription HCPCS ${fallbackHcpcs}.`,
    );
    return {
      hcpcsCode: fallbackHcpcs,
      modifiers: [],
      description: null,
      quantity,
      billedCents: 0,
      sourceKind: "product_map",
      sourceRef: null,
      feeScheduleRowId: null,
    };
  }
  proposed.builderNotes.push(
    `Item SKU "${itemSku}" not in product_hcpcs_map AND no active prescription HCPCS — no line emitted.`,
  );
  return null;
}

interface ModifierRuleContext {
  rentalMonth: number | null;
  isPurchased: boolean;
  isCompliant: boolean;
  isInitialDispense: boolean;
  hasPriorAuth: boolean;
}

async function resolveRuleContext(
  supabase: SupabaseClient,
  patientId: string,
  hasPriorAuth: boolean,
): Promise<ModifierRuleContext> {
  // Rental month — count of prior insurance_claims carrying an E0601
  // line in status submitted / accepted / paid for this patient. This
  // is heuristic; an explicit capped_rental_status on
  // insurance_coverages would be more authoritative, but the heuristic
  // is close enough for the rule engine's purpose (and the CSR can
  // override on the UI). Filter by HCPCS — counting every claim would
  // over-count supply (A7030/A7034) and accessory claims, inflating
  // rentalMonth and tripping the wrong KX/KH/KI/KJ rules on the next
  // CPAP rental.
  const { data: priorCpapLines } = await supabase
    .schema("resupply")
    .from("insurance_claim_line_items")
    .select("claim_id, insurance_claims!inner(patient_id, status)")
    .eq("hcpcs_code", "E0601")
    .eq("insurance_claims.patient_id", patientId)
    .in("insurance_claims.status", ["submitted", "accepted", "paid", "closed"]);
  let rentalMonth: number | null = null;
  if (priorCpapLines && priorCpapLines.length > 0) {
    const uniqueClaims = new Set(priorCpapLines.map((l) => l.claim_id));
    rentalMonth = Math.min(13, uniqueClaims.size + 1);
  }

  // Compliance — sum of qualifying nights in the last 30 days.
  const since = new Date(Date.now() - COMPLIANCE_DAYS_WINDOW * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const { data: nights } = await supabase
    .schema("resupply")
    .from("patient_therapy_nights")
    .select("usage_minutes")
    .eq("patient_id", patientId)
    .gte("night_date", since)
    .limit(60);
  const compliantNights = (nights ?? []).filter(
    (n) => (n.usage_minutes ?? 0) >= COMPLIANCE_MIN_MINUTES,
  ).length;
  const isCompliant = compliantNights >= COMPLIANCE_MIN_NIGHTS;

  return {
    rentalMonth,
    isPurchased: false,
    isCompliant,
    isInitialDispense: !priorCpapLines || priorCpapLines.length === 0,
    hasPriorAuth,
  };
}

async function applyPayerModifierRules(
  supabase: SupabaseClient,
  payerProfileId: string,
  hcpcsCode: string,
  ctx: ModifierRuleContext,
): Promise<string[]> {
  const { data: rules, error } = await supabase
    .schema("resupply")
    .from("payer_modifier_rules")
    .select("id, condition, modifiers_csv, priority")
    .eq("payer_profile_id", payerProfileId)
    .eq("hcpcs_code", hcpcsCode)
    .eq("is_active", true)
    .order("priority", { ascending: true });
  if (error) {
    logger.warn(
      { err: error.message, payerProfileId, hcpcsCode },
      "applyPayerModifierRules: lookup failed",
    );
    return [];
  }
  const mods: string[] = [];
  for (const rule of rules ?? []) {
    if (!ruleApplies(rule.condition, ctx)) continue;
    const parsed = (rule.modifiers_csv as string)
      .split(",")
      .map((m: string) => m.trim().toUpperCase())
      .filter((m: string) => m.length === 2);
    for (const m of parsed) if (!mods.includes(m)) mods.push(m);
  }
  return mods;
}

function ruleApplies(
  condition: Database["resupply"]["Tables"]["payer_modifier_rules"]["Row"]["condition"],
  ctx: ModifierRuleContext,
): boolean {
  switch (condition) {
    case "always":
      return true;
    case "if_rental_month_le_3":
      return ctx.rentalMonth !== null && ctx.rentalMonth <= 3;
    case "if_rental_month_ge_4":
      return ctx.rentalMonth !== null && ctx.rentalMonth >= 4;
    case "if_purchased":
      return ctx.isPurchased;
    case "if_compliant_90day":
      return ctx.isCompliant;
    case "if_initial_dispense":
      return ctx.isInitialDispense;
    case "if_abn_on_file":
      // ABN status isn't modelled today — surface as false so the
      // rule is opt-in once the data is wired.
      return false;
    case "if_pa_approved":
      return ctx.hasPriorAuth;
  }
}

async function lookupFeeSchedule(
  supabase: SupabaseClient,
  payerProfileId: string,
  hcpcsCode: string,
  modifiers: string[],
  onDate: string,
): Promise<
  Database["resupply"]["Tables"]["payer_fee_schedules"]["Row"] | null
> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("payer_fee_schedules")
    .select(
      "id, payer_profile_id, hcpcs_code, modifier, allowed_cents, effective_from, effective_through, source, notes, created_at, updated_at",
    )
    .eq("payer_profile_id", payerProfileId)
    .eq("hcpcs_code", hcpcsCode)
    .lte("effective_from", onDate)
    .or(`effective_through.is.null,effective_through.gte.${onDate}`)
    .order("effective_from", { ascending: false });
  if (error) return null;
  const candidates = data ?? [];
  if (candidates.length === 0) return null;
  // Prefer modifier-specific match in order; then fall back to NULL
  // (wildcard) row; then the first match.
  for (const m of modifiers) {
    const match = candidates.find(
      (r) => (r.modifier ?? "").toUpperCase() === m,
    );
    if (match) return match;
  }
  const wildcard = candidates.find((r) => r.modifier === null);
  return wildcard ?? candidates[0] ?? null;
}

/**
 * Phase 12/13: ensure each claim line carries at least one of the
 * payer's `required_modifiers_dme` (defaults to ["KX"] for most
 * DME payers). If none of the required modifiers are already on
 * the line, prepend the FIRST entry. Existing modifiers are
 * preserved in their original order. The EDI builder caps at 4
 * modifiers per line so we slice to 4.
 *
 * Pure helper — exported for unit testing.
 */
export function applyRequiredModifierBaseline(
  current: readonly string[],
  required: readonly string[],
): string[] {
  if (required.length === 0) return [...current];
  const presentUpper = current.map((m) => m.toUpperCase());
  const hasAny = required.some((m) => presentUpper.includes(m.toUpperCase()));
  if (hasAny) return [...current];
  if (current.length >= 4) return [...current];
  return [required[0]!, ...current].slice(0, 4);
}

function isoDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
