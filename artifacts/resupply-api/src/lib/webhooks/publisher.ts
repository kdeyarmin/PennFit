// Webhook event publisher.
//
// Call publishEvent() from anywhere in the codebase when a
// noteworthy thing happens. The function fans the event out into
// one webhook_deliveries row per active webhook_subscriptions row
// that subscribes to either the exact event_type or '*'. The
// dispatcher worker (worker/jobs/webhook-dispatcher.ts) picks up
// queued deliveries and POSTs them with an HMAC signature.
//
// publishEvent NEVER throws. Failed inserts are logged at warn
// and the calling business action proceeds unaffected.
//
// PHI posture: callers MUST pre-sanitize the payload. The publisher
// does not crack open the contents. Recommended pattern: include
// IDs + slugs + counts + amounts; never include patient name, DOB,
// address, or member id. Subscribers fetch enrichment via our API
// when they need PHI.

import {
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../logger";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface PublishEventInput {
  /** Event-type slug. Convention: `<resource>.<action>` (claim.paid,
   *  era.ingested, capped_rental.month_rolled, pa.approved). */
  eventType: string;
  payload: Record<string, unknown>;
  /** Optional supabase client (lets tests inject a fake). */
  supabase?: SupabaseClient;
}

export async function publishEvent(input: PublishEventInput): Promise<void> {
  const supabase = input.supabase ?? getSupabaseServiceRoleClient();
  try {
    const { data: subs, error: subsErr } = await supabase
      .schema("resupply")
      .from("webhook_subscriptions")
      .select("id, event_types")
      .eq("is_active", true);
    if (subsErr) {
      // Same warn shape as the insert failure below — without it a
      // subscription-read error drops the event with zero trace, so
      // partners silently miss events during a DB brownout and there
      // is no log line to find/replay them from.
      logger.warn(
        { err: subsErr.message, eventType: input.eventType },
        "webhook.publish: subscription read failed (event dropped)",
      );
      return;
    }
    const matching = (subs ?? []).filter((s) =>
      ((s.event_types ?? []) as string[]).some(
        (t: string) => t === "*" || t === input.eventType,
      ),
    );
    if (matching.length === 0) return;

    const rows = matching.map((s) => ({
      subscription_id: s.id,
      event_type: input.eventType,
      event_payload: {
        type: input.eventType,
        timestamp: new Date().toISOString(),
        data: input.payload,
      } as unknown as Json,
    }));
    const { error } = await supabase
      .schema("resupply")
      .from("webhook_deliveries")
      .insert(rows);
    if (error) {
      logger.warn(
        { err: error.message, eventType: input.eventType, count: rows.length },
        "webhook.publish: insert failed",
      );
    }
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        eventType: input.eventType,
      },
      "webhook.publish: unexpected error (suppressed)",
    );
  }
}
