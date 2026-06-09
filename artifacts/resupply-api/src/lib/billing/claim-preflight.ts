// Claim preflight — structured "is this claim ready to submit?"
// checklist that powers a single CSR-friendly status panel.
//
// Each check returns a typed PreflightItem with:
//   * severity:  "ok" | "warning" | "error"
//   * key:       a stable id ("rendering_provider", "diagnosis", ...)
//                so the UI can render a consistent icon set and the
//                event log can dedupe.
//   * label:     short title shown in the CSR row.
//   * detail:    long-form one-line explanation, optionally with the
//                exact field that's missing.
//   * fixAction: a structured hint the UI can deep-link to (e.g.
//                "open patient demographics", "attach sleep study").
//
// "error" severity blocks the submit-office-ally route — the UI will
// disable the button. "warning" is non-blocking but surfaces above
// the submit button so the CSR notices.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import {
  DENIAL_RISK_WINDOW_DAYS,
  scoreDenialRiskItems,
  type DenialRiskStat,
} from "./denial-risk";
import { getCachedEligibility } from "./eligibility-verifier";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A parsed 271 older than this no longer counts as "verified" on the
 *  preflight surface (matches the 45-day window the order/claim eligibility
 *  gates use). */
const ELIGIBILITY_FRESHNESS_MS = 45 * MS_PER_DAY;

export type PreflightSeverity = "ok" | "warning" | "error";

export interface PreflightItem {
  key: string;
  severity: PreflightSeverity;
  label: string;
  detail: string;
  /** Optional hint pair the UI can deep-link to in order to fix this row.
   *  e.g. { kind: "open_patient", patientId: "..." } */
  fixAction?: PreflightFixAction | null;
}

export type PreflightFixAction =
  | { kind: "open_patient"; patientId: string }
  | { kind: "add_sleep_study"; patientId: string }
  | { kind: "add_prescription"; patientId: string }
  | { kind: "attach_prior_auth"; patientId: string; hcpcs: string }
  | { kind: "pick_payer_profile"; claimId: string }
  | { kind: "set_rendering_provider"; claimId: string }
  | { kind: "set_referring_provider"; claimId: string }
  | { kind: "add_line_item"; claimId: string }
  | { kind: "edit_line_item"; claimId: string; lineId: string }
  | { kind: "edit_address"; patientId: string };

export interface PreflightSummary {
  /** True iff no `error`-severity items. */
  readyToSubmit: boolean;
  errorCount: number;
  warningCount: number;
  items: PreflightItem[];
}

/**
 * Run every preflight check against the given claim. Always returns
 * a complete checklist (one item per check), even when the underlying
 * data is missing — that's what gives the CSR a deterministic UI.
 */
