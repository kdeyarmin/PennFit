// AI patch contract + safe applier.
//
// The scrubber and the denial analyzer both produce STRUCTURED patches
// the human can one-click apply. A "patch" is a typed action against
// a specific field on the claim or one of its line items. The set is
// deliberately small + whitelisted so a hallucinated patch shape can
// NEVER mutate the database. Everything that doesn't pass the schema
// is dropped with an audit-visible "unknown_patch" log row.
//
// Patch kinds we currently support:
//
//   set_claim_field         — patch a whitelisted scalar column on
//                             resupply.insurance_claims.
//   set_line_modifier       — set the modifier CSV on a line item
//                             (by hcpcs code; ambiguous matches are
//                             rejected).
//   set_line_billed_cents   — change a line item's billed amount.
//   add_diagnosis           — append an ICD-10 to claim notes (we
//                             keep diagnoses in notes for now; a
//                             structured diagnosis array lands later).
//   add_line                — append a HCPCS line.
//   remove_line             — remove a line by hcpcs code.
//   set_prior_auth_number   — append the prior-auth number to claim
//                             notes (no structured PA column yet; see
//                             appendPriorAuthNote). Mirrors add_diagnosis;
//                             never clobbers claim_number.
//
// PHI posture: patches reference fields by name and contain only
// payer-side identifiers, HCPCS codes, modifier strings, and money.
// We never accept a patch that writes patient demographic data.

import { z } from "zod";

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../logger";

const HCPCS_RE = /^[A-Z]\d{4}$/;
const MOD_CSV_RE = /^([A-Z0-9]{2})(,[A-Z0-9]{2})*$/;
const ICD10_RE = /^[A-Z]\d{2}(\.[A-Z0-9]{1,4})?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CLAIM_FIELD_WHITELIST = [
  "denial_reason",
  "claim_number",
  "date_of_service",
  "patient_responsibility_cents",
] as const;

type ClaimFieldKey = (typeof CLAIM_FIELD_WHITELIST)[number];

export const aiPatchSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("set_claim_field"),
      field: z.enum(CLAIM_FIELD_WHITELIST),
      value: z.union([z.string(), z.number(), z.null()]),
      rationale: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_line_modifier"),
      hcpcsCode: z.string().regex(HCPCS_RE),
      modifierCsv: z
        .string()
        .max(32)
        .transform((s) => s.toUpperCase())
        .refine((s) => s === "" || MOD_CSV_RE.test(s)),
      rationale: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_line_billed_cents"),
      hcpcsCode: z.string().regex(HCPCS_RE),
      billedCents: z.number().int().min(0),
      rationale: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("add_diagnosis"),
      icd10: z
        .string()
        .max(12)
        .transform((s) => s.toUpperCase())
        .refine((s) => ICD10_RE.test(s)),
      rationale: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("add_line"),
      hcpcsCode: z.string().regex(HCPCS_RE),
      modifierCsv: z
        .string()
        .max(32)
        .nullable()
        .optional()
        .transform((s) => (s ? s.toUpperCase() : null))
        .refine((s) => s === null || MOD_CSV_RE.test(s)),
      quantity: z.number().int().min(1).max(9999),
      billedCents: z.number().int().min(0),
      description: z.string().max(240).optional(),
      rationale: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove_line"),
      hcpcsCode: z.string().regex(HCPCS_RE),
      rationale: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_prior_auth_number"),
      authNumber: z.string().min(1).max(64),
      rationale: z.string().max(500).optional(),
    })
    .strict(),
]);

export type AiPatch = z.infer<typeof aiPatchSchema>;

export interface PatchApplyOutcome {
  patchIndex: number;
  kind: string;
  status: "applied" | "skipped" | "errored" | "unknown";
  message?: string;
}

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

/**
 * Parse a raw patch array out of model output. Unknown / malformed
 * entries are dropped silently — they NEVER reach applyAiPatches.
 *
 * Returns the parsed patches plus a parallel array of indices we
 * dropped, so the caller can include "model returned 3 patches, we
 * accepted 2" in the audit trail.
 */
export function parseAiPatches(raw: unknown): {
  patches: AiPatch[];
  dropped: Array<{ index: number; reason: string }>;
} {
  if (!Array.isArray(raw)) return { patches: [], dropped: [] };
  const patches: AiPatch[] = [];
  const dropped: Array<{ index: number; reason: string }> = [];
  raw.forEach((entry, index) => {
    const parsed = aiPatchSchema.safeParse(entry);
    if (!parsed.success) {
      dropped.push({
        index,
        reason: parsed.error.issues[0]?.message ?? "schema_violation",
      });
      return;
    }
    patches.push(parsed.data);
  });
  return { patches, dropped };
}

