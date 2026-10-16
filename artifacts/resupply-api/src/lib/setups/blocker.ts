// Pure stage/blocker for one new CPAP setup.
//
// The board does not store a stage. Every read classifies the live
// chart, fit, order, and first-night checklist, in this order, and
// stops at the first thing a person has to do. A row is not done at
// signature: "fulfilled" on a fit request means the patient has the
// mask, and this classifier only reaches "ready" once the machine
// has shipped and the first-night checklist is done.

export const FIRST_NIGHT_STEP_KEYS = [
  "mask_fit_seal",
  "humidifier",
  "ramp",
  "cleaning",
  "data_app",
  "followup_scheduled",
] as const;

export const REQUIRED_PAPERWORK = [
  "hipaa_npp",
  "aob",
  "supplier_standards",
] as const;

export type SetupStage =
  | "coverage"
  | "docs"
  | "fit"
  | "order"
  | "auth"
  | "release"
  | "setup"
  | "ready";

export interface SetupSignals {
  hasCoverage: boolean;
  eligibility: "none" | "pending" | "active" | "inactive";
  medicare: boolean;
  /** Latest E0601 same-or-similar record. `inactive` is treated as clear. */
  sameOrSimilar: "missing" | "clear" | "active" | "unknown" | "inactive";
  missingForms: string[];
  hasMaskChoice: boolean;
  openFitRequest: boolean;
  order:
    | "none"
    | "awaiting_signature"
    | "signed_needs_followup"
    | "queued"
    | "shipped";
  priorAuth:
    | "not_required"
    | "missing"
    | "draft"
    | "submitted"
    | "approved"
    | "denied";
  checklistComplete: boolean;
}

export interface SetupClassification {
  stage: SetupStage;
  blocker: string | null;
  href: string;
}

const FORM_LABEL: Record<string, string> = {
  hipaa_npp: "Notice of privacy practices",
  aob: "Assignment of benefits",
  supplier_standards: "Supplier standards",
};

export function classifySetup(
  signals: SetupSignals,
  patientId: string,
): SetupClassification {
  const chart = (tab: string) =>
    `/admin/patients/${encodeURIComponent(patientId)}?tab=${tab}`;

  if (!signals.hasCoverage) {
    return {
      stage: "coverage",
      blocker: "Verify insurance",
      href: chart("insurance"),
    };
  }

  if (signals.eligibility === "none") {
    return {
      stage: "coverage",
      blocker: "Run eligibility for E0601",
      href: chart("insurance"),
    };
  }
  if (signals.eligibility === "inactive") {
    return {
      stage: "coverage",
      blocker: "Eligibility came back inactive",
      href: chart("insurance"),
    };
  }
  if (signals.eligibility === "pending") {
    return {
      stage: "coverage",
      blocker: "Eligibility is in flight",
      href: chart("insurance"),
    };
  }

  const sameOrSimilarBlocks =
    signals.medicare &&
    signals.order !== "shipped" &&
    signals.sameOrSimilar !== "clear" &&
    signals.sameOrSimilar !== "inactive";
  if (sameOrSimilarBlocks) {
    return {
      stage: "docs",
      blocker:
        signals.sameOrSimilar === "active"
          ? "Same-or-similar is active. Do not promise a machine until it clears."
          : "Record Medicare same-or-similar for E0601",
      href: chart("setup"),
    };
  }

  if (signals.missingForms.length > 0) {
    const labels = signals.missingForms.map((key) => FORM_LABEL[key] ?? key);
    return {
      stage: "docs",
      blocker: `Paperwork still open: ${labels.join(", ")}`,
      href: chart("packets"),
    };
  }

  if (!signals.hasMaskChoice && signals.openFitRequest) {
    return {
      stage: "fit",
      blocker: "Fit request is waiting. The patient has not chosen a mask.",
      href: "/admin/fitter-requests",
    };
  }
  if (!signals.hasMaskChoice && signals.order === "none") {
    return {
      stage: "fit",
      blocker: "No mask yet. Send the fitter link.",
      href: "/admin/fitter-invites",
    };
  }

  if (signals.order === "none") {
    return {
      stage: "order",
      blocker: "Build the signature order",
      href: "/admin/fitter/orders?kit=new-cpap",
    };
  }
  if (signals.order === "awaiting_signature") {
    return {
      stage: "order",
      blocker: "Waiting on the patient's signature",
      href: "/admin/fitter/orders",
    };
  }
  if (signals.order === "signed_needs_followup") {
    return {
      stage: "order",
      blocker:
        "Signed, and no fulfillment queued. Check the patient, the catalog SKU, the prescription, and the address.",
      href: "/admin/fitter/orders",
    };
  }

  const authRequired = signals.priorAuth !== "not_required";
  if (authRequired && signals.priorAuth === "missing") {
    return {
      stage: "auth",
      blocker: "Draft the E0601 prior auth for a person to send",
      href: chart("prior-auths"),
    };
  }
  if (authRequired && signals.priorAuth === "draft") {
    return {
      stage: "auth",
      blocker: "E0601 prior auth is a draft. A person still has to send it.",
      href: chart("prior-auths"),
    };
  }
  if (authRequired && signals.priorAuth === "denied") {
    return {
      stage: "auth",
      blocker: "E0601 prior auth was denied",
      href: chart("prior-auths"),
    };
  }
  if (authRequired && signals.priorAuth === "submitted") {
    return {
      stage: "auth",
      blocker: "E0601 prior auth is with the payer",
      href: chart("prior-auths"),
    };
  }

  if (signals.order === "queued") {
    return {
      stage: "release",
      blocker: "Fulfillment is queued. Sync it to PacWare.",
      href: "/admin/pacware",
    };
  }

  if (signals.order === "shipped" && !signals.checklistComplete) {
    return {
      stage: "setup",
      blocker: "Machine shipped. Finish the first-night checklist.",
      href: chart("setup"),
    };
  }

  return {
    stage: "ready",
    blocker: null,
    href: chart("setup"),
  };
}
