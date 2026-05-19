// recordFitterLead — best-effort DB persistence for the public
// POST /shop/fitter-leads endpoint.
//
// The DB write is intentionally best-effort: the patient sees the
// fitter advance the moment the route resolves, so a DB hiccup must
// never turn into a 5xx that blocks them from running the fitter.
// If the insert fails, we log + return null and the route still 200s.
//
// Split out of the route handler so the route's own test can stub
// this helper without standing up a real Supabase client.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "./logger";

/**
 * Allowed sources for a fitter_leads row. See migration 0121 for the
 * full enum rationale; defaulting to "consent" preserves back-compat
 * with legacy rows + the existing /consent route.
 */
export type FitterLeadSource =
  | "consent"
  | "sleep_apnea_quiz"
  | "insurance_quote";

export interface RecordFitterLeadInput {
  email: string;
  marketingOptIn: boolean;
  submitterIp: string | null;
  userAgent: string | null;
  /** E.164-formatted phone, optional. SMS opt-in is independent. */
  phoneE164?: string | null;
  /** Whether the patient ticked the SMS opt-in checkbox. */
  smsOptIn?: boolean;
  /** Origin of the lead. Defaults to "consent" for back-compat. */
  source?: FitterLeadSource;
}

export interface RecordFitterLeadResult {
  /** Row id when the insert succeeded; null on best-effort failure. */
  id: string | null;
  /** Truthy when something other than a successful insert happened.
   *  Surfaced into the request log line for ops triage. */
  error?: string;
}

export async function recordFitterLead(
  input: RecordFitterLeadInput,
): Promise<RecordFitterLeadResult> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data: inserted, error } = await supabase
      .schema("resupply")
      .from("fitter_leads")
      .insert({
        email: input.email,
        marketing_opt_in: input.marketingOptIn,
        submitter_ip: input.submitterIp,
        user_agent: input.userAgent,
        // sms_opt_in defaults to false in the schema; only persist
        // true when the row carries an actual phone, otherwise the
        // checkbox is meaningless.
        phone_e164: input.phoneE164 ?? null,
        sms_opt_in: Boolean(input.phoneE164 && input.smsOptIn),
        source: input.source ?? "consent",
        // id + created_at default at the DB layer.
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return { id: inserted?.id ?? null };
  } catch (err) {
    // Pass the Error object so pino's err.message / err.stack /
    // err.cause.* redact rules engage; logging the bare string under
    // the `err` key would bypass redaction. The returned `error`
    // string is the caller's choice — it goes into a counts-only
    // log line, not the audit table.
    logger.warn(
      { err },
      "fitter-lead-record: insert failed (continuing best-effort)",
    );
    return {
      id: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
