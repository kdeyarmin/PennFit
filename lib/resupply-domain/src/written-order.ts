// Standard / Detailed Written Order completeness rule — pure validation
// (ADR 008: no I/O, no pdfkit, no Date.now()).
//
// What this is
// ------------
// Since the 2020 CMS "Standardization of Documentation Requirements" rule,
// ONE consolidated written order (the SWO) replaces the legacy DWO + CMN
// forms for most DMEPOS items, including CPAP. Before the supplier can
// render or fax that order it must carry the fields CMS mandates ON the
// form itself:
//
//   1. Beneficiary legal name (first + last)
//   2. Beneficiary date of birth
//   3. The relevant HCPCS code for the item ordered
//   4. Treating practitioner legal name
//   5. Treating practitioner NPI — a 10-digit National Provider Identifier
//
// (Quantity, the order date, and the practitioner signature line are
// supplied by the renderer; the diagnosis / sleep-study findings are
// required in the supplier RECORD but not on the form, so they are not
// gated here.)
//
// Why it lives in @workspace/resupply-domain
// -------------------------------------------
// This is the single "is the order complete?" rule. The PDF renderer
// (artifacts/.../swo-pdf.ts) calls it to turn a non-empty result into a
// 422 with the issue list — the CSR sees "fill in the HCPCS code and link
// a provider" instead of a confusing 500 from the PDF library. Pulling the
// rule into the pure domain layer lets the SPA pre-flight the same fields
// before it ever asks the server to render, with ZERO chance of the two
// copies drifting. No pdfkit, no DB row types — only the handful of fields
// the rule actually reads.

/**
 * The minimal slice of SWO inputs the completeness rule inspects. This is
 * a LOCAL interface (not the full pdfkit `SwoInputs`) so the domain package
 * never has to import the renderer's layout types or any DB row shape — it
 * structurally accepts the larger renderer input as well.
 */
export interface SwoInputs {
  patient: {
    legalFirstName: string;
    legalLastName: string;
    dateOfBirth: string;
  };
  prescription: {
    hcpcsCode: string | null;
  };
  provider: {
    legalName: string;
    npi: string;
  };
}

export interface SwoValidationError {
  field: string;
  message: string;
}

/** A 10-digit NPI — exactly ten ASCII digits, nothing else. */
const NPI_PATTERN = /^\d{10}$/;

/**
 * Validate that the inputs carry the fields CMS requires on the
 * standardized written order. Returns an array of missing-field errors;
 * an EMPTY array means the order is complete and can be rendered.
 *
 * Defensive: the optional-chaining + nullish coalescing guards treat a
 * missing `patient` / `prescription` / `provider` sub-object (or any of
 * their string fields being undefined) exactly like an empty value — a
 * malformed input reports the same structured missing-field error rather
 * than throwing.
 */
export function validateSwoCompleteness(
  inputs: SwoInputs,
): SwoValidationError[] {
  const errors: SwoValidationError[] = [];

  const firstName = inputs.patient?.legalFirstName ?? "";
  const lastName = inputs.patient?.legalLastName ?? "";
  if (!firstName || !lastName) {
    errors.push({
      field: "patient",
      message: "Patient legal name is required.",
    });
  }

  if (!inputs.patient?.dateOfBirth) {
    errors.push({
      field: "patient.dateOfBirth",
      message: "Patient date of birth is required.",
    });
  }

  if (!inputs.prescription?.hcpcsCode) {
    errors.push({
      field: "prescription.hcpcsCode",
      message:
        "HCPCS code is required on the prescription before an SWO can be generated.",
    });
  }

  const npi = inputs.provider?.npi ?? "";
  if (!npi || !NPI_PATTERN.test(npi)) {
    errors.push({
      field: "provider.npi",
      message:
        "A provider with a 10-digit NPI must be linked to the prescription.",
    });
  }

  if (!inputs.provider?.legalName) {
    errors.push({
      field: "provider.legalName",
      message: "Provider legal name is required.",
    });
  }

  return errors;
}

/**
 * Boolean convenience over {@link validateSwoCompleteness}: true when the
 * order carries every CMS-mandated field. Lets the SPA gate a "Generate
 * SWO" button without inspecting the error list.
 */
export function isSwoComplete(inputs: SwoInputs): boolean {
  return validateSwoCompleteness(inputs).length === 0;
}
