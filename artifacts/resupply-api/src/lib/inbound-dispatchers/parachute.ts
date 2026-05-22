// Parachute Health inbound dispatcher.
//
// Reads an inbound_webhooks row (source='parachute', status in
// ('received', 'processing_failed')) and:
//
//   1. Re-verifies the signature header against PARACHUTE_SIGNING_SECRET.
//      The route at /integrations/inbound/parachute also verifies
//      inline so a forged payload never lands in inbound_webhooks in
//      the first place; the dispatcher-side check is defence-in-depth
//      against a stale signing-secret rotation.
//   2. Parses the verbatim payload into a typed ParachuteOrder.
//   3. Hands off to landReferralFromOrder (which is shared with the
//      EHR FHIR dispatcher) for matchers + classifier + insert +
//      document mirror + audit.
//
// PHI posture: the dispatcher logs the referral id, source slug,
// HCPCS code count, and signature outcome only. Never the payload,
// patient name, or any document URL.

import {
  parseParachuteOrder,
  readParachuteConfigOrNull,
  verifyParachuteSignature,
} from "@workspace/resupply-integrations-parachute";

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { landReferralFromOrder, type LandOutcome } from "./land-referral";

type InboundWebhookRow =
  Database["resupply"]["Tables"]["inbound_webhooks"]["Row"];

// Re-export the outcome shape so existing callers keep working.
export type DispatchOutcome = LandOutcome;
// Keep the unused getSupabaseServiceRoleClient + type imports alive
// for a follow-up that adds dispatcher-level metrics.
void getSupabaseServiceRoleClient;

export interface DispatchInput {
  row: Pick<
    InboundWebhookRow,
    | "id"
    | "source"
    | "payload_json"
    | "verification_headers_json"
    | "signature_verified"
  >;
  /** Tests override; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Dispatch a single Parachute inbound_webhooks row. Returns a tagged
 * outcome; the caller (worker/jobs/inbound-webhook-dispatch.ts) is
 * responsible for flipping the inbound_webhooks.status based on it.
 */
export async function dispatchParachute(
  input: DispatchInput,
): Promise<DispatchOutcome> {
  const env = input.env ?? process.env;
  const config = readParachuteConfigOrNull(env);
  if (!config) {
    // No PARACHUTE_SIGNING_SECRET in env — dev / preview deploys.
    return {
      ok: false,
      permanent: false,
      reason: "parachute_unconfigured",
    };
  }

  const headers =
    (input.row.verification_headers_json as Record<string, string> | null) ??
    {};
  const sigHeader = headers["x-parachute-signature"];
  const rawBody = JSON.stringify(input.row.payload_json);
  const verifyOutcome = verifyParachuteSignature({
    rawBody,
    signatureHeader: sigHeader,
    signingSecret: config.signingSecret,
  });
  if (!verifyOutcome.ok) {
    // Bad signature is permanent — re-running won't fix it.
    return {
      ok: false,
      permanent: true,
      reason: `signature_${verifyOutcome.reason}`,
    };
  }

  const parsed = parseParachuteOrder(input.row.payload_json);
  if (!parsed.ok) {
    return {
      ok: false,
      permanent: true,
      reason: "parse_invalid_shape",
    };
  }

  return landReferralFromOrder({
    source: input.row.source,
    inboundWebhookId: input.row.id,
    order: parsed.order,
    dispatcherLabel: "parachute",
    env,
  });
}
