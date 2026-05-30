// EHR FHIR (SMART-on-FHIR Backend Services) inbound dispatcher.
//
// Reads an inbound_webhooks row (source matches `ehr_fhir_<slug>`,
// status in ('received', 'processing_failed')) and:
//
//   1. Parses the verbatim FHIR Bundle payload into a typed
//      ParachuteOrder (the canonical inbound-referral shape).
//   2. Hands off to landReferralFromOrder, shared with the
//      Parachute dispatcher.
//
// JWT verification ran inline at the route layer
// (middlewares/requireSmartFhirAccess); the dispatcher does NOT
// re-verify because the JWT is short-lived (5-15 min) and re-fetching
// the partner's JWKS for every drained row is wasteful. Stale-token
// replay is mitigated by the route's iat-window + jti checks.
//
// PHI posture: logger sees referral id + source slug + counts only.
// Bundle bytes never reach the logger.

import { type Database } from "@workspace/resupply-db";
import { parseFhirBundle } from "@workspace/resupply-integrations-ehr-fhir";

import { landReferralFromOrder, type LandOutcome } from "./land-referral";

type InboundWebhookRow =
  Database["resupply"]["Tables"]["inbound_webhooks"]["Row"];

export interface DispatchInput {
  row: Pick<
    InboundWebhookRow,
    "id" | "source" | "payload_json" | "signature_verified"
  >;
  env?: NodeJS.ProcessEnv;
}

export async function dispatchEhrFhir(
  input: DispatchInput,
): Promise<LandOutcome> {
  // Defence in depth: the route's requireSmartFhirAccess marks the
  // row signature_verified=true on insert. If somehow that flag is
  // false here, refuse the dispatch — a Bundle that arrived without
  // verified auth shouldn't materialise a referral.
  if (input.row.signature_verified !== true) {
    return {
      ok: false,
      permanent: true,
      reason: "signature_not_verified",
    };
  }

  const parsed = parseFhirBundle(input.row.payload_json);
  if (!parsed.ok) {
    return {
      ok: false,
      permanent: true,
      reason: `parse_${parsed.reason}`,
    };
  }

  return landReferralFromOrder({
    source: input.row.source,
    inboundWebhookId: input.row.id,
    order: parsed.order,
    dispatcherLabel: "ehr_fhir",
    env: input.env ?? process.env,
  });
}
