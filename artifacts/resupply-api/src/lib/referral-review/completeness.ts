// Referral completeness assessment — "what's here, what's missing, and what
// to ask the provider for."
//
// A referral is only actionable once it carries enough to (a) build the
// patient's chart, (b) bill it, and (c) establish PAP medical necessity. This
// pure helper checks each required element against the extracted/edited
// referral and, for anything not present, produces the exact line to send the
// referring provider — so the operator doesn't read 100 pages to discover a
// missing NPI or an absent sleep study.
//
// Status meaning:
//   * present   — the element is on the referral and usable.
//   * attention — present but not sufficient (e.g. an order without an NPI,
//                 or a 5–14 study with no documented comorbidity).
//   * missing   — not on the referral at all.
//
// PHI-free: the result carries labels + statuses + generic request text, never
// patient values.

import type { PapQualification } from "./qualification";

export type ReferralCompletenessStatus = "present" | "attention" | "missing";

export interface ReferralCompletenessItem {
  key:
    | "demographics"
    | "insurance"
    | "diagnosis"
    | "sleep_study"
    | "physician_order"
    | "face_to_face";
  label: string;
  status: ReferralCompletenessStatus;
  detail: string;
  /** What to request from the provider — set whenever status ≠ present. */
  request?: string;
}

export interface ReferralCompleteness {
  items: ReferralCompletenessItem[];
  /** Count of items that are missing or need attention. */
  outstandingCount: number;
  /** True only when every element is `present`. */
  complete: boolean;
  /** The request lines for every non-present element, ready to drop into a
   *  provider-outreach document. */
  providerRequests: string[];
}

export interface ReferralCompletenessInput {
  patient: {
    firstName?: string | null;
    lastName?: string | null;
    dob?: string | null;
  };
  insurance?: { payerName?: string | null; memberId?: string | null } | null;
  diagnoses?: Array<{ icd10?: string | null }> | null;
  physician?: { name?: string | null; npi?: string | null } | null;
  documents?: Array<{ type: string }> | null;
  /** The PAP qualification verdict for the sleep study (assessPapQualification). */
  qualification: PapQualification;
}

const present = (v: string | null | undefined): boolean =>
  typeof v === "string" && v.trim().length > 0;

/**
 * Assess referral completeness and the provider requests needed to close the
 * gaps. Pure: shared by the review route, the report renderer, and the
 * provider-outreach builder so they never disagree on "what's missing."
 */