/**
 * Apply a sequence of parsed patches against a claim. Returns a
 * per-patch outcome so the caller can persist it on
 * claim_scrub_results.applied_patches_log.
 *
 * Order matters: patches are applied in array order. We DO NOT
 * roll back applied patches if a later one fails — the audit shows
 * which ones landed and which didn't.
 */
export async function applyAiPatches(
  claimId: string,
  patches: AiPatch[],
): Promise<PatchApplyOutcome[]> {
  const supabase = getSupabaseServiceRoleClient();
  const outcomes: PatchApplyOutcome[] = [];

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i]!;
    try {
      const outcome = await applySingle(supabase, claimId, patch);
      outcomes.push({ patchIndex: i, kind: patch.kind, ...outcome });
    } catch (err) {
      outcomes.push({
        patchIndex: i,
        kind: patch.kind,
        status: "errored",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // After patches land, recompute the claim header total from the
  // lines so the EDI builder + preflight see a consistent number.
  await recomputeTotals(supabase, claimId).catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), claimId },
      "ai-patch: recomputeTotals failed (non-fatal)",
    );
  });

  return outcomes;
}

async function applySingle(
  supabase: SupabaseClient,
  claimId: string,
  patch: AiPatch,
): Promise<{ status: PatchApplyOutcome["status"]; message?: string }> {
  switch (patch.kind) {
    case "set_claim_field":
      return applyClaimFieldPatch(supabase, claimId, patch.field, patch.value);
    case "set_line_modifier":
      return applyLinePatch(supabase, claimId, patch.hcpcsCode, {
        modifier: patch.modifierCsv || null,
      });
    case "set_line_billed_cents":
      return applyLinePatch(supabase, claimId, patch.hcpcsCode, {
        billed_cents: patch.billedCents,
      });
    case "add_diagnosis":
      return appendDiagnosisNote(supabase, claimId, patch.icd10);
    case "add_line":
      return addLineItem(supabase, claimId, patch);
    case "remove_line":
      return removeLineByHcpcs(supabase, claimId, patch.hcpcsCode);
    case "set_prior_auth_number":
      return appendPriorAuthNote(supabase, claimId, patch.authNumber);
  }
}

async function applyClaimFieldPatch(
  supabase: SupabaseClient,
  claimId: string,
  field: ClaimFieldKey,
  value: string | number | null,
): Promise<{ status: PatchApplyOutcome["status"]; message?: string }> {
  // Per-field validation. The whitelist already constrains WHICH
  // fields can be set; this layer constrains the value shape.
  if (field === "date_of_service") {
    if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
      return {
        status: "skipped",
        message: "date_of_service must be a YYYY-MM-DD string",
      };
    }
  }
  if (field === "patient_responsibility_cents") {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return {
        status: "skipped",
        message: "patient_responsibility_cents must be a non-negative integer",
      };
    }
  }
  const update: Database["resupply"]["Tables"]["insurance_claims"]["Update"] = {
    updated_at: new Date().toISOString(),
  };
  if (field === "denial_reason") update.denial_reason = value as string | null;
  else if (field === "claim_number")
    update.claim_number = value as string | null;
  else if (field === "date_of_service")
    update.date_of_service = value as string;
  else if (field === "patient_responsibility_cents")
    update.patient_responsibility_cents = value as number;

  const { error } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .update(update)
    .eq("id", claimId);
  if (error) return { status: "errored", message: error.message };
  return { status: "applied" };
}

async function applyLinePatch(
  supabase: SupabaseClient,
  claimId: string,
  hcpcsCode: string,
  patch: { modifier?: string | null; billed_cents?: number },
): Promise<{ status: PatchApplyOutcome["status"]; message?: string }> {
  const { data: matches } = await supabase
    .schema("resupply")
    .from("insurance_claim_line_items")
    .select("id, hcpcs_code")
    .eq("claim_id", claimId)
    .eq("hcpcs_code", hcpcsCode);
  if (!matches || matches.length === 0) {
    return {
      status: "skipped",
      message: `no line item with HCPCS ${hcpcsCode}`,
    };
  }
  if (matches.length > 1) {
    // Ambiguous match — refuse rather than guess. The CSR can
    // disambiguate by hand.
    return {
      status: "skipped",
      message: `multiple line items with HCPCS ${hcpcsCode}; patch ambiguous`,
    };
  }
  const update: Database["resupply"]["Tables"]["insurance_claim_line_items"]["Update"] =
    {
      updated_at: new Date().toISOString(),
    };
  if (patch.modifier !== undefined) update.modifier = patch.modifier;
  if (patch.billed_cents !== undefined)
    update.billed_cents = patch.billed_cents;
  const { error } = await supabase
    .schema("resupply")
    .from("insurance_claim_line_items")
    .update(update)
    .eq("id", matches[0]!.id);
  if (error) return { status: "errored", message: error.message };
  return { status: "applied" };
}