export async function preflightClaim(
  claimId: string,
): Promise<PreflightSummary> {
  const supabase = getSupabaseServiceRoleClient();
  const items: PreflightItem[] = [];
  let payerRequiresReferringProviderNpi = true;

  const { data: claim, error: cErr } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select(
      "id, patient_id, payer_name, payer_profile_id, date_of_service, status, total_billed_cents, insurance_coverage_id, rendering_provider_id, referring_provider_id, secondary_coverage_id, fulfillment_id",
    )
    .eq("id", claimId)
    .limit(1)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!claim) {
    return {
      readyToSubmit: false,
      errorCount: 1,
      warningCount: 0,
      items: [
        {
          key: "claim_exists",
          severity: "error",
          label: "Claim not found",
          detail: `No insurance_claims row found for id ${claimId}.`,
        },
      ],
    };
  }

  items.push(
    claim.status === "draft"
      ? {
          key: "claim_status",
          severity: "ok",
          label: "Claim is in draft status",
          detail: "Ready for the readiness checks below.",
        }
      : {
          key: "claim_status",
          severity: "error",
          label: "Claim is not in draft",
          detail: `Status is "${claim.status}"; only draft claims can be submitted.`,
        },
  );

  // ── Payer profile ───────────────────────────────────────────────
  if (claim.payer_profile_id) {
    const { data: payer } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select(
        "id, display_name, is_active, paper_only, office_ally_payer_id, claim_format, requires_prior_auth_dme, edi_enrollment_status, timely_filing_days, required_modifiers_dme, requires_referring_provider_npi, enrollment_status, enrollment_effective_on",
      )
      .eq("id", claim.payer_profile_id)
      .limit(1)
      .maybeSingle();
    if (!payer) {
      items.push(missingPayer(claim.id, "Payer profile row missing."));
    } else if (!payer.is_active) {
      payerRequiresReferringProviderNpi = payer.requires_referring_provider_npi;
      items.push({
        key: "payer_profile",
        severity: "error",
        label: "Payer profile is inactive",
        detail: `${payer.display_name} is marked inactive in the catalog.`,
        fixAction: { kind: "pick_payer_profile", claimId: claim.id },
      });
    } else if (payer.paper_only) {
      payerRequiresReferringProviderNpi = payer.requires_referring_provider_npi;
      items.push({
        key: "payer_profile",
        severity: "warning",
        label: "Payer is paper-only",
        detail: `${payer.display_name} doesn't accept 837P. Render a HCFA-1500 instead.`,
      });
    } else if (!payer.office_ally_payer_id) {
      payerRequiresReferringProviderNpi = payer.requires_referring_provider_npi;
      items.push({
        key: "payer_profile",
        severity: "error",
        label: "Payer has no Office Ally id",
        detail: `${payer.display_name} is missing office_ally_payer_id in the catalog.`,
      });
    } else if (payer.edi_enrollment_status !== "enrolled") {
      // Migration 0149 wired enrollment status onto every row. A
      // payer that's set up in the catalog but not enrolled in
      // Office Ally yet will reject the 837P at the clearinghouse,
      // so block submit here — the CSR's fix is to chase the
      // enrollment, not to send and hope.
      items.push({
        key: "payer_profile",
        severity: "error",
        label: "Payer is not EDI-enrolled with Office Ally",
        detail: `${payer.display_name} enrollment status is "${payer.edi_enrollment_status}". Office Ally will reject this 837P. Update the enrollment status to "enrolled" once OA confirms.`,
        fixAction: { kind: "pick_payer_profile", claimId: claim.id },
      });
    } else {
      payerRequiresReferringProviderNpi = payer.requires_referring_provider_npi;
      items.push({
        key: "payer_profile",
        severity: "ok",
        label: "Payer profile linked + EDI-enrolled",
        detail: `${payer.display_name} • OA payer id ${payer.office_ally_payer_id}`,
      });
    }

    // ── Enrollment posture (Phase 12) ───────────────────────────
    if (payer) {
      if (payer.enrollment_status === "suspended") {
        items.push({
          key: "payer_enrollment",
          severity: "error",
          label: "Our enrollment with this payer is suspended",
          detail: `${payer.display_name} has us in suspended status — claims will reject. Resolve enrollment before submitting.`,
        });
      } else if (payer.enrollment_status === "pending") {
        items.push({
          key: "payer_enrollment",
          severity: "warning",
          label: "Enrollment with this payer is still pending",
          detail: `${payer.display_name} hasn't activated our TIN yet; the claim may reject at the clearinghouse.`,
        });
      } else if (payer.enrollment_status === "unknown") {
        items.push({
          key: "payer_enrollment",
          severity: "warning",
          label: "Enrollment posture not recorded",
          detail: `${payer.display_name} enrollment_status is "unknown" — set it in the payer profile so the preflight knows.`,
        });
      } else if (payer.enrollment_status === "not_required") {
        items.push({
          key: "payer_enrollment",
          severity: "ok",
          label: "Enrollment not required",
          detail: `${payer.display_name} does not require enrollment for claim submission.`,
        });
      } else if (
        payer.enrollment_status === "active" &&
        payer.enrollment_effective_on &&
        payer.enrollment_effective_on > claim.date_of_service
      ) {
        items.push({
          key: "payer_enrollment",
          severity: "error",
          label: "Date of service pre-dates our enrollment",
          detail: `Our enrollment with ${payer.display_name} began on ${payer.enrollment_effective_on}; claims with earlier DOS will deny.`,
        });
      } else if (payer.enrollment_status === "active") {
        items.push({
          key: "payer_enrollment",
          severity: "ok",
          label: "Enrollment active",
          detail: `Active with ${payer.display_name}${payer.enrollment_effective_on ? ` since ${payer.enrollment_effective_on}` : ""}.`,
        });
      }

      // ── Timely filing window (Phase 12) ───────────────────────
      if (payer.timely_filing_days != null && claim.date_of_service) {
        const dos = toUtcDateEpochMs(new Date(claim.date_of_service));
        const today = toUtcDateEpochMs(new Date());
        const ageDays = Math.floor((today - dos) / MS_PER_DAY);
        const remaining = payer.timely_filing_days - ageDays;
        if (remaining < 0) {
          items.push({
            key: "timely_filing",
            severity: "error",
            label: "Past the timely-filing deadline",
            detail: `${payer.display_name} requires submission within ${payer.timely_filing_days} days of DOS; this claim is ${-remaining} day(s) past.`,
          });
        } else if (remaining <= 14) {
          items.push({
            key: "timely_filing",
            severity: "warning",
            label: `Only ${remaining} day(s) left on the filing window`,
            detail: `${payer.display_name} accepts initial claims for ${payer.timely_filing_days} days from DOS; submit soon.`,
          });
        } else {
          items.push({
            key: "timely_filing",
            severity: "ok",
            label: `${remaining} day(s) left on the filing window`,
            detail: `${payer.display_name} timely-filing window: ${payer.timely_filing_days} days from DOS.`,
          });
        }
      } else if (payer.timely_filing_days == null) {
        items.push({
          key: "timely_filing",
          severity: "warning",
          label: "Timely-filing window not configured",
          detail: `${payer.display_name} is missing timely_filing_days in the payer profile.`,
        });
      } else {
        items.push({
          key: "timely_filing",
          severity: "warning",
          label: "Date of service missing",
          detail:
            "Claim is missing date_of_service, so timely filing cannot be calculated.",
        });
      }

      // ── Required modifiers (Phase 12) ─────────────────────────
      if (
        !payer.required_modifiers_dme ||
        payer.required_modifiers_dme.length === 0
      ) {
        items.push({
          key: "payer_modifiers",
          severity: "warning",
          label: "Required payer modifiers not configured",
          detail: `${payer.display_name} has no required_modifiers_dme configured in the payer profile.`,
        });
      } else {
        const { data: lines } = await supabase
          .schema("resupply")
          .from("insurance_claim_line_items")
          .select("hcpcs_code, modifier")
          .eq("claim_id", claim.id);
        const modifierTokens = new Set<string>();
        for (const l of lines ?? []) {
          for (const m of (l.modifier ?? "").split(",")) {
            const t = m.trim().toUpperCase();
            if (t) modifierTokens.add(t);
          }
        }
        // Soft-check: KX is the universally-required medical-necessity
        // modifier. The other entries in required_modifiers_dme are
        // alternatives (RR/NU, KH/KI/KJ rotations) — the scrubber owns
        // the deeper per-line lookup; preflight just flags absence of
        // ANY of the required modifiers.
        const hasAny = payer.required_modifiers_dme.some((m: string) =>
          modifierTokens.has(m.toUpperCase()),
        );
        if (!hasAny) {
          items.push({
            key: "payer_modifiers",
            severity: "warning",
            label: "Required payer modifiers may be missing",
            detail: `${payer.display_name} expects at least one of: ${payer.required_modifiers_dme.join(", ")}. Verify each line.`,
          });
        } else {
          items.push({
            key: "payer_modifiers",
            severity: "ok",
            label: "Required payer modifiers present",
            detail: `${payer.display_name} requires at least one of ${payer.required_modifiers_dme.join(", ")} and the claim includes them.`,
          });
        }
      }

      // ── Referring provider NPI (Phase 12) ─────────────────────
      if (payer.requires_referring_provider_npi) {
        if (!claim.referring_provider_id) {
          items.push({
            key: "payer_referring_provider",
            severity: "error",
            label: "Referring provider NPI required",
            detail: `${payer.display_name} requires loop 2310A; this claim has no referring provider attached.`,
            fixAction: { kind: "set_referring_provider", claimId: claim.id },
          });
        } else {
          items.push({
            key: "payer_referring_provider",
            severity: "ok",
            label: "Referring provider attached",
            detail: `${payer.display_name} requires a referring provider and one is attached to this claim.`,
          });
        }
      } else {
        items.push({
          key: "payer_referring_provider",
          severity: "ok",
          label: "Referring provider not required",
          detail: `${payer.display_name} does not require a referring provider for this claim.`,
        });
      }
    }
  } else {
    items.push(missingPayer(claim.id, "No payer_profile_id on the claim."));
  }

  // ── Insurance coverage ──────────────────────────────────────────
  if (claim.insurance_coverage_id) {
    items.push({
      key: "coverage",
      severity: "ok",
      label: "Insurance coverage linked",
      detail: "Primary coverage selected.",
    });
  } else {
    items.push({
      key: "coverage",
      severity: "error",
      label: "Insurance coverage missing",
      detail: "Pick a primary insurance coverage from the patient's record.",
      fixAction: { kind: "open_patient", patientId: claim.patient_id },
    });
  }

  // ── Eligibility (cached 270/271) ────────────────────────────────
  // Surface the coverage's most recent parsed 271 right where the CSR
  // submits. ADVISORY ONLY (warning/ok, never error): the actual hold on
  // a bad result lives in the toggleable claim precheck
  // (billing.eligibility_precheck), so the preflight never hard-blocks on
  // eligibility. Fail-soft: any lookup error just omits the row.
  if (claim.insurance_coverage_id) {
    try {
      const elig = await getCachedEligibility(
        claim.insurance_coverage_id,
        ELIGIBILITY_FRESHNESS_MS,
      );
      if (!elig) {
        items.push({
          key: "eligibility",
          severity: "warning",
          label: "Eligibility not verified recently",
          detail:
            "No recent 270/271 on file for this coverage — run an eligibility check before submitting.",
          fixAction: { kind: "open_patient", patientId: claim.patient_id },
        });
      } else {
        const checkedOn = (elig.responded_at ?? elig.requested_at ?? "").slice(
          0,
          10,
        );
        const checked = checkedOn ? ` (checked ${checkedOn})` : "";
        if (elig.is_active === false) {
          items.push({
            key: "eligibility",
            severity: "warning",
            label: "Coverage shows inactive",
            detail: `The last 270/271${checked} returned an inactive plan — verify before submitting; this claim will likely deny.`,
            fixAction: { kind: "open_patient", patientId: claim.patient_id },
          });
        } else if (elig.requires_prior_auth === true) {
          items.push({
            key: "eligibility",
            severity: "warning",
            label: "Eligibility flags prior-auth required",
            detail: `The last 270/271${checked} indicates this plan requires prior authorization.`,
          });
        } else if (elig.is_active === true) {
          const net =
            elig.in_network === true
              ? " · in-network"
              : elig.in_network === false
                ? " · out-of-network"
                : "";
          items.push({
            key: "eligibility",
            severity: "ok",
            label: "Coverage active",
            detail: `The last 270/271${checked} returned active coverage${net}.`,
          });
        } else {
          items.push({
            key: "eligibility",
            severity: "ok",
            label: "Eligibility on file",
            detail: `The last 270/271${checked} did not explicitly return a coverage status.`,
          });
        }
      }
    } catch (err) {
      logger.warn(
        {
          event: "billing.preflight.eligibility_failed",
          claimId: claim.id,
          errName: err instanceof Error ? err.name : "unknown",
        },
        "preflight: eligibility surface skipped (non-fatal)",
      );
    }
  }

  // ── Patient demographics + address ──────────────────────────────
  const { data: patient } = await supabase
    .schema("resupply")
    .from("patients")
    .select("legal_first_name, legal_last_name, date_of_birth, address")
    .eq("id", claim.patient_id)
    .limit(1)
    .maybeSingle();
  if (!patient) {
    items.push({
      key: "patient",
      severity: "error",
      label: "Patient row missing",
      detail: `No patient ${claim.patient_id}.`,
    });
  } else {
    const okAddress = hasStructuredAddress(patient.address);
    items.push(
      okAddress
        ? {
            key: "patient_address",
            severity: "ok",
            label: "Patient address present",
            detail: "Subscriber address will populate 5010 loop 2010BA.",
          }
        : {
            key: "patient_address",
            severity: "error",
            label: "Patient address incomplete",
            detail: "5010 requires line1/city/state/zip on the subscriber.",
            fixAction: { kind: "edit_address", patientId: claim.patient_id },
          },
    );
  }

  // ── Diagnosis (from latest sleep study) ─────────────────────────
  const { data: sleep } = await supabase
    .schema("resupply")
    .from("sleep_studies")
    .select("diagnosis_icd10, study_date")
    .eq("patient_id", claim.patient_id)
    .not("diagnosis_icd10", "is", null)
    .order("study_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  items.push(
    sleep?.diagnosis_icd10
      ? {
          key: "diagnosis",
          severity: "ok",
          label: "Diagnosis on file",
          detail: `ICD-10 ${sleep.diagnosis_icd10} from sleep study ${sleep.study_date}.`,
        }
      : {
          key: "diagnosis",
          severity: "error",
          label: "No diagnosis available",
          detail: "Add a sleep study with an ICD-10 diagnosis before billing.",
          fixAction: { kind: "add_sleep_study", patientId: claim.patient_id },
        },
  );

  // ── Line items ──────────────────────────────────────────────────
  const { data: lines } = await supabase
    .schema("resupply")
    .from("insurance_claim_line_items")
    .select("id, hcpcs_code, modifier, billed_cents, quantity, narrative")
    .eq("claim_id", claim.id);
  if (!lines || lines.length === 0) {
    items.push({
      key: "line_items",
      severity: "error",
      label: "No line items",
      detail: "Add at least one HCPCS line before submitting.",
      fixAction: { kind: "add_line_item", claimId: claim.id },
    });
  } else {
    items.push({
      key: "line_items",
      severity: "ok",
      label: `${lines.length} line item${lines.length === 1 ? "" : "s"} present`,
      detail: lines
        .slice(0, 3)
        .map((l) => `${l.hcpcs_code} × ${l.quantity}`)
        .join(", "),
    });

    // Each line should have a billed amount > 0.
    const zeroBilled = lines.filter((l) => (l.billed_cents ?? 0) === 0);
    if (zeroBilled.length > 0) {
      items.push({
        key: "line_billed_amount",
        severity: "warning",
        label: `${zeroBilled.length} line${zeroBilled.length === 1 ? "" : "s"} have $0 billed`,
        detail: "Set a billed amount or attach a payer fee schedule.",
        fixAction: {
          kind: "edit_line_item",
          claimId: claim.id,
          lineId: zeroBilled[0]!.id,
        },
      });
    }

    // ── NOC / miscellaneous HCPCS need a narrative (837P NTE) ───────
    // Medicare DME rejects a miscellaneous / not-otherwise-classified
    // HCPCS line that carries no narrative (item description + MSRP). The
    // 837P builder emits the loop-2400 NTE only when the line has one, so
    // flag a NOC line whose `narrative` is blank before it's submitted.
    const nocMissingNarrative = lines.filter(
      (l) =>
        isNocHcpcs(l.hcpcs_code) && (l.narrative ?? "").trim().length === 0,
    );
    if (nocMissingNarrative.length > 0) {
      const first = nocMissingNarrative[0]!;
      items.push({
        key: "noc_narrative",
        severity: "error",
        label: "Miscellaneous HCPCS line needs a narrative",
        detail: `${nocMissingNarrative
          .map((l) => l.hcpcs_code)
          .join(
            ", ",
          )} is a not-otherwise-classified code — Medicare DME requires an item description + MSRP narrative (837P NTE) or the line denies. Add it to the line.`,
        fixAction: {
          kind: "edit_line_item",
          claimId: claim.id,
          lineId: first.id,
        },
      });
    }
  }

  // ── Total billed matches sum of lines ───────────────────────────
  if (lines && lines.length > 0) {
    // billed_cents is per-unit; the extended line charge is
    // billed_cents * quantity, matching the header total recompute.
    const sum = lines.reduce(
      (s, l) => s + (l.billed_cents ?? 0) * (l.quantity ?? 1),
      0,
    );
    if (sum !== claim.total_billed_cents) {
      items.push({
        key: "totals",
        severity: "warning",
        label: "Claim total doesn't match line sum",
        detail: `Header says ${formatCents(claim.total_billed_cents)}, lines sum to ${formatCents(sum)}.`,
      });
    } else {
      items.push({
        key: "totals",
        severity: "ok",
        label: "Totals balance",
        detail: `Header + lines both at ${formatCents(sum)}.`,
      });
    }
  }

  // ── Rendering + referring providers ─────────────────────────────
  items.push(
    claim.rendering_provider_id
      ? {
          key: "rendering_provider",
          severity: "ok",
          label: "Rendering provider attached",
          detail: "Will populate 837P loop 2310B.",
        }
      : {
          key: "rendering_provider",
          severity: "warning",
          label: "No rendering provider",
          detail:
            "Optional for most commercial payers; Medicare DME often requires it.",
          fixAction: { kind: "set_rendering_provider", claimId: claim.id },
        },
  );
  items.push(
    payerRequiresReferringProviderNpi
      ? claim.referring_provider_id
        ? {
            key: "referring_provider",
            severity: "ok",
            label: "Referring provider attached",
            detail: "Will populate 837P loop 2310D (the prescriber).",
          }
        : {
            key: "referring_provider",
            severity: "error",
            label: "Referring (prescribing) provider missing",
            detail:
              "Medicare DME and most commercial DME payers reject claims without the prescribing provider NPI.",
            fixAction: { kind: "set_referring_provider", claimId: claim.id },
          }
      : {
          key: "referring_provider",
          severity: "ok",
          label: "Referring provider not required",
          detail:
            "Selected payer does not require a referring provider for this claim.",
        },
  );

  // ── Prior authorization (when payer requires) ───────────────────
  if (claim.payer_profile_id && lines && lines.length > 0) {
    const { data: payer } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select("requires_prior_auth_dme, display_name")
      .eq("id", claim.payer_profile_id)
      .limit(1)
      .maybeSingle();
    if (payer?.requires_prior_auth_dme) {
      // Look up the PA per HCPCS — a CPAP machine usually requires
      // PA but supplies don't. We treat ANY approved PA covering one
      // of the line HCPCS codes as sufficient.
      const hcpcsList = lines.map((l) => l.hcpcs_code);
      const { data: pas } = await supabase
        .schema("resupply")
        .from("prior_authorizations")
        .select("auth_number, status, approved_through, hcpcs_code")
        .eq("patient_id", claim.patient_id)
        .eq("status", "approved")
        .in("hcpcs_code", hcpcsList);
      if (!pas || pas.length === 0) {
        items.push({
          key: "prior_auth",
          severity: "warning",
          label: `${payer.display_name} typically requires prior auth`,
          detail: `No approved PA on file for any of: ${hcpcsList.join(", ")}.`,
          fixAction: {
            kind: "attach_prior_auth",
            patientId: claim.patient_id,
            hcpcs: hcpcsList[0]!,
          },
        });
      } else {
        items.push({
          key: "prior_auth",
          severity: "ok",
          label: "Prior auth on file",
          detail: `${pas.length} approved PA${pas.length === 1 ? "" : "s"} cover claim HCPCS.`,
        });
      }
    }
  }

  // ── KX modifier implies documented compliance ───────────────────
  if (
    lines &&
    lines.some((l) => (l.modifier ?? "").toUpperCase().includes("KX"))
  ) {
    const compliant = await isPatientCompliant(supabase, claim.patient_id);
    items.push(
      compliant
        ? {
            key: "compliance_for_kx",
            severity: "ok",
            label: "Patient meets 90-day compliance",
            detail: "Supports KX modifier on capped-rental + resupply lines.",
          }
        : {
            key: "compliance_for_kx",
            severity: "warning",
            label: "KX modifier used but compliance not documented",
            detail:
              "Per LCD L33718 the KX modifier asserts compliance: 21+ nights of 4+ hours in any 30-day window.",
          },
    );
  }

  // ── Predictive denial risk (payer × HCPCS history) ──────────────
  // Non-blocking heads-up: if this payer has historically denied a high
  // share of recent decisioned claims carrying one of this claim's HCPCS
  // codes, surface it so the CSR double-checks modifiers/docs before
  // submit. Fail-soft: any error / missing payer profile / thin history
  // → no opinion (never adds an error, never blocks, never throws).
  if (claim.payer_profile_id && lines && lines.length > 0) {
    try {
      const distinctHcpcs = [...new Set(lines.map((l) => l.hcpcs_code))];
      const cutoff = new Date(
        Date.now() - DENIAL_RISK_WINDOW_DAYS * MS_PER_DAY,
      ).toISOString();
      const { data: riskRows, error: riskErr } = await supabase
        .schema("resupply")
        .rpc("billing_denial_risk", {
          p_payer_profile_id: claim.payer_profile_id,
          p_hcpcs: distinctHcpcs,
          p_cutoff: cutoff,
        });
      if (riskErr) throw riskErr;
      const stats: DenialRiskStat[] = (
        (riskRows ?? []) as Array<{
          hcpcs_code: string;
          decisions: number | string;
          denials: number | string;
        }>
      ).map((r) => ({
        hcpcsCode: String(r.hcpcs_code),
        // PostgREST serializes bigint as string — coerce defensively.
        decisions: Number(r.decisions),
        denials: Number(r.denials),
      }));
      items.push(
        ...scoreDenialRiskItems(claim.payer_name ?? "This payer", stats),
      );
    } catch (err) {
      logger.warn(
        {
          event: "billing.preflight.denial_risk_failed",
          claimId: claim.id,
          errName: err instanceof Error ? err.name : "unknown",
        },
        "preflight: denial-risk scoring skipped (non-fatal)",
      );
    }
  }

  // ── Submit-readiness summary ────────────────────────────────────
  const errorCount = items.filter((i) => i.severity === "error").length;
  const warningCount = items.filter((i) => i.severity === "warning").length;
  return {
    readyToSubmit: errorCount === 0,
    errorCount,
    warningCount,
    items,
  };
}

