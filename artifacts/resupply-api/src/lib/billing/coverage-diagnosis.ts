// Pure LCD medical-necessity (HCPCS ↔ diagnosis) evaluation.
//
// Claim preflight already checks a diagnosis is *present*; this decides
// whether that diagnosis actually *supports* a billed HCPCS under the
// seeded coverage policy (resupply.hcpcs_coverage_diagnoses, migration
// 0408). A PAP claim whose diagnosis isn't a covered indication denies for
// medical necessity — this is the deterministic edit that surfaces it
// before submit.
//
// No I/O — the caller fetches the catalog rows; this module normalises and
// matches. Unit-tested directly.

export interface CoverageDiagnosisRow {
  hcpcs_code: string;
  icd10_code: string;
  policy?: string | null;
  /** Tenant payer this row overrides coverage for. NULL/undefined = the
   *  national (Medicare LCD) default. A payer's own rows, when present for a
   *  HCPCS, REPLACE the national default for that HCPCS (per migration 0415). */
  payer_profile_id?: string | null;
}

export interface CoverageEvaluation {
  /** True iff the catalog has at least one rule for this HCPCS. When false
   *  the caller renders NO opinion — a HCPCS we haven't catalogued must
   *  never produce a false-positive medical-necessity flag. */
  hasRules: boolean;
  /** True iff a claim diagnosis supports the HCPCS. Meaningful only when
   *  `hasRules` is true. */
  covered: boolean;
  /** Distinct policies cited by this HCPCS's rules (e.g. "LCD L33718"),
   *  for the CSR-facing message. */
  policies: string[];
}

/** Uppercase and strip everything but A-Z/0-9, so "G47.33" → "G4733".
 *  Both the catalog codes and the claim diagnosis are normalised this way
 *  before comparison, so dotted/undotted and case differences never cause
 *  a spurious mismatch. */
export function normalizeIcd10(code: string | null | undefined): string {
  if (!code) return "";
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Decide whether any of the claim's diagnosis codes supports `hcpcsCode`
 * under the supplied coverage catalog rows.
 *
 * Matching is prefix-based on the normalised (dotless, uppercase) codes: a
 * claim diagnosis supports the HCPCS when it is at least as specific as a
 * covered code — `claimDx.startsWith(coveredCode)`. So covered "G4733"
 * matches claim "G4733", and a covered category "G473" matches "G4733" /
 * "G4730", but a covered "G4733" does NOT match a less-specific "G473".
 *
 * **Per-payer override:** when `payerProfileId` is given and that payer has
 * ANY rows for the HCPCS, the payer's set is authoritative and REPLACES the
 * national default for that HCPCS (commercial/MA plans cover differently than
 * the Medicare LCD). Otherwise the national rows (`payer_profile_id` null)
 * apply. Pass `coverage` as the union of national + this-payer rows.
 */
export function evaluateCoverageDiagnosis(
  hcpcsCode: string,
  diagnosisCodes: readonly (string | null | undefined)[],
  coverage: readonly CoverageDiagnosisRow[],
  payerProfileId?: string | null,
): CoverageEvaluation {
  const hcpcs = (hcpcsCode ?? "").trim().toUpperCase();
  const forHcpcs = coverage.filter(
    (r) => (r.hcpcs_code ?? "").trim().toUpperCase() === hcpcs,
  );
  // Payer-specific rows win when present; else fall back to national rows.
  const payerRows = payerProfileId
    ? forHcpcs.filter((r) => r.payer_profile_id === payerProfileId)
    : [];
  const rules =
    payerRows.length > 0
      ? payerRows
      : forHcpcs.filter((r) => r.payer_profile_id == null);
  if (rules.length === 0) {
    return { hasRules: false, covered: false, policies: [] };
  }
  const dx = diagnosisCodes
    .map((d) => normalizeIcd10(d))
    .filter((d) => d.length > 0);
  const covered = rules.some((r) => {
    const cov = normalizeIcd10(r.icd10_code);
    return cov.length > 0 && dx.some((d) => d.startsWith(cov));
  });
  const policies = [
    ...new Set(
      rules.map((r) => (r.policy ?? "").trim()).filter((p) => p.length > 0),
    ),
  ];
  return { hasRules: true, covered, policies };
}
