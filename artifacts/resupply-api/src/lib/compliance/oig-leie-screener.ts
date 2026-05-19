// OIG LEIE (List of Excluded Individuals and Entities) screening
// helpers.
//
// Background
// ----------
// OIG SAB 2013 requires Medicare/Medicaid suppliers to screen every
// employee, contractor, vendor, and ordering provider against the
// LEIE BEFORE engagement and MONTHLY thereafter. The full LEIE file
// is published monthly at https://oig.hhs.gov/exclusions/exclusions_list.asp
// as a downloadable CSV.
//
// Posture in this module:
//   * `screenSubject({ npi?, lastname, firstname?, asOf })` — pure
//     lookup against the cached `resupply.oig_leie_exclusions` rows.
//     Returns the matched exclusion row when a hit, otherwise null.
//   * `recordScreening({...})` — append-only insert into
//     `resupply.oig_leie_screenings` so we can prove "we checked, the
//     list said no hit, on this date" even after the LEIE row turns
//     over next month.
//   * `parseLeieCsvLine` — pure CSV row → exclusion-row parser used
//     by the monthly sync worker.
//
// PHI containment: the LEIE is a public file; no PHI. Subject identity
// supplied to `screenSubject` is staff/provider identity, not patient.

import {
  type Database,
  getSupabaseServiceRoleClient,
  type OigLeieResult,
  type OigLeieSubjectKind,
} from "@workspace/resupply-db";

import { logger } from "../logger";

type LeieRow = Database["resupply"]["Tables"]["oig_leie_exclusions"]["Row"];
type ScreeningInsert =
  Database["resupply"]["Tables"]["oig_leie_screenings"]["Insert"];

export interface ScreenSubjectInput {
  /** 10-digit NPI when known — the most reliable match key. */
  npi?: string | null;
  lastname: string;
  firstname?: string | null;
}

export interface ScreenSubjectResult {
  match: LeieRow | null;
  /** Confidence reason for the match (or absence). */
  reason:
    | "npi_match"
    | "name_match"
    | "no_npi_no_name_match"
    | "no_match";
}

/** Pure DB lookup. Caller is responsible for recording the screening
 *  attempt via `recordScreening`. NPI is checked first because LEIE
 *  reinstatements (reinstate_date IS NOT NULL AND <= today) are
 *  considered no longer excluded. */
export async function screenSubject(
  input: ScreenSubjectInput,
): Promise<ScreenSubjectResult> {
  const supabase = getSupabaseServiceRoleClient();
  const today = new Date().toISOString().slice(0, 10);
  const npi = (input.npi ?? "").trim();
  if (npi) {
    const { data, error } = await supabase
      .schema("resupply")
      .from("oig_leie_exclusions")
      .select("*")
      .eq("npi", npi)
      .or(`reinstate_date.is.null,reinstate_date.gt.${today}`)
      .limit(1);
    if (error) {
      logger.warn({ err: error.message }, "oig.leie.npi_lookup failed");
      throw error;
    }
    if (data && data[0]) {
      return { match: data[0] as LeieRow, reason: "npi_match" };
    }
  }
  const last = input.lastname.trim();
  const first = (input.firstname ?? "").trim();
  if (!last) return { match: null, reason: "no_match" };
  let query = supabase
    .schema("resupply")
    .from("oig_leie_exclusions")
    .select("*")
    .ilike("lastname", last)
    .or(`reinstate_date.is.null,reinstate_date.gt.${today}`)
    .limit(5);
  if (first) query = query.ilike("firstname", first);
  const { data, error } = await query;
  if (error) {
    logger.warn({ err: error.message }, "oig.leie.name_lookup failed");
    throw error;
  }
  if (data && data[0]) {
    return { match: data[0] as LeieRow, reason: "name_match" };
  }
  return {
    match: null,
    reason: npi ? "no_npi_no_name_match" : "no_match",
  };
}

export interface RecordScreeningInput {
  subjectKind: OigLeieSubjectKind;
  subjectLabel: string;
  subjectAdminUserId?: string | null;
  subjectProviderId?: string | null;
  subjectBaaId?: string | null;
  subjectNpi?: string | null;
  result: OigLeieResult;
  matchedExclusionId?: string | null;
  dispositionNote?: string | null;
  screenedByEmail: string;
}

