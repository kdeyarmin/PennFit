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

import { createHash } from "node:crypto";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "./logger";
import { redactDbErr } from "./redact-db-err";

export interface RecordFitRequestInput {
  /** Tenant the fitting belonged to, resolved from the invite. */
  orgId: string;
  requestType: "full_details" | "callback";
  fullName: string;
  email: string;
  phone: string | null;
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
  /**
   * True when this submission matched a request already open in the
   * queue and no new row was created. The patient still sees a normal
   * confirmation — from their side the ask landed, which is true — but
   * the caller must NOT re-notify staff or re-stamp the prospect: the
   * first submission already did both, and a second copy of each is
   * exactly the noise this dedup exists to remove.
   */
  duplicate?: boolean;
  error?: string;
}

/**
 * The idempotency key: what makes two submissions the SAME ask.
 *
 * Identity and contact details, plus the request type — a patient who
 * sends their details and then also asks for a call has asked for two
 * different things and belongs in the queue twice.
 *
 * Everything is normalized before hashing so that trivia a patient would
 * never consider a difference (capitalisation, a middle space, the way
 * they punctuate a phone number) does not defeat the match. Phone drops
 * to digits for the same reason: "(215) 555-0134" and "215-555-0134" are
 * one number typed twice.
 *
 * What is deliberately NOT in the key: notes, insurance, date of birth,
 * the chosen mask, the fit session. Those are things a patient CORRECTS
 * on a second pass, and hashing them would turn every correction into a
 * duplicate queue row — the exact failure this is meant to prevent.
 * A correction instead lands on the open request through the update
 * below, so staff see the latest details rather than two conflicting
 * rows.
 *
 * Hashed rather than stored in the clear because the components are PHI
 * (a name, an email, a phone number) and this column exists only to be
 * compared for equality — it never needs to be read back.
 */
export function computeFitRequestDedupeHash(input: {
  requestType: string;
  fullName: string;
  email: string;
  phone: string | null;
  population: string;
  fitSessionId?: string | null;
}): string {
  const text = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
  const digits = (v: string | null) => (v ?? "").replace(/\D+/g, "");
  const parts = [
    input.requestType,
    text(input.fullName),
    text(input.email),
    digits(input.phone),
    // WHO THE FITTING IS FOR, not just who is asking.
    //
    // A parent fits themselves and then their child from the same
    // device, under their own name, email and phone. Without these two
    // the second ask hashes identically to the first, gets suppressed,
    // and its session and chosen mask overwrite the adult row through
    // enrichment — leaving one request whose population says "adult"
    // while its fitting is the child's. That is the wrong-age failure
    // the fitter exists to prevent, arriving through the back door.
    //
    // The session id is the sharper of the two (two children are two
    // sessions); population catches the case where there is no session
    // at all, which is every callback request.
    input.population,
    (input.fitSessionId ?? "").trim(),
  ];
  // A separator that cannot occur in any normalized part, so
  // ("ab", "c") and ("a", "bc") cannot collide into one key.
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
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
async function findFitterLead(
  orgId: string,
  email: string,
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
    return data?.id ?? null;
  } catch (err) {
    logger.warn(
      { err: redactDbErr(err) },
      "fit-request-record: lead link lookup failed",
    );
    return null;
  }
}

/**
 * Mark the prospect as having raised their hand.
 *
 * Deliberately SEPARATE from the lookup, and called only after the
 * request row exists. Stamping first meant a failed insert left the
 * prospects queue claiming a patient had asked to be contacted while no
 * actionable request existed and the patient had been told to try again
 * — two queues disagreeing about the same person.
 *
 * A failed stamp costs the queue a sort hint and nothing more, so it
 * never fails the request.
 */
async function stampContactRequested(
  orgId: string,
  leadId: string,
  nowIso: string,
): Promise<void> {
  try {
    const supabase = getOrgScopedClient(orgId);
    const { error } = await supabase
      .from("fitter_leads")
      .update({ contact_requested_at: nowIso })
      .eq("id", leadId);
    if (error) throw error;
  } catch (err) {
    logger.warn(
      { err: redactDbErr(err) },
      "fit-request-record: contact_requested_at stamp failed",
    );
  }
}