/**
 * Miscellaneous / not-otherwise-classified (NOC) HCPCS codes that
 * Medicare DME requires a narrative (item description + MSRP) for. A
 * narrative-less NOC line denies as unprocessable, so the preflight
 * blocks on it. Kept deliberately small + DME-relevant (the codes a
 * CPAP/DME supplier actually touches); extend as needed. Exported for
 * unit testing.
 */
const NOC_HCPCS = new Set([
  "E1399", // Durable medical equipment, miscellaneous
  "A9999", // Miscellaneous DME supply or accessory, not otherwise specified
  "K0108", // Wheelchair component or accessory, not otherwise specified
  "A4649", // Surgical supply, miscellaneous
  "E1699", // Dialysis equipment, not otherwise specified
  "K0900", // Customized DME, other than wheelchair
  "L9999", // Lower-limb orthosis/prosthesis, not otherwise specified
]);

export function isNocHcpcs(hcpcs: string | null | undefined): boolean {
  if (!hcpcs) return false;
  return NOC_HCPCS.has(hcpcs.trim().toUpperCase());
}

function missingPayer(claimId: string, detail: string): PreflightItem {
  return {
    key: "payer_profile",
    severity: "error",
    label: "Payer profile not selected",
    detail,
    fixAction: { kind: "pick_payer_profile", claimId },
  };
}

