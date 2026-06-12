// Versioned catalog of patient-intake forms. Bumping the `version`
// here invalidates prior acknowledgements at the application layer
// — every patient sees a "please review and re-sign" banner when
// the most recent acknowledgement on file is for an older version.

export type FormKind =
  | "hipaa_npp"
  | "aob"
  | "abn"
  | "financial_responsibility"
  | "supplier_standards";

export interface FormDescriptor {
  kind: FormKind;
  version: string;
  title: string;
  body: string;
}

export const INTAKE_FORMS: Record<FormKind, FormDescriptor> = {
  hipaa_npp: {
    kind: "hipaa_npp",
    version: "2026.06",
    title: "Notice of Privacy Practices",
    body:
      "Penn Home Medical Supply protects your health information per HIPAA. We may " +
      "use your information for treatment, payment, and healthcare " +
      "operations. You have the right to request, amend, and " +
      "restrict access to your records.",
  },
  aob: {
    kind: "aob",
    version: "2026.06",
    title: "Assignment of Benefits",
    body:
      "By signing, you authorize Penn Home Medical Supply to bill your insurance " +
      "carrier directly for covered services, and you assign payment " +
      "of benefits to Penn Home Medical Supply.",
  },
  abn: {
    kind: "abn",
    version: "2024.01",
    title: "Advance Beneficiary Notice",
    body:
      "Medicare may not pay for items it determines are not " +
      "reasonable and necessary. You may be responsible for payment " +
      "if Medicare denies the claim.",
  },
  financial_responsibility: {
    kind: "financial_responsibility",
    version: "2026.06",
    title: "Financial Responsibility",
    body:
      "You are responsible for any deductible, copayment, or " +
      "non-covered charges. Penn Home Medical Supply will provide an estimate " +
      "before service whenever possible.",
  },
  supplier_standards: {
    kind: "supplier_standards",
    version: "2026.06",
    title: "DMEPOS Supplier Standards",
    body:
      "Penn Home Medical Supply is a Medicare-enrolled DMEPOS supplier and adheres " +
      "to the 30 supplier standards published by CMS. A copy is " +
      "available on request.",
  },
};

export function getFormCurrentVersion(kind: FormKind): string {
  return INTAKE_FORMS[kind].version;
}
