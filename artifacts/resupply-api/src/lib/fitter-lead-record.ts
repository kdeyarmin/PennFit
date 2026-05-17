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

export interface RecordFitterLeadInput {
  email: string;
  marketingOptIn: boolean;
  submitterIp: string | null;
  userAgent: string | null;
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
        // id + created_at default at the DB layer.
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
      "fitter-lead-record: insert failed (continuing best-effort)",
    );
    return { id: null, error: msg };
  }
}