function hasStructuredAddress(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const a = raw as {
    line1?: unknown;
    city?: unknown;
    state?: unknown;
    zip?: unknown;
  };
  return (
    typeof a.line1 === "string" &&
    typeof a.city === "string" &&
    typeof a.state === "string" &&
    typeof a.zip === "string" &&
    a.line1.length > 0 &&
    a.city.length > 0 &&
    a.state.length >= 2 &&
    a.zip.length >= 5
  );
}

function formatCents(cents: number): string {
  // Handle negative amounts correctly. Math.floor + % on a negative
  // number yields a garbage formatted string like "$-2.-50" because
  // both quotient and remainder go negative. Strip the sign first.
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const d = Math.floor(abs / 100);
  const c = abs % 100;
  return `${sign}$${d}.${c.toString().padStart(2, "0")}`;
}

function toUtcDateEpochMs(value: Date): number {
  return Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate(),
  );
}

async function isPatientCompliant(
  supabase: SupabaseClient,
  patientId: string,
): Promise<boolean> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const { data: nights } = await supabase
    .schema("resupply")
    .from("patient_therapy_nights")
    .select("usage_minutes")
    .eq("patient_id", patientId)
    .gte("night_date", since)
    .limit(60);
  const compliant = (nights ?? []).filter(
    (n) => (n.usage_minutes ?? 0) >= 240,
  ).length;
  return compliant >= 21;
}
