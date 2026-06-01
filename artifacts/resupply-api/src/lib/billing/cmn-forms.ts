// CMN / DIF form catalog + completeness validation (Biller #29).
//
// The structured layer dwo_documents doesn't have: each CMS form type
// declares the question set that must be answered before the CMN can be
// marked 'completed', and which HCPCS it covers (so the worklist can spot
// a CMN-requiring item that has no completed CMN). Pure data + pure
// functions — unit-tested directly, no I/O.
//
// Catalog is intentionally a curated subset of the historical CMS forms
// (CMS retired most CMN/DIF requirements 1/1/2023; some payers still ask
// for them). Add a form by adding an entry here — nothing else changes.

export interface CmnQuestion {
  key: string;
  label: string;
}

export interface CmnFormDef {
  formType: string;
  label: string;
  /** HCPCS codes this form documents medical necessity for. */
  hcpcsCodes: string[];
  /** Answer keys that must be present + non-empty to be 'completed'. */
  requiredKeys: string[];
  questions: CmnQuestion[];
}

export const CMN_FORMS: Record<string, CmnFormDef> = {
  cms_484: {
    formType: "cms_484",
    label: "CMS-484 — Oxygen",
    hcpcsCodes: ["E1390", "E1391", "E1392", "E0431", "E0433", "E0434", "E0439"],
    requiredKeys: [
      "arterial_po2_or_sat",
      "test_date",
      "test_condition",
      "oxygen_flow_rate_lpm",
    ],
    questions: [
      {
        key: "arterial_po2_or_sat",
        label: "Arterial PO2 (mmHg) or O2 saturation (%)",
      },
      { key: "test_date", label: "Date of qualifying test" },
      {
        key: "test_condition",
        label: "Test condition (rest / exercise / sleep)",
      },
      {
        key: "oxygen_flow_rate_lpm",
        label: "Prescribed oxygen flow rate (LPM)",
      },
      { key: "portable_oxygen", label: "Portable oxygen prescribed? (y/n)" },
    ],
  },
  cms_846: {
    formType: "cms_846",
    label: "CMS-846 — Pneumatic Compression Devices",
    hcpcsCodes: ["E0650", "E0651", "E0652", "E0655", "E0660", "E0667", "E0669"],
    requiredKeys: [
      "diagnosis",
      "conservative_therapy_tried",
      "conservative_therapy_duration",
    ],
    questions: [
      { key: "diagnosis", label: "Diagnosis (lymphedema / CVI)" },
      {
        key: "conservative_therapy_tried",
        label: "Conservative therapy tried? (y/n)",
      },
      {
        key: "conservative_therapy_duration",
        label: "Duration of conservative therapy",
      },
    ],
  },
  cms_848: {
    formType: "cms_848",
    label: "CMS-848 — TENS",
    hcpcsCodes: ["E0720", "E0730"],
    requiredKeys: [
      "pain_location",
      "pain_duration_months",
      "other_treatments_tried",
    ],
    questions: [
      { key: "pain_location", label: "Location of chronic pain" },
      { key: "pain_duration_months", label: "Duration of pain (months)" },
      { key: "other_treatments_tried", label: "Other treatments tried" },
    ],
  },
  dif_10125: {
    formType: "dif_10125",
    label: "DIF 10125 — External Infusion Pump",
    hcpcsCodes: ["E0779", "E0780", "E0781", "E0791"],
    requiredKeys: ["drug", "diagnosis", "administration_route"],
    questions: [
      { key: "drug", label: "Drug being infused" },
      { key: "diagnosis", label: "Diagnosis" },
      { key: "administration_route", label: "Route of administration" },
    ],
  },
  dif_10126: {
    formType: "dif_10126",
    label: "DIF 10126 — Enteral / Parenteral Nutrition",
    hcpcsCodes: ["B4034", "B4035", "B4036", "B9002", "B4081", "B4082"],
    requiredKeys: ["route", "caloric_intake_per_day", "diagnosis"],
    questions: [
      { key: "route", label: "Route (enteral / parenteral)" },
      { key: "caloric_intake_per_day", label: "Daily caloric intake" },
      { key: "diagnosis", label: "Diagnosis / permanence" },
    ],
  },
};

export const CMN_FORM_TYPES = Object.keys(CMN_FORMS);

export function isCmnFormType(v: unknown): v is string {
  return typeof v === "string" && v in CMN_FORMS;
}

export interface CmnValidation {
  ready: boolean;
  missing: string[];
  unknownForm: boolean;
}

function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  return false;
}

/**
 * Pure: is this CMN's answer set complete for its form type? Returns the
 * missing required keys so the UI can point the biller at the gaps.
 */
export function validateCmnAnswers(
  formType: string,
  answers: Record<string, unknown> | null | undefined,
): CmnValidation {
  const def = CMN_FORMS[formType];
  if (!def) return { ready: false, missing: [], unknownForm: true };
  const a = answers ?? {};
  const missing = def.requiredKeys.filter((k) => !isAnswered(a[k]));
  return { ready: missing.length === 0, missing, unknownForm: false };
}

/**
 * Pure: the first form type whose catalog covers this HCPCS, or null.
 * Used to flag claims with a CMN-requiring item that lacks a CMN.
 */
export function formTypeForHcpcs(hcpcs: string): string | null {
  const code = hcpcs.trim().toUpperCase();
  for (const def of Object.values(CMN_FORMS)) {
    if (def.hcpcsCodes.includes(code)) return def.formType;
  }
  return null;
}

/** Pure: does any catalog form cover this HCPCS? */
export function hcpcsRequiresCmn(hcpcs: string): boolean {
  return formTypeForHcpcs(hcpcs) !== null;
}