export function assessReferralCompleteness(
  input: ReferralCompletenessInput,
): ReferralCompleteness {
  const items: ReferralCompletenessItem[] = [];
  const docTypes = new Set((input.documents ?? []).map((d) => d.type));
  const hasDiagnosis = (input.diagnoses ?? []).some((d) => present(d?.icd10));

  // 1. Demographics — needed to build the chart.
  const hasName =
    present(input.patient.firstName) && present(input.patient.lastName);
  const hasDob = present(input.patient.dob);
  items.push(
    hasName && hasDob
      ? {
          key: "demographics",
          label: "Patient demographics",
          status: "present",
          detail: "Name and date of birth are on the referral.",
        }
      : {
          key: "demographics",
          label: "Patient demographics",
          status: "missing",
          detail: !hasName
            ? "The patient's full name is missing."
            : "The patient's date of birth is missing.",
          request:
            "Please provide the patient's full legal name and date of birth.",
        },
  );

  // 2. Insurance — needed to bill.
  const hasInsurance =
    present(input.insurance?.payerName) && present(input.insurance?.memberId);
  items.push(
    hasInsurance
      ? {
          key: "insurance",
          label: "Insurance",
          status: "present",
          detail: "Primary payer and member ID are on the referral.",
        }
      : {
          key: "insurance",
          label: "Insurance",
          status: "missing",
          detail: "No usable primary insurance (payer + member ID) was found.",
          request:
            "Please provide the patient's current insurance: payer name, member ID, and group number.",
        },
  );

  // 3. Diagnosis (ICD-10).
  items.push(
    hasDiagnosis
      ? {
          key: "diagnosis",
          label: "Diagnosis (ICD-10)",
          status: "present",
          detail: "At least one ICD-10 diagnosis code is on the referral.",
        }
      : {
          key: "diagnosis",
          label: "Diagnosis (ICD-10)",
          status: "missing",
          detail: "No ICD-10 diagnosis code was found.",
          request:
            "Please provide the ICD-10 diagnosis code(s) supporting the ordered therapy (e.g. G47.33 for obstructive sleep apnea).",
        },
  );

  // 4. Qualifying sleep study — driven by the qualification verdict.
  items.push(sleepStudyItem(input.qualification));

  // 5. Physician order / valid prescription (needs the prescriber NPI).
  const hasOrderSection = docTypes.has("physician_order");
  const hasNpi = present(input.physician?.npi);
  if (hasOrderSection && hasNpi) {
    items.push({
      key: "physician_order",
      label: "Physician order / prescription",
      status: "present",
      detail: "A physician order with a prescriber NPI is on the referral.",
    });
  } else if (hasOrderSection && !hasNpi) {
    items.push({
      key: "physician_order",
      label: "Physician order / prescription",
      status: "attention",
      detail:
        "An order is present but the prescriber NPI is missing — a valid DMEPOS order requires it.",
      request:
        "Please provide a signed order that includes the prescriber's NPI (a Standard Written Order with the required elements).",
    });
  } else {
    items.push({
      key: "physician_order",
      label: "Physician order / prescription",
      status: "missing",
      detail: "No physician order / prescription was found in the packet.",
      request:
        "Please provide a signed physician order (Standard Written Order) for the PAP device and supplies, including the prescriber's NPI and length of need.",
    });
  }

  // 6. Face-to-face / chart note.
  items.push(
    docTypes.has("chart_note")
      ? {
          key: "face_to_face",
          label: "Face-to-face / chart note",
          status: "present",
          detail:
            "A clinical note documenting the face-to-face is on the referral.",
        }
      : {
          key: "face_to_face",
          label: "Face-to-face / chart note",
          status: "attention",
          detail:
            "No face-to-face evaluation note was identified — Medicare requires one within 6 months for PAP.",
          request:
            "Please provide the chart note from the face-to-face evaluation documenting the sleep apnea signs/symptoms (within 6 months of the order).",
        },
  );

  const outstanding = items.filter((i) => i.status !== "present");
  return {
    items,
    outstandingCount: outstanding.length,
    complete: outstanding.length === 0,
    providerRequests: outstanding
      .map((i) => i.request)
      .filter((r): r is string => Boolean(r)),
  };
}

function sleepStudyItem(q: PapQualification): ReferralCompletenessItem {
  switch (q.verdict) {
    case "qualifies":
    case "qualifies_with_comorbidity":
      return {
        key: "sleep_study",
        label: "Qualifying sleep study",
        status: "present",
        detail: q.summary,
      };
    case "conditional":
      return {
        key: "sleep_study",
        label: "Qualifying sleep study",
        status: "attention",
        detail: q.summary,
        request:
          "The sleep study AHI/RDI is 5–14; please document a qualifying comorbidity (e.g. excessive daytime sleepiness, hypertension) to support coverage.",
      };
    case "not_qualifying":
      return {
        key: "sleep_study",
        label: "Qualifying sleep study",
        status: "attention",
        detail: q.summary,
        request:
          "The sleep study AHI/RDI is below the coverage threshold; please clarify the diagnosis and the indication for therapy.",
      };
    case "unknown":
    default:
      return {
        key: "sleep_study",
        label: "Qualifying sleep study",
        status: "missing",
        detail: q.summary,
        request:
          "Please provide the diagnostic sleep study (in-lab PSG or home sleep apnea test) with the AHI/RDI result.",
      };
  }
}
