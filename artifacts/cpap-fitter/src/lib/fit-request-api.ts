// Client for POST /shop/fitter-requests — how a fitting now ends.
//
// The fitter used to finish at /order, which POSTed straight into the
// order queue. It no longer does: the patient sends a REQUEST and a
// person at the DME picks it up. Two shapes, one endpoint:
//
//   "full_details" — the patient filled in what they know, including
//     (optionally) their insurance carrier and member ID.
//   "callback"     — the patient asked to be contacted. Name and one
//     channel is all we take, deliberately.
//
// PRIVACY: this carries the patient's own contact details and, when they
// choose to give them, insurance identifiers. It never carries
// measurements (those already travelled with the fitting) and never
// anything image-derived.

import { csrfHeader } from "@/lib/csrf";

const REQUEST_URL = "/resupply-api/shop/fitter-requests";

export type FitRequestType = "full_details" | "callback";

export interface FitRequestInput {
  /**
   * The signed invite the fitting came from. OPTIONAL because the demo
   * sandbox satisfies the route guards without one (`isDemoActive`) and
   * its client-side interceptor answers this endpoint — sending an empty
   * header there would be a lie. Outside demo mode the guard guarantees a
   * token, and the server 403s without one either way.
   */
  inviteToken?: string | null;
  requestType: FitRequestType;
  fullName: string;
  email: string;
  /** Empty when the patient asked to be reached by email. */
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
  /** Honeypot. Bound to a hidden input; a human never fills it. */
  website?: string;
}

export type FitRequestResult =
  | { kind: "filed"; confirmationEmailed: boolean }
  /**
   * The request did NOT reach the DME. Distinct from a filed request
   * whose confirmation email bounced: this one has to be retried, and
   * the patient has no order number to chase it with, so the UI must
   * say so rather than showing a thank-you page over nothing.
   */
  | { kind: "failed"; message: string };

/** Strip empty strings so an untouched optional field records as NULL
 *  rather than as an empty value a CSR has to squint at. */
function trimmedOrNull(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

/**
 * File the request. Never throws — a patient at the end of a fitting
 * must get a sentence they can act on, not an unhandled rejection.
 */
export async function submitFitRequest(
  input: FitRequestInput,
): Promise<FitRequestResult> {
  const body: Record<string, unknown> = {
    requestType: input.requestType,
    fullName: input.fullName.trim(),
    email: input.email.trim().toLowerCase(),
    phone: input.phone.trim(),
    preferredContactMethod: input.preferredContactMethod,
    population: input.population,
  };
  const optional: Array<[string, string | null | undefined]> = [
    ["preferredContactTime", input.preferredContactTime],
    ["dateOfBirth", input.dateOfBirth],
    ["insuranceCarrier", input.insuranceCarrier],
    ["memberId", input.memberId],
    ["groupNumber", input.groupNumber],
    ["prescribingPhysician", input.prescribingPhysician],
    ["notes", input.notes],
    ["recommendedMaskId", input.recommendedMaskId],
    ["recommendedMaskName", input.recommendedMaskName],
    ["recommendedMaskType", input.recommendedMaskType],
    ["recommendedMaskSize", input.recommendedMaskSize],
  ];
  for (const [key, value] of optional) {
    const v = trimmedOrNull(value);
    if (v) body[key] = v;
  }
  if (input.fitSessionId) body.fitSessionId = input.fitSessionId;
  if (input.website) body.website = input.website;

  let res: Response;
  try {
    res = await fetch(REQUEST_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(input.inviteToken
          ? { "x-fitter-invite-token": input.inviteToken }
          : {}),
        ...csrfHeader(),
      },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      kind: "failed",
      message:
        "We couldn't reach the team just now — check your connection and try again.",
    };
  }

  if (!res.ok) {
    let message =
      "We couldn't send that just now. Please try again in a moment.";
    try {
      const payload = (await res.json()) as {
        error?: string;
        message?: string;
      };
      // Only the server's own patient-facing sentence is shown; an error
      // CODE ("invalid_body") is for logs, not for a patient.
      if (typeof payload?.message === "string" && payload.message) {
        message = payload.message;
      }
    } catch {
      // Non-JSON body (a proxy error page mid-deploy) — keep the generic
      // sentence above.
    }
    return { kind: "failed", message };
  }

  let confirmationEmailed = false;
  try {
    const payload = (await res.json()) as { confirmationEmailed?: boolean };
    confirmationEmailed = payload?.confirmationEmailed === true;
  } catch {
    // Filed, but we can't tell whether the confirmation went out. The
    // request is what matters; the copy degrades to not promising an
    // email that may not arrive.
  }
  return { kind: "filed", confirmationEmailed };
}
