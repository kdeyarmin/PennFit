// Record that an inbound event could not be attributed to a tenant.
//
// WHY THIS EXISTS
// ---------------
// An inbound SMS or call whose tenant cannot be resolved is DROPPED, and
// that is the correct behaviour: the alternative is filing a stranger's
// message under whichever practice looked closest, which is precisely
// the tenant-isolation bug this platform refuses to have.
//
// But dropped meant unrecorded. The failure rate was zero by
// construction, so a DID pointed at the platform before it was
// registered to a tenant could swallow a practice's inbound calls
// indefinitely and nothing would say so. (The `safeAudit` call at those
// sites writes nothing — migration 0156 retired audit_log and left the
// package a no-op stub.)
//
// WHAT IT WRITES
// --------------
// A day, a channel, a reason, a count. There is no phone number, no
// message id, no patient — and no column for one. That is not an
// oversight: attribution is exactly what failed, so there is no tenant
// to scope a PHI-bearing row to, and the only safe record of the event
// is one that contains nothing about the person who sent it.
//
// The increment goes through an RPC because a read-modify-write would
// lose increments under exactly the conditions that matter — a
// misrouted number generating a burst — and would understate the spike
// this signal exists to catch.
//
// FIRE AND FORGET
// ---------------
// Never throws. An inbound webhook has to answer Twilio inside its
// timeout, and failing to record a metric must not become failing to
// reply.

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../logger";

export type AttributionChannel = "sms" | "voice";

/**
 * Closed vocabulary, mirrored by a CHECK constraint in migration 0543.
 *
 * Closed on purpose: an open-ended reason string is how free text — and
 * eventually a phone number — ends up in a table that promises it holds
 * none.
 */
export const ATTRIBUTION_FAILURE_REASONS = [
  /** Nobody owns the dialled/texted number on that channel. */
  "unknown_called_number",
  /**
   * The caller's own number exists in more than one tenant, so ownership
   * is genuinely undecidable and the resolver failed closed rather than
   * guessing. Distinct from `unknown_caller`: this one means we found
   * too much, not too little, and the fix is a dedicated DID.
   */
  "ambiguous_caller",
  /** The caller's number matched nothing anywhere. */
  "unknown_caller",
  /** The directory read itself failed. An outage, not a miss. */
  "directory_unavailable",
] as const;

export type AttributionFailureReason =
  (typeof ATTRIBUTION_FAILURE_REASONS)[number];

/**
 * Increment one rollup bucket. Never throws.
 *
 * @param channel  which inbound surface dropped the event
 * @param reason   why attribution failed, from the closed vocabulary
 */
export async function recordAttributionFailure(
  channel: AttributionChannel,
  reason: AttributionFailureReason,
): Promise<void> {
  try {
    // The table is GLOBAL — it has no org_id and cannot have one, since
    // attribution is what failed. Reached through `.raw()` with the seed
    // org only to obtain a client; nothing tenant-scoped is read.
    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) return;
    const raw = getOrgScopedClient(seedOrgId).raw();
    const { error } = await raw.schema("resupply").rpc(
      "record_inbound_attribution_failure",
      { p_channel: channel, p_reason: reason },
    );
    if (error) throw error;
  } catch (err) {
    logger.warn(
      {
        event: "inbound_attribution.record_failed",
        channel,
        reason,
        errName: err instanceof Error ? err.name : "unknown",
      },
      "inbound-attribution: could not record a failed attribution",
    );
  }
}
