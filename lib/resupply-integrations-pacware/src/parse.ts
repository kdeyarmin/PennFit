// Tolerant CSV import parser for PacWare reports.
//
// Pipeline: raw CSV text -> matrix (csv.ts) -> header mapping (reports.ts
// aliases) -> per-row Zod validation -> { valid records, per-row errors }.
//
// The schema is the SINGLE validation source: the API route re-validates
// every row with `pacwarePatientRowSchema` before it writes, so a caller
// that hand-builds JSON can never bypass the constraints the importer
// enforces.
//
// PHI: parsed rows ARE patient data. This module returns them to the
// caller; it never logs. Errors carry a row index + field name + reason —
// never the bad VALUE (a malformed DOB or phone is itself PHI).

import { z } from "zod";

import { normalizeHeader, parseCsv, stripCsvFormulaGuard } from "./csv";
import {
  buildHeaderFieldMap,
  getPacwareReportSpec,
  type PacwareReportKind,
} from "./reports";

const E164 = /^\+[1-9]\d{7,14}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validated patient-roster record (post-parse, pre-persist). */
export const pacwarePatientRowSchema = z
  .object({
    pacwareId: z.string().trim().min(1).max(64),
    legalFirstName: z.string().trim().min(1).max(80),
    legalLastName: z.string().trim().min(1).max(80),
    dateOfBirth: z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
    phoneE164: z
      .string()
      .trim()
      .regex(E164, "must be E.164 like +14155551212")
      .optional(),
    email: z.string().trim().email().max(254).optional(),
    addressLine1: z.string().trim().max(160).optional(),
    addressLine2: z.string().trim().max(160).optional(),
    city: z.string().trim().max(80).optional(),
    state: z.string().trim().max(40).optional(),
    postalCode: z.string().trim().max(20).optional(),
    country: z.string().trim().max(40).optional(),
    insurancePayer: z.string().trim().max(120).optional(),
  })
  .strict()
  // A partial address (street but no city) is more confusing than no
  // address at all — require the four core fields together or none.
  .superRefine((row, ctx) => {
    const hasAny = row.addressLine1 || row.city || row.state || row.postalCode;
    const hasAll = row.addressLine1 && row.city && row.state && row.postalCode;
    if (hasAny && !hasAll) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["address"],
        message:
          "Partial address. Provide all of address_line1, city, state, postal_code (or none).",
      });
    }
  });

export type PacwarePatientRow = z.infer<typeof pacwarePatientRowSchema>;

export interface PacwareRowError {
  /** 1-based index into the DATA rows (header excluded) for display. */
  rowIndex: number;
  field?: string;
  message: string;
}

export interface PacwareParseResult<T> {
  /** Rows that passed validation, in source order. */
  rows: T[];
  /** Per-row validation failures. */
  errors: PacwareRowError[];
  /** Count of data rows seen (valid + invalid), header excluded. */
  totalDataRows: number;
  /** Header labels that did not map to any known column (informational). */
  unmappedHeaders: string[];
  /**
   * Canonical fields that WERE present (mapped) in the header. Lets a
   * sync importer touch only the columns the report actually carried —
   * so a report that omits the phone column never blanks existing
   * phones. NOTE: a present-but-EMPTY cell is NOT "cleared" — empty
   * cells are dropped before validation, and the importer's
   * buildFillPatch is fill-only (it never overwrites or blanks an
   * existing value; see docs/integrations/pacware.md). An earlier
   * version of this comment described destructive cleared semantics
   * the code has never had — do not "fix" the code to match it.
   */
  presentFields: string[];
}

/**
 * Parse + validate a PacWare patient-roster CSV. Empty / blank rows are
 * skipped (Excel often leaves a trailing one). Unknown columns are
 * ignored but reported in `unmappedHeaders` so the operator can sanity-
 * check their report export.
 */
export function parsePacwarePatientCsv(
  csvText: string,
): PacwareParseResult<PacwarePatientRow> {
  return parseWithSchema("patient_roster", csvText, pacwarePatientRowSchema);
}

function parseWithSchema<T>(
  kind: PacwareReportKind,
  csvText: string,
  schema: z.ZodType<T>,
): PacwareParseResult<T> {
  const spec = getPacwareReportSpec(kind);
  const headerMap = buildHeaderFieldMap(spec);
  const matrix = parseCsv(csvText);
  const rows: T[] = [];
  const errors: PacwareRowError[] = [];

  if (matrix.length === 0) {
    return {
      rows,
      errors,
      totalDataRows: 0,
      unmappedHeaders: [],
      presentFields: [],
    };
  }

  const headerCells = matrix[0];
  // Map each column position to a canonical field (or null if unknown).
  const colFields: (string | null)[] = [];
  const unmappedHeaders: string[] = [];
  const presentSet = new Set<string>();
  for (const cell of headerCells) {
    const field = headerMap.get(normalizeHeader(cell)) ?? null;
    colFields.push(field);
    if (field === null && cell.trim() !== "") unmappedHeaders.push(cell.trim());
    if (field !== null) presentSet.add(field);
  }

  let dataRowIndex = 0;
  for (let r = 1; r < matrix.length; r++) {
    const cells = matrix[r];
    // Skip fully blank rows (trailing newline, spacer rows).
    if (cells.every((c) => (c ?? "").trim() === "")) continue;
    dataRowIndex += 1;

    const raw: Record<string, string> = {};
    for (let c = 0; c < colFields.length; c++) {
      const field = colFields[c];
      if (!field) continue;
      // Reverse the export-side spreadsheet-safety guard so a PennFit
      // export re-imports losslessly (e.g. "'+14155551212" -> "+1...").
      const value = stripCsvFormulaGuard((cells[c] ?? "").trim());
      // Only set non-empty values so `.optional()` fields stay absent
      // (an empty cell means "not provided", not "empty string").
      if (value !== "") raw[field] = value;
    }

    const parsed = schema.safeParse(raw);
    if (parsed.success) {
      rows.push(parsed.data);
    } else {
      const first = parsed.error.issues[0];
      errors.push({
        rowIndex: dataRowIndex,
        field: first?.path.length ? first.path.join(".") : undefined,
        message: first?.message ?? "invalid row",
      });
    }
  }

  return {
    rows,
    errors,
    totalDataRows: dataRowIndex,
    unmappedHeaders,
    presentFields: [...presentSet],
  };
}