/**
 * Patient-supplied fields that are NOT part of the dedupe key, and so
 * may legitimately differ between two submissions that dedupe together —
 * the common case being a patient who re-submits having found their
 * insurance card. Applied to the surviving open request so staff work
 * the fullest version of what the patient told us.
 *
 * Only non-empty values are applied: a second, sparser submission must
 * never blank out something the first one supplied. CSR-owned columns
 * (status, csr_note, contacted_at/by, closed_*) are absent by
 * construction — the patient never supplies them, and a re-submit must
 * not undo work the queue has already done on the request.
 */
function enrichmentPatch(input: RecordFitRequestInput): Record<string, string> {
  const patch: Record<string, string> = {};
  const put = (column: string, value: string | null | undefined) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) patch[column] = trimmed;
  };
  // The channel the patient asked to be reached on. NOT part of the key
  // — switching from a call to a text is a correction to the same ask,
  // not a new one — but it must still reach staff, or they keep phoning
  // someone who has since asked to be texted.
  put("preferred_contact_method", input.preferredContactMethod);
  put("preferred_contact_time", input.preferredContactTime);
  put("date_of_birth", input.dateOfBirth);
  put("insurance_carrier", input.insuranceCarrier);
  put("member_id", input.memberId);
  put("group_number", input.groupNumber);
  put("prescribing_physician", input.prescribingPhysician);
  put("notes", input.notes);
  // `fit_session_id` is deliberately absent: it is part of the dedupe
  // key now, so a row that matched already has this exact session and a
  // different session is a different row. Enriching it could only ever
  // move a fitting from one request to another.
  put("recommended_mask_id", input.recommendedMaskId);
  put("recommended_mask_name", input.recommendedMaskName);
  put("recommended_mask_type", input.recommendedMaskType);
  put("recommended_mask_size", input.recommendedMaskSize);
  return patch;
}

/**
 * Resolve a unique-violation on the open-request dedupe index into the
 * request that already exists, enriching it with anything new the patient
 * supplied this time.
 *
 * Returns null when the conflicting row can no longer be found — a CSR
 * closing it in the moment between our INSERT failing and this SELECT
 * running. That is a real (if narrow) race, and the honest response is to
 * let the caller insert again: the queue is empty of this ask once more,
 * so a new row is correct rather than duplicate.
 */
async function adoptExistingOpenRequest(
  orgId: string,
  dedupeHash: string,
  input: RecordFitRequestInput,
): Promise<string | null> {
  const supabase = getOrgScopedClient(orgId);

  // ONE statement, not a SELECT then an UPDATE.
  //
  // A read-then-write here has the same flaw the insert does: a CSR can
  // close the matching request in the gap, and the update then lands on
  // a row staff have already finished — while the patient is told their
  // ask is in the queue when nothing of theirs is open. Guarding the
  // UPDATE itself on `status <> 'closed'` makes the database decide, and
  // the returned row is proof an open request existed at that instant.
  //
  // `dedupe_hash` is written back to the value it already holds so the
  // statement is a valid UPDATE even when the patient supplied nothing
  // new. It is a no-op on the column and keeps this to one round trip.
  const { data, error } = (await supabase
    .from("fitter_fit_requests")
    .update({ dedupe_hash: dedupeHash, ...enrichmentPatch(input) })
    .eq("dedupe_hash", dedupeHash)
    .neq("status", "closed")
    .select("id")
    .limit(1)
    .maybeSingle()) as {
    data: { id?: string } | null;
    error: { code?: string; message: string } | null;
  };

  if (!error) return data?.id ?? null;

  // The enrichment write failed. The conflict itself was real — the
  // insert proved an open row with this hash exists — so the patient IS
  // queued, and returning null here would send the caller back to insert
  // a second row (or worse, tell the patient their request failed while
  // it sits in the queue). Fall back to reading the id without patching:
  // losing the extra detail is the small loss, losing the request is not.
  logger.warn(
    { err: redactDbErr(error), event: "fit_request_duplicate_enrich_failed" },
    "fit-request-record: could not enrich the existing request",
  );

  const { data: fallback, error: readErr } = (await supabase
    .from("fitter_fit_requests")
    .select("id")
    .eq("dedupe_hash", dedupeHash)
    .neq("status", "closed")
    .limit(1)
    .maybeSingle()) as {
    data: { id?: string } | null;
    error: { message: string } | null;
  };
  if (readErr) throw readErr;
  return fallback?.id ?? null;
}

