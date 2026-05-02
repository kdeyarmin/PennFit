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

import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";

import {
  getDbPool,
  insuranceLeads,
  type NewInsuranceLead,
} from "@workspace/resupply-db";

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
    const db = drizzle(getDbPool());
    const row: NewInsuranceLead = {
      fullName: input.fullName,
      email: input.email,
      phone: input.phone,
      dateOfBirth: input.dateOfBirth,
      insuranceCarrier: input.insuranceCarrier,
      memberId: input.memberId,
      groupNumber: input.groupNumber,
      prescribingPhysician: input.prescribingPhysician,
      notes: input.notes,
      submitterIp: input.submitterIp,
      userAgent: input.userAgent,
      // status, notification/confirmation flags, timestamps all
      // default at the DB layer.
    };
    const inserted = await db
      .insert(insuranceLeads)
      .values(row)
      .returning({ id: insuranceLeads.id });
    const id = inserted[0]?.id ?? null;
    return { id };
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
    const db = drizzle(getDbPool());
    await db
      .update(insuranceLeads)
      .set({
        notificationEmailDelivered: flags.notificationDelivered,
        confirmationEmailDelivered: flags.confirmationDelivered,
      })
      .where(eq(insuranceLeads.id, id));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err: msg, leadId: id },
      "insurance-lead-record: delivery stamp failed",
    );
  }
}
