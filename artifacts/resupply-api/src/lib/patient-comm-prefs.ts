// Resolve a PATIENT's stored communication preferences.
//
// `lib/comm-prefs.ts` beside this file decides whether a given
// preferences object permits a given message. This module answers the
// question before that one: which preferences object belongs to this
// patient?
//
// HOW THE TWO TABLES ACTUALLY JOIN
// --------------------------------
// `resupply.shop_customers` holds `communication_preferences` and has NO
// `patient_id` column. `resupply.patients` has no
// `communication_preferences` column. The two reach each other one of
// two ways:
//   * `shop_customers.auth_user_id` = `patients.portal_auth_user_id` —
//     the strong link, an actual portal login; or
//   * `shop_customers.email_lower` = `lower(patients.email)` — the
//     weaker one, used only when the portal link is absent.
// Migration 0532 exists precisely because there is no direct column: it
// backfills `customer_acquisition.patient_id` through exactly this pair
// of joins, in exactly this order.
//
// WHY THIS IS SHARED CODE AND NOT A LOCAL HELPER
// ----------------------------------------------
// Filtering on a column that does not exist does not return nothing —
// PostgREST returns 42703. A call site that destructures only `data`
// swallows that error and reads the result as "no stored preference",
// which for email means the opted-IN default. The bug is therefore
// silent AND it fails toward SENDING, which is the wrong direction for a
// consent check: a patient who explicitly turned these messages off
// still gets them.
//
// That exact bug was found and fixed once inside
// `worker/jobs/fitter-followup-scan.ts`, and three other jobs
// (refit-campaign, outreach-playbook-tick, dunning-engine) were still
// carrying it afterwards — because the fix was a local function, so
// there was nothing for the next author to reuse. Hence one
// implementation, here, with the failure surfaced (`unknown`) so callers
// must decide explicitly rather than inherit a permissive default.
//
// This helper deliberately does NOT read `patients`. Every caller
// already has that row in hand, and re-reading it would add a
// round-trip per patient per tick to jobs that scan in bulk.

import {
  DEFAULT_COMMUNICATION_PREFERENCES,
  type CommunicationPreferences,
  type OrgScopedClient,
} from "@workspace/resupply-db";

export interface PatientIdentity {
  /** `patients.email` — lowercased here, so pass it raw. */
  email?: string | null;
  /** `patients.portal_auth_user_id`, when the patient has a portal login. */
  portalAuthUserId?: string | null;
}

export interface ResolvedCommPrefs {
  /**
   * Always populated, so callers can evaluate without null checks.
   * Equals `DEFAULT_COMMUNICATION_PREFERENCES` when nothing is stored —
   * check `explicit` to tell "they opted in" from "we never asked".
   */
  prefs: CommunicationPreferences;
  /**
   * True only when a stored preferences object was actually found.
   * "We have never asked them" is not "they said no", so a caller whose
   * message needs prior opt-in should gate on this; a caller sending
   * something transactional generally should not.
   */
  explicit: boolean;
  /**
   * True when the lookup itself FAILED, as opposed to succeeding and
   * finding nothing. Callers MUST NOT send on an unknown: preferences we
   * could not read might be a refusal. Nothing is stamped on this path,
   * so the next tick retries at no cost.
   */
  unknown: boolean;
}

const UNKNOWN: ResolvedCommPrefs = {
  prefs: DEFAULT_COMMUNICATION_PREFERENCES,
  explicit: false,
  unknown: true,
};

const NOT_STORED: ResolvedCommPrefs = {
  prefs: DEFAULT_COMMUNICATION_PREFERENCES,
  explicit: false,
  unknown: false,
};

async function readBy(
  supabase: OrgScopedClient,
  column: "auth_user_id" | "email_lower",
  value: string,
): Promise<{ raw: unknown; failed: boolean; found: boolean }> {
  const { data, error } = (await supabase
    .from("shop_customers")
    .select("communication_preferences")
    .eq(column, value)
    .limit(1)
    .maybeSingle()) as {
    data: Record<string, unknown> | null;
    error: unknown;
  };
  if (error) return { raw: null, failed: true, found: false };
  return {
    raw: data?.communication_preferences ?? null,
    failed: false,
    found: data !== null,
  };
}

/**
 * Look up the `shop_customers` row that belongs to this patient and read
 * its `communication_preferences`.
 *
 * A patient with neither a portal login nor an email has no row to find;
 * that is `NOT_STORED`, not a failure — most patients arrive through the
 * insurance pipeline and never create a storefront account.
 */
export async function resolvePatientCommPrefs(
  supabase: OrgScopedClient,
  identity: PatientIdentity,
): Promise<ResolvedCommPrefs> {
  const authUserId = identity.portalAuthUserId ?? null;
  const email = identity.email ?? null;
  if (!authUserId && !email) return NOT_STORED;

  try {
    let raw: unknown = null;
    let foundByAuth = false;
    if (authUserId) {
      const byAuth = await readBy(supabase, "auth_user_id", authUserId);
      if (byAuth.failed) return UNKNOWN;
      raw = byAuth.raw;
      foundByAuth = byAuth.found;
    }
    // Only when the strong link found nothing — an existing portal row
    // that stores no preferences is still that patient's row, and
    // falling through to a shared/stale email match could read someone
    // else's answers.
    if (!raw && !foundByAuth && email) {
      const byEmail = await readBy(
        supabase,
        "email_lower",
        email.toLowerCase(),
      );
      if (byEmail.failed) return UNKNOWN;
      raw = byEmail.raw;
    }

    if (!raw || typeof raw !== "object") return NOT_STORED;
    return {
      prefs: {
        ...DEFAULT_COMMUNICATION_PREFERENCES,
        ...(raw as Partial<CommunicationPreferences>),
      },
      explicit: true,
      unknown: false,
    };
  } catch {
    return UNKNOWN;
  }
}