export async function recordFitRequest(
  input: RecordFitRequestInput,
): Promise<RecordFitRequestResult> {
  const nowIso = new Date().toISOString();
  const fitterLeadId = await findFitterLead(input.orgId, input.email);
  const dedupeHash = computeFitRequestDedupeHash({
    requestType: input.requestType,
    fullName: input.fullName,
    email: input.email,
    phone: input.phone,
    population: input.population,
    fitSessionId: input.fitSessionId,
  });

  const row = {
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
    dedupe_hash: dedupeHash,
    submitter_ip: input.submitterIp,
    user_agent: input.userAgent,
  };

  try {
    const supabase = getOrgScopedClient(input.orgId);
    // Two attempts at most. The second exists only for the close-race in
    // `adoptExistingOpenRequest`, and cannot itself loop: a row closed
    // between the attempts stays closed, so the retry either inserts or
    // conflicts with a genuinely new open row and adopts that one.
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, error } = await supabase
        .from("fitter_fit_requests")
        .insert(row)
        .select("id")
        .limit(1)
        .maybeSingle();

      if (!error) {
        const id = data?.id ?? null;
        // Only now — the request exists, so the prospects queue can
        // honestly say this person raised their hand.
        if (id && fitterLeadId) {
          await stampContactRequested(input.orgId, fitterLeadId, nowIso);
        }
        return { id };
      }

      // 23505 = unique_violation. The only unique constraint this insert
      // can trip is the open-request dedupe index, so this IS a
      // re-submit: the database arbitrated between two racing
      // double-clicks, or the patient came back through the form.
      if ((error as { code?: string }).code !== "23505") throw error;

      const existingId = await adoptExistingOpenRequest(
        input.orgId,
        dedupeHash,
        input,
      );
      if (existingId) {
        logger.info(
          { event: "fit_request_duplicate_suppressed" },
          "fit-request-record: re-submit matched an open request",
        );
        return { id: existingId, duplicate: true };
      }
      // Raced with a close — fall through and insert for real.
    }

    // Both attempts conflicted and both times the conflicting row had
    // vanished. Vanishingly unlikely, and not something to retry
    // forever; report it like any other failed write so the patient is
    // told to try again rather than shown a confirmation over nothing.
    return { id: null, error: "fit request insert conflicted repeatedly" };
  } catch (err) {
    logger.error(
      { err: redactDbErr(err) },
      "fit-request-record: insert failed",
    );
    return { id: null, error: describeError(err) };
  }
}

/**
 * A readable message for whatever the data layer threw.
 *
 * PostgREST rejects with a plain `{ code, message, details, hint }`
 * object, not an Error — so the obvious `String(err)` renders the one
 * thing an operator needs to diagnose a failed write as
 * "[object Object]".
 *
 * Built ON redactDbErr rather than reading the error itself, so there is
 * exactly ONE definition of which fields are safe to surface. `details`
 * and `hint` are the dangerous ones: on a constraint violation Postgres
 * puts the whole offending row in them ("Failing row contains (…, Dana
 * Ruiz, dana@example.com, 1961-04-02, …)"), which is PHI, and this
 * string reaches a log line.
 */
function describeError(err: unknown): string {
  const { code, message } = redactDbErr(err);
  if (!message) return code ?? "unknown database error";
  return code ? `${code}: ${message}` : message;
}
