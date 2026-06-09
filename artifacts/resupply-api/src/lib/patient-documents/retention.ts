// Per-document-type retention horizons.
//
// HIPAA Privacy Rule §164.530(j)(2) sets a 6-year floor for
// documents that pertain to "policies and procedures" and certain
// patient-communication records, measured from the date of
// CREATION or the date when the record last was in effect — we use
// creation date because all of these are point-in-time artifacts.
//
// Some categories carry longer state-level retention:
//   * Prescriptions — DEA + state pharmacy boards routinely set
//     7+ years for controlled substances and 5+ for others. We
//     pick 7 years to cover both worst cases.
//   * Sleep studies / diagnostic reports — payer audit windows
//     (Medicare PAR audits) can reach back 10 years for fraud
//     reviews. 10 years is the safer floor.
//   * Insurance cards — IDs change frequently; the actual card
//     image is rarely useful past the policy period. We hold 2
//     years (long enough to cover the typical state SOL on
//     billing disputes).
//   * Referrals — 6 years matches HIPAA's floor.
//   * Other / unknown — default to the 6-year HIPAA minimum.
//
// We DO NOT pretend any of these are legal advice. Counsel
// should sign off on the horizons before flipping the sweep on
// in prod; this catalog is the "reasonable default" surveyors
// expect us to be applying.

export type DocumentRetentionYears = 2 | 6 | 7 | 10;

const RETENTION_YEARS_BY_TYPE: Record<string, DocumentRetentionYears> = {
  insurance_card: 2,
  prescription: 7,
  // Signed delivery tickets / CMNs are DMEPOS billing-support records;
  // CMS supplier-standard retention is 7 years from the claim.
  signed_delivery_ticket: 7,
  cmn: 7,
  sleep_study: 10,
  diagnostic_report: 10,
  // Compliance / adherence documentation rides the same 10-year payer
  // audit window as diagnostic reports.
  compliance_report: 10,
  // Patient billing statements are DMEPOS billing-support records — hold
  // the CMS 7-year supplier-standard window from creation.
  billing_statement: 7,
  referral: 6,
  other: 6,
};

/** Look up the years-of-retention floor for a document_type
 *  string. Unknown types default to 6 (the HIPAA floor). */
export function retentionYearsForDocumentType(
  documentType: string,
): DocumentRetentionYears {
  return RETENTION_YEARS_BY_TYPE[documentType] ?? 6;
}

/** Compute the absolute retention-until timestamp from a creation
 *  date and the document type. Pure; no `new Date()` side effects
 *  so tests can pin behavior with a synthetic date. */
export function computeRetentionUntilAt(input: {
  createdAt: Date;
  documentType: string;
}): Date {
  const years = retentionYearsForDocumentType(input.documentType);
  const until = new Date(input.createdAt);
  until.setUTCFullYear(until.getUTCFullYear() + years);
  return until;
}

/** Bucket a row's retention state for the admin UI. */
export type RetentionBucket =
  | "active" // retention_until_at is in the future or null
  | "due_soon" // within 30 days of retention_until_at
  | "due_now" // past retention_until_at
  | "marked" // retention_marked_at set; awaiting destruction
  | "destroyed" // destroyed_at set
  | "legal_hold"; // legal_hold=true overrides everything else

export function bucketRetention(input: {
  retentionUntilAt: string | null;
  retentionMarkedAt: string | null;
  destroyedAt: string | null;
  legalHold: boolean;
  asOfDate: Date;
}): RetentionBucket {
  if (input.destroyedAt != null) return "destroyed";
  if (input.legalHold) return "legal_hold";
  if (input.retentionMarkedAt != null) return "marked";
  if (input.retentionUntilAt == null) return "active";
  const until = new Date(input.retentionUntilAt).getTime();
  const now = input.asOfDate.getTime();
  if (until <= now) return "due_now";
  if (until - now <= 30 * 86_400_000) return "due_soon";
  return "active";
}