async function appendDiagnosisNote(
  supabase: SupabaseClient,
  claimId: string,
  icd10: string,
): Promise<{ status: PatchApplyOutcome["status"]; message?: string }> {
  // Diagnoses aren't a structured column on insurance_claims today
  // (the 837P builder reads from sleep_studies). We append the code
  // to the claim notes with a stable marker so the EDI builder and
  // the CSR UI can opt-in to pulling it.
  const { data: claim } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("notes")
    .eq("id", claimId)
    .limit(1)
    .maybeSingle();
  const marker = `[ai-dx:${icd10}]`;
  if (claim?.notes?.includes(marker)) {
    return { status: "skipped", message: "diagnosis already noted" };
  }
  const updated = claim?.notes ? `${claim.notes} ${marker}` : marker;
  const { error } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .update({ notes: updated, updated_at: new Date().toISOString() })
    .eq("id", claimId);
  if (error) return { status: "errored", message: error.message };
  return { status: "applied" };
}

async function appendPriorAuthNote(
  supabase: SupabaseClient,
  claimId: string,
  authNumber: string,
): Promise<{ status: PatchApplyOutcome["status"]; message?: string }> {
  // No structured prior-auth column on insurance_claims yet (the 837P
  // REF*G1 builder will read from one once it lands). Writing the PA
  // number into claim_number would clobber the payer/clearinghouse
  // submission tracking reference, so we append it to notes with a
  // stable marker — the same pattern as appendDiagnosisNote — for the
  // EDI builder and CSR UI to opt into. Idempotent on the marker.
  const { data: claim } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("notes")
    .eq("id", claimId)
    .limit(1)
    .maybeSingle();
  const marker = `[ai-pa:${authNumber}]`;
  if (claim?.notes?.includes(marker)) {
    return { status: "skipped", message: "prior-auth already noted" };
  }
  const updated = claim?.notes ? `${claim.notes} ${marker}` : marker;
  const { error } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .update({ notes: updated, updated_at: new Date().toISOString() })
    .eq("id", claimId);
  if (error) return { status: "errored", message: error.message };
  return { status: "applied" };
}

async function addLineItem(
  supabase: SupabaseClient,
  claimId: string,
  patch: Extract<AiPatch, { kind: "add_line" }>,
): Promise<{ status: PatchApplyOutcome["status"]; message?: string }> {
  const { error } = await supabase
    .schema("resupply")
    .from("insurance_claim_line_items")
    .insert({
      claim_id: claimId,
      hcpcs_code: patch.hcpcsCode,
      modifier: patch.modifierCsv ?? null,
      description: patch.description ?? null,
      quantity: patch.quantity,
      billed_cents: patch.billedCents,
      status: "pending",
    });
  if (error) return { status: "errored", message: error.message };
  return { status: "applied" };
}

async function removeLineByHcpcs(
  supabase: SupabaseClient,
  claimId: string,
  hcpcsCode: string,
): Promise<{ status: PatchApplyOutcome["status"]; message?: string }> {
  const { data: matches } = await supabase
    .schema("resupply")
    .from("insurance_claim_line_items")
    .select("id")
    .eq("claim_id", claimId)
    .eq("hcpcs_code", hcpcsCode);
  if (!matches || matches.length === 0) {
    return {
      status: "skipped",
      message: `no line item with HCPCS ${hcpcsCode}`,
    };
  }
  if (matches.length > 1) {
    return {
      status: "skipped",
      message: `multiple line items with HCPCS ${hcpcsCode}; refusing ambiguous delete`,
    };
  }
  const { error } = await supabase
    .schema("resupply")
    .from("insurance_claim_line_items")
    .delete()
    .eq("id", matches[0]!.id);
  if (error) return { status: "errored", message: error.message };
  return { status: "applied" };
}

async function recomputeTotals(
  supabase: SupabaseClient,
  claimId: string,
): Promise<void> {
  const { data: lines } = await supabase
    .schema("resupply")
    .from("insurance_claim_line_items")
    .select("billed_cents, quantity, allowed_cents, paid_cents")
    .eq("claim_id", claimId);
  const totals = (lines ?? []).reduce(
    (acc, l) => ({
      // billed_cents is per-unit → extended charge is * quantity.
      // allowed/paid are payer 835 line totals (already extended).
      billed: acc.billed + (l.billed_cents ?? 0) * (l.quantity ?? 1),
      allowed: acc.allowed + (l.allowed_cents ?? 0),
      paid: acc.paid + (l.paid_cents ?? 0),
    }),
    { billed: 0, allowed: 0, paid: 0 },
  );
  const { error: totalsErr } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .update({
      total_billed_cents: totals.billed,
      total_allowed_cents: totals.allowed,
      total_paid_cents: totals.paid,
      updated_at: new Date().toISOString(),
    })
    .eq("id", claimId);
  if (totalsErr) {
    logger.error(
      { err: totalsErr.message, claimId },
      "ai-patch: claim totals recompute update failed — totals out of sync with line items",
    );
  }
}
