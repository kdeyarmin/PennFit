// HIPAA §164.528 accounting-of-disclosures helpers.
//
// Two responsibilities:
//
//   1. `logDisclosure(...)` — append a row to
//      `resupply.patient_disclosure_log` every time PHI is shared
//      for a non-TPO purpose. Routes that hand PHI to an outside
//      party (court order response, public health report, research,
//      law enforcement, etc.) call this BEFORE the disclosure
//      completes so the audit row is committed even if the response
//      transmission later fails.
//   2. `getDisclosureAccounting(...)` — pure read used by the
//      §164.528-response generator and the admin "preview accounting"
//      surface. Returns the rows in disclosed_at-descending order with
//      the 6-year statutory cap pre-applied.
//
// PHI containment: this module DOES handle PHI by definition — the
// description field intentionally contains a short narrative of what
// was disclosed. Audit log entries summarize counts, not bodies.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import type {
  Database,
  DisclosurePurpose,
} from "@workspace/resupply-db";

import { logger } from "../logger";

type DisclosureInsert =
  Database["resupply"]["Tables"]["patient_disclosure_log"]["Insert"];
type DisclosureRow =
  Database["resupply"]["Tables"]["patient_disclosure_log"]["Row"];

export interface LogDisclosureInput {
  patientId: string;
  recipientName: string;
  recipientAddress?: string | null;
  purpose: DisclosurePurpose;
  description: string;
  legalAuthority?: string | null;
  patientAuthorized?: boolean;
  disclosedAt?: Date;
  disclosedByEmail: string;
}

/** Insert a §164.528 accounting row. Throws on insert failure so the
 *  caller can refuse to complete the disclosure when the audit trail
 *  cannot be written (this is the conservative HIPAA posture). */
export async function logDisclosure(
  input: LogDisclosureInput,
): Promise<{ id: string }> {
  const supabase = getSupabaseServiceRoleClient();
  const row: DisclosureInsert = {
    patient_id: input.patientId,
    recipient_name: input.recipientName,
    recipient_address: input.recipientAddress ?? null,
    disclosure_purpose: input.purpose,
    description: input.description,
    legal_authority: input.legalAuthority ?? null,
    patient_authorized: input.patientAuthorized ?? false,
    disclosed_at: (input.disclosedAt ?? new Date()).toISOString(),
    disclosed_by_email: input.disclosedByEmail,
  };
  const { data, error } = await supabase
    .schema("resupply")
    .from("patient_disclosure_log")
    .insert(row)
    .select("id")
    .single();
  if (error) {
    logger.warn(
      { err: error.message, patient_id: input.patientId },
      "disclosure.log insert failed",
    );
    throw error;
  }
  return { id: data.id };
}

export interface GetDisclosureAccountingInput {
  patientId: string;
  fromDate?: string;
  toDate?: string;
  /** Whether to include disclosures the patient authorized in writing.
   *  Default false (§164.528(a)(1)(i) excludes them from the accounting). */
  includeAuthorized?: boolean;
}

export async function getDisclosureAccounting(
  input: GetDisclosureAccountingInput,
): Promise<DisclosureRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  // §164.528(a)(2) caps the accounting window at 6 years.
  const sixYearsAgo = new Date();
  sixYearsAgo.setUTCFullYear(sixYearsAgo.getUTCFullYear() - 6);
  const floor = input.fromDate
    ? maxDate(input.fromDate, sixYearsAgo.toISOString())
    : sixYearsAgo.toISOString();
  let query = supabase
    .schema("resupply")
    .from("patient_disclosure_log")
    .select("*")
    .eq("patient_id", input.patientId)
    .gte("disclosed_at", floor);
  if (input.toDate) query = query.lte("disclosed_at", input.toDate);
  if (!input.includeAuthorized) {
    query = query.eq("patient_authorized", false);
  }
  const { data, error } = await query.order("disclosed_at", {
    ascending: false,
  });
  if (error) throw error;
  return (data ?? []) as DisclosureRow[];
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}
