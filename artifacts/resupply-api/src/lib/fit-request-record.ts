// recordFitRequest — persistence for POST /shop/fitter-requests.
//
// Unlike `recordFitterLead` (its marketing-funnel sibling, which is
// best-effort because the patient advances regardless), this write is
// the WHOLE point of the request: the fitter no longer produces an
// order, so if this row does not exist, nothing at the DME knows the
// patient is waiting. The route therefore surfaces a failure to the
// patient — "we couldn't file that, please try again" — rather than
// showing a success screen over a dropped write.
//
// Split out of the route so the route's own test can stub it without
// standing up a Supabase client.

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "./logger";

export interface RecordFitRequestInput {
  /** Tenant the fitting belonged to, resolved from the invite. */
  orgId: string;
  requestType: "full_details" | "callback";
  fullName: string;
  email: string;
  phone: string;
  preferredContactMethod: "phone" | "email" | "text";
  preferredContactTime?: string | null;
  dateOfBirth?: string | null;
  insuranceCarrier?: string | null;
  memberId?: string | null;
  groupNumber?: string | null;
  prescribingPhysician?: string | null;
  notes?: string | null;
  population: "adult" | "pediatric";
  fitSessionId?: string | null;
  recommendedMaskId?: string | null;
  recommendedMaskName?: string | null;
  recommendedMaskType?: string | null;
  recommendedMaskSize?: string | null;
  submitterIp: string | null;
  userAgent: string | null;
}

export interface RecordFitRequestResult {
  id: string | null;
  error?: string;
}

/**
 * Find the marketing-funnel row this request belongs to, so the Fitter
 * Prospects queue can show which prospects have raised their hand.
 *
 * Best-effort on purpose, and separate from the insert above: a patient
 * who reached the fitter through an in-office QR code never submitted
 * `/consent`, so they have no `fitter_leads` row at all. That is a normal
 * outcome, not an error, and it must not cost them their fit request.
 */
async function linkFitterLead(
  orgId: string,
  email: string,
  nowIso: string,
): Promise<string | null> {
  try {
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("fitter_leads")
      .select("id")
      // `fitter_leads.email` is not unique — a patient who restarts the
      // fitter in a fresh session creates another row — so take the
      // newest, which is the one this fitting actually came from.
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const leadId = data?.id ?? null;
    if (!leadId) return null;

    const { error: stampError } = await supabase
      .from("fitter_leads")
      .update({ contact_requested_at: nowIso })
      .eq("id", leadId);
    // A failed stamp costs the queue a sort hint, nothing more — the
    // request itself is already filed, so keep the link either way.
    if (stampError) {
      logger.warn(
        { err: stampError },
        "fit-request-record: contact_requested_at stamp failed",
      );
    }
    return leadId;
  } catch (err) {
    logger.warn({ err }, "fit-request-record: lead link lookup failed");
    return null;
  }
}

export async function recordFitRequest(
  input: RecordFitRequestInput,
): Promise<RecordFitRequestResult> {
  const nowIso = new Date().toISOString();
  const fitterLeadId = await linkFitterLead(input.orgId, input.email, nowIso);

  try {
    const supabase = getOrgScopedClient(input.orgId);
    const { data, error } = await supabase
      .from("fitter_fit_requests")
      .insert({
        request_type: input.requestType,
        status: "new",
        full_name: input.fullName,
        email: input.email,
        phone: input.phone,
        preferred_contact_method: input.preferredContactMethod,
        preferred_contact_time: input.preferredContactTime ?? null,
        date_of_birth: input.dateOfBirth ?? null,
        insurance_carrier: input.insuranceCarrier ?? null,
        member_id: input.memberId ?? null,
        group_number: input.groupNumber ?? null,
        prescribing_physician: input.prescribingPhysician ?? null,
        notes: input.notes ?? null,
        population: input.population,
        fitter_lead_id: fitterLeadId,
        fit_session_id: input.fitSessionId ?? null,
        recommended_mask_id: input.recommendedMaskId ?? null,
        recommended_mask_name: input.recommendedMaskName ?? null,
        recommended_mask_type: input.recommendedMaskType ?? null,
        recommended_mask_size: input.recommendedMaskSize ?? null,
        submitter_ip: input.submitterIp,
        user_agent: input.userAgent,
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return { id: data?.id ?? null };
  } catch (err) {
    // Pass the Error object so pino's err.* redact rules engage.
    logger.error({ err }, "fit-request-record: insert failed");
    return {
      id: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