export async function recordScreening(
  input: RecordScreeningInput,
): Promise<{ id: string }> {
  const supabase = getSupabaseServiceRoleClient();
  const row: ScreeningInsert = {
    subject_kind: input.subjectKind,
    subject_label: input.subjectLabel,
    subject_admin_user_id: input.subjectAdminUserId ?? null,
    subject_provider_id: input.subjectProviderId ?? null,
    subject_baa_id: input.subjectBaaId ?? null,
    subject_npi: input.subjectNpi ?? null,
    result: input.result,
    matched_exclusion_id: input.matchedExclusionId ?? null,
    disposition_note: input.dispositionNote ?? null,
    screened_by_email: input.screenedByEmail,
  };
  const { data, error } = await supabase
    .schema("resupply")
    .from("oig_leie_screenings")
    .insert(row)
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id };
}

// ── LEIE CSV parsing ────────────────────────────────────────────────

/** OIG publishes LEIE CSV with these columns (in order):
 *  LASTNAME, FIRSTNAME, MIDNAME, BUSNAME, GENERAL, SPECIALTY, UPIN,
 *  NPI, DOB, ADDRESS, CITY, STATE, ZIP, EXCLTYPE, EXCLDATE, REINDATE,
 *  WAIVERDATE, WVRSTATE. We project the columns we care about.
 *
 *  The CSV format has been stable since 2011; if OIG changes it we
 *  fail-soft (return null for the row) and the sync job logs at warn. */
export const LEIE_CSV_EXPECTED_HEADER = [
  "LASTNAME",
  "FIRSTNAME",
  "MIDNAME",
  "BUSNAME",
  "GENERAL",
  "SPECIALTY",
  "UPIN",
  "NPI",
  "DOB",
  "ADDRESS",
  "CITY",
  "STATE",
  "ZIP",
  "EXCLTYPE",
  "EXCLDATE",
  "REINDATE",
  "WAIVERDATE",
  "WVRSTATE",
] as const;

export interface ParsedLeieRow {
  npi: string | null;
  lastname: string;
  firstname: string | null;
  middlename: string | null;
  subjectType: string;
  exclusionType: string;
  exclusionDate: string;
  waiverDate: string | null;
  reinstateDate: string | null;
  addressState: string | null;
  addressCity: string | null;
}

/** Parse one LEIE row. Returns null when required fields are missing
 *  or malformed — the caller skips and logs. */
export function parseLeieCsvLine(
  cells: readonly string[],
): ParsedLeieRow | null {
  if (cells.length < LEIE_CSV_EXPECTED_HEADER.length) return null;
  const get = (col: (typeof LEIE_CSV_EXPECTED_HEADER)[number]): string => {
    const idx = LEIE_CSV_EXPECTED_HEADER.indexOf(col);
    return (cells[idx] ?? "").trim();
  };
  const lastname = get("LASTNAME");
  const busname = get("BUSNAME");
  // Either an individual (LASTNAME present) or entity (BUSNAME used as
  // the canonical lastname slot).
  const canonicalLast = lastname || busname;
  if (!canonicalLast) return null;
  const exclusionTypeRaw = get("EXCLTYPE");
  const exclusionDateRaw = get("EXCLDATE");
  if (!exclusionTypeRaw || !exclusionDateRaw) return null;
  // OIG ships dates as YYYYMMDD without separators.
  const exclusionDate = parseLeieDate(exclusionDateRaw);
  if (!exclusionDate) return null;
  const npiRaw = get("NPI");
  const npi = /^\d{10}$/.test(npiRaw) ? npiRaw : null;
  return {
    npi,
    lastname: canonicalLast.slice(0, 80),
    firstname: get("FIRSTNAME").slice(0, 80) || null,
    middlename: get("MIDNAME").slice(0, 80) || null,
    subjectType: busname && !lastname ? "ENTITY" : "INDIVIDUAL",
    exclusionType: exclusionTypeRaw.slice(0, 20),
    exclusionDate,
    waiverDate: parseLeieDate(get("WAIVERDATE")),
    reinstateDate: parseLeieDate(get("REINDATE")),
    addressState: get("STATE").slice(0, 2) || null,
    addressCity: get("CITY").slice(0, 80) || null,
  };
}

function parseLeieDate(raw: string): string | null {
  const v = raw.trim();
  if (!v || v === "00000000") return null;
  if (/^\d{8}$/.test(v)) {
    return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return null;
}
