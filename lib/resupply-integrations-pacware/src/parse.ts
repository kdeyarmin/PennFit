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
  const headerCells = matrix[0] ?? [];
  // Map each column position to a canonical field (or null if unknown),
  // using the report's built-in header aliases.
  const colFields = headerCells.map(
    (cell) => headerMap.get(normalizeHeader(cell)) ?? null,
  );
  return buildParseResult(matrix, colFields, schema, false);
}

/**
 * Shared row engine. Given the parsed CSV matrix and a per-column
 * canonical-field assignment (`colFields[i]` = field for source column i, or
 * null to ignore it), build the validated result. When `normalizeValues` is
 * set, tolerant date/phone normalization runs before validation so a roster
 * exported from any system (MM/DD/YYYY dates, (415) 555-1212 phones) can be
 * coerced into the canonical shapes the schema requires.
 */
function buildParseResult<T>(
  matrix: string[][],
  colFields: (string | null)[],
  schema: z.ZodType<T>,
  normalizeValues: boolean,
): PacwareParseResult<T> {
  const rows: T[] = [];
  const errors: PacwareRowError[] = [];
  const headerCells = matrix[0] ?? [];
  const unmappedHeaders: string[] = [];
  const presentSet = new Set<string>();
  for (let c = 0; c < headerCells.length; c++) {
    const field = colFields[c] ?? null;
    const cell = headerCells[c] ?? "";
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
      // Reverse the export-side spreadsheet-safety guard so a CareMetric Breathe
      // export re-imports losslessly (e.g. "'+14155551212" -> "+1...").
      let value = stripCsvFormulaGuard((cells[c] ?? "").trim());
      if (value !== "" && normalizeValues) {
        // Coerce common foreign formats into the canonical shape. If a value
        // can't be coerced, keep it as-is so the schema raises a precise,
        // PHI-free validation error rather than silently dropping the row.
        if (field === "dateOfBirth") value = normalizeDateToIso(value) ?? value;
        else if (field === "phoneE164")
          value = normalizePhoneToE164(value) ?? value;
      }
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
        field: first?.path?.length ? first.path.join(".") : undefined,
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

// ---------------------------------------------------------------------------
// Flexible (any-CSV) patient import.
//
// PacWare exports re-import via `parsePacwarePatientCsv` (header aliases). A
// roster exported from any OTHER system imports via an operator-supplied
// column mapping (canonical field -> that file's header label), with tolerant
// date/phone coercion — so "any system that can export a CSV" really works,
// not just PacWare's exact layout. The SAME `pacwarePatientRowSchema` still
// gates every row, so required fields and formats are never bypassed.
// ---------------------------------------------------------------------------

/** Operator-supplied mapping: canonical field -> the source CSV header label. */
export type PatientColumnMapping = Partial<
  Record<keyof PacwarePatientRow, string>
>;

const VALID_PATIENT_FIELDS = new Set<string>(
  getPacwareReportSpec("patient_roster").columns.map((c) => c.field),
);

/**
 * Parse + validate an arbitrary patient CSV using an explicit column mapping.
 * Mapping entries that name an unknown field are ignored (so a stray key can
 * never inject a column the strict schema would then reject). Returns the same
 * shape as `parsePacwarePatientCsv`, so the import route treats both paths
 * identically (preview + fill-only sync).
 */
export function parsePatientCsvWithMapping(
  csvText: string,
  mapping: PatientColumnMapping,
): PacwareParseResult<PacwarePatientRow> {
  const matrix = parseCsv(csvText);
  const headerCells = matrix[0] ?? [];
  // Invert the mapping to normalizedSourceHeader -> field.
  const headerToField = new Map<string, string>();
  for (const [field, header] of Object.entries(mapping)) {
    if (!VALID_PATIENT_FIELDS.has(field)) continue;
    if (typeof header === "string" && header.trim() !== "") {
      headerToField.set(normalizeHeader(header), field);
    }
  }
  const colFields = headerCells.map(
    (cell) => headerToField.get(normalizeHeader(cell)) ?? null,
  );
  return buildParseResult(matrix, colFields, pacwarePatientRowSchema, true);
}

export interface PatientImportFieldInfo {
  field: string;
  /** Canonical header CareMetric Breathe emits/expects. */
  header: string;
  required: boolean;
  description: string;
}

/** The catalog of mappable patient fields, for the import UI's column picker. */
export function patientImportFields(): PatientImportFieldInfo[] {
  return getPacwareReportSpec("patient_roster").columns.map((c) => ({
    field: c.field,
    header: c.header,
    required: c.required,
    description: c.description,
  }));
}

export interface PatientCsvHeaderPreview {
  /** The source file's header labels (first row), blanks dropped. */
  headers: string[];
  /** Auto-detected field -> source-header guesses (from the alias table). */
  suggestedMapping: Record<string, string>;
  /** Field catalog so the UI can render required/optional + descriptions. */
  fields: PatientImportFieldInfo[];
}

/**
 * Read just the header row of an uploaded CSV and propose a column mapping by
 * matching each header against the known aliases. Returns NO data rows — only
 * column labels — so it never echoes PHI. The operator confirms/adjusts the
 * guesses, then commits with the resulting mapping.
 */
export function previewPatientCsvHeaders(
  csvText: string,
): PatientCsvHeaderPreview {
  const matrix = parseCsv(csvText);
  const headerCells = (matrix[0] ?? [])
    .map((h) => h.trim())
    .filter((h) => h !== "");
  const headerMap = buildHeaderFieldMap(getPacwareReportSpec("patient_roster"));
  const suggestedMapping: Record<string, string> = {};
  for (const cell of headerCells) {
    const field = headerMap.get(normalizeHeader(cell));
    // First header that matches a field wins the suggestion.
    if (field && !(field in suggestedMapping)) suggestedMapping[field] = cell;
  }
  return {
    headers: headerCells,
    suggestedMapping,
    fields: patientImportFields(),
  };
}

/**
 * Coerce a human date to ISO `YYYY-MM-DD`, or null if unrecognized. Accepts
 * ISO, M/D/Y and Y/M/D with `/`, `-`, or `.` separators, and 2-digit years
 * (pivot at 70 -> 19xx, else 20xx). Validates the calendar date so 02/31 or
 * 13/05 are rejected rather than silently rolled over.
 */
export function normalizeDateToIso(input: string): string | null {
  const s = input.trim();
  if (ISO_DATE.test(s)) return isRealDate(s) ? s : null;

  const mdy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (mdy) {
    const month = Number(mdy[1]);
    const day = Number(mdy[2]);
    const year = expandYear(mdy[3]);
    return assembleIso(year, month, day);
  }
  const ymd = s.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
  if (ymd) {
    return assembleIso(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  }
  return null;
}

function expandYear(yy: string): number {
  const n = Number(yy);
  if (yy.length <= 2) return n >= 70 ? 1900 + n : 2000 + n;
  return n;
}

function assembleIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isRealDate(iso) ? iso : null;
}

function isRealDate(iso: string): boolean {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * Coerce a phone to E.164, or null if it can't be. Accepts already-E.164,
 * 10-digit US numbers (-> +1…), 11-digit leading-1 US numbers, and
 * +country numbers written with separators. Anything else returns null so the
 * schema flags it.
 */
export function normalizePhoneToE164(input: string): string | null {
  const s = input.trim();
  if (E164.test(s)) return s;
  if (s.startsWith("+")) {
    const d = s.slice(1).replace(/\D/g, "");
    return d.length >= 8 && d.length <= 15 && d[0] !== "0" ? `+${d}` : null;
  }
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10 && digits[0] !== "0") return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
