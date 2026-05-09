// recordInsuranceLead — best-effort DB persistence for the public
// POST /shop/insurance-leads endpoint.
//
// The DB write is intentionally best-effort:
//   * The patient already saw the form succeed by the time this
//     runs, so a DB hiccup must NEVER turn into a 5xx the patient
//     sees.
//   * If both this AND SendGrid fail, the operator still has the
//     request log line as a last-resort breadcrumb.
//
// We split this out of the route handler so the route's own test
// can mock just this helper (alongside the SendGrid one) without
// pulling in a real DB pool.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "./logger";

export interface RecordInsuranceLeadInput {
  fullName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  insuranceCarrier: string;
  memberId: string;
  groupNumber: string | null;
  prescribingPhysician: string | null;
  notes: string | null;
  submitterIp: string | null;
  userAgent: string | null;
}

export interface RecordInsuranceLeadResult {
  /** Row id when the insert succeeded; null on best-effort failure. */
  id: string | null;
  /** Truthy when something other than a successful insert happened.
   *  Surfaced into the request log line for ops triage. */
  error?: string;
}

/**
 * Insert a row into `resupply.insurance_leads`. Returns the new row's
 * id on success, or `{ id: null, error }` on failure — the caller is
 * expected to log + continue rather than 5xx the patient.
 */
export async function recordInsuranceLead(
  input: RecordInsuranceLeadInput,
): Promise<RecordInsuranceLeadResult> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data: inserted, error } = await supabase
      .schema("resupply")
      .from("insurance_leads")
      .insert({
        full_name: input.fullName,
        email: input.email,
        phone: input.phone,
        date_of_birth: input.dateOfBirth,
        insurance_carrier: input.insuranceCarrier,
        member_id: input.memberId,
        group_number: input.groupNumber,
        prescribing_physician: input.prescribingPhysician,
        notes: input.notes,
        submitter_ip: input.submitterIp,
        user_agent: input.userAgent,
        // status, notification/confirmation flags, timestamps all
        // default at the DB layer.
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return { id: inserted?.id ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err: msg },
      "insurance-lead-record: insert failed (continuing best-effort)",
    );
    return { id: null, error: msg };
  }
}

/**
 * Stamp the SendGrid delivery flags on an existing lead row. Best-
 * effort: if the row id is null (because the insert failed) we do
 * nothing. Used to record the email outcome AFTER the SendGrid call
 * resolved, so the admin queue can flag "all today's notifications
 * failed" as a mailbox-side issue.
 */
export async function stampInsuranceLeadDelivery(
  id: string | null,
  flags: {
    notificationDelivered: boolean;
    confirmationDelivered: boolean;
  },
): Promise<void> {
  if (!id) return;
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("insurance_leads")
      .update({
        notification_email_delivered: flags.notificationDelivered,
        confirmation_email_delivered: flags.confirmationDelivered,
      })
      .eq("id", id);
    if (error) throw error;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err: msg, leadId: id },
      "insurance-lead-record: delivery stamp failed",
    );
  }
}
