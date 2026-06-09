// POST /fax/status-callback — Telnyx Programmable Fax delivery webhook.
//
// Telnyx posts outbound-fax lifecycle events here (we set this URL as
// the per-fax webhook_url on dispatch). The event types:
//   fax.queued → fax.media.processed → fax.sending.started →
//     fax.delivered                              (happy path)
//                                  ↘ fax.failed  (failure_reason set)
//
// Mapping to our DB status column:
//   fax.queued / fax.media.processed /
//     fax.sending.started            → "sent"      (in transit)
//   fax.delivered                    → "delivered"
//   fax.failed                       → "failed"
//
// Design choices:
//   * The Telnyx Ed25519 signature is validated by requireTelnyxSignature
//     (mounted in app.ts with express.raw) BEFORE this handler — by here
//     `req.body` is the parsed JSON event.
//   * 200 every signed request immediately — Telnyx retries non-2xx with
//     backoff; we want the lifecycle stream to flow even if the DB is
//     briefly unhappy.
//   * Audit emits ONLY structural metadata — no fax number, no physician
//     name, no page count beyond "did it arrive?".

import type { Request, Response } from "express";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import {
  parseTelnyxFaxEvent,
  type TelnyxFaxEvent,
} from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger.js";

type FaxOutreachUpdate =
  Database["resupply"]["Tables"]["physician_fax_outreach"]["Update"];
type RxPacketUpdate =
  Database["resupply"]["Tables"]["prescription_request_packets"]["Update"];

type DbFaxStatus = "sent" | "delivered" | "failed";

// Map a Telnyx outbound fax event_type to our DB status, or null for an
// event we don't act on (e.g. fax.received, which is handled by
// /fax/inbound and should never reach here).
function mapTelnyxEvent(eventType: string): DbFaxStatus | null {
  switch (eventType) {
    case "fax.queued":
    case "fax.media.processed":
    case "fax.sending.started":
      return "sent";
    case "fax.delivered":
      return "delivered";
    case "fax.failed":
      return "failed";
    default:
      return null;
  }
}

/**
 * Handler for POST /fax/status-callback. Signature already verified by
 * the upstream requireTelnyxSignature middleware.
 */
export async function faxStatusCallbackHandler(
  req: Request,
  res: Response,
): Promise<void> {
  // Respond 200 immediately — Telnyx retries on non-2xx.
  res.status(200).json({ received: true });

  const parsed = parseTelnyxFaxEvent(req.body);
  if (!parsed.ok) {
    logger.warn(
      { event: "fax_status_body_invalid" },
      "fax status-callback: event missing event_type/fax_id",
    );
    return;
  }

  await processOutboundFaxEvent(parsed.event);
}

// Post-ACK work for an outbound fax delivery-status event. Exported so
// the unified /fax/webhook dispatcher can reuse it. Unmapped event types
// (e.g. fax.received, which the inbound handler owns) are logged + dropped.
export async function processOutboundFaxEvent(
  event: TelnyxFaxEvent,
): Promise<void> {
  const dbStatus = mapTelnyxEvent(event.eventType);
  if (!dbStatus) {
    // An event type we don't map (e.g. a future Telnyx status). Log once
    // and drop — we already 200'd so Telnyx won't retry.
    logger.warn(
      { event: "fax_status_unmapped", telnyx_event_type: event.eventType },
      "fax status-callback: unmapped event type",
    );
    return;
  }

  const faxId = event.faxId;
  const failureReason = event.failureReason;

  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();

  const updates: FaxOutreachUpdate = { status: dbStatus, updated_at: nowIso };
  if (dbStatus === "delivered") {
    updates.delivered_at = nowIso;
  } else if (dbStatus === "failed") {
    updates.failed_at = nowIso;
    if (failureReason) updates.failure_reason = `Telnyx: ${failureReason}`;
  }

  try {
    let outreachQuery = supabase
      .schema("resupply")
      .from("physician_fax_outreach")
      .update(updates)
      .eq("vendor_ref", faxId)
      .eq("vendor_name", "telnyx");
    // Telnyx can deliver lifecycle webhooks out of order. Don't let a
    // late intermediate event (queued / media.processed / sending.started
    // → "sent") rewrite a row that already reached a terminal state, which
    // would make a completed/failed fax look merely "in transit" again.
    // Terminal events (delivered/failed) still apply unconditionally.
    if (dbStatus === "sent") {
      outreachQuery = outreachQuery.not("status", "in", "(delivered,failed)");
    }
    const { error } = await outreachQuery;
    if (error) throw error;
  } catch (err) {
    logger.warn(
      { event: "fax_status_db_failed", faxId, err },
      "fax status-callback: DB update failed",
    );
  }

  // The same Telnyx fax id may match a prescription_request_packets row
  // (the faxable Rx packet feature). Telnyx fax ids are globally unique
  // so at most one of the two tables ever resolves. We update both
  // unconditionally rather than checking which one to keep the handler
  // simple — the UPDATE is a no-op on the table that didn't dispatch
  // this fax.
  const packetUpdates: RxPacketUpdate = { updated_at: nowIso };
  if (dbStatus === "delivered") {
    packetUpdates.status = "delivered";
    packetUpdates.delivered_at = nowIso;
  } else if (dbStatus === "failed") {
    packetUpdates.status = "failed";
    packetUpdates.failed_at = nowIso;
    if (failureReason)
      packetUpdates.failure_reason = `Telnyx: ${failureReason}`;
  }
  // "in transit" statuses leave packet.status alone — we already stamped
  // sent_fax at dispatch time and intermediate queued/sending
  // transitions don't add information.
  if (dbStatus === "delivered" || dbStatus === "failed") {
    try {
      const { error } = await supabase
        .schema("resupply")
        .from("prescription_request_packets")
        .update(packetUpdates)
        .eq("vendor_ref", faxId)
        .eq("vendor_name", "telnyx");
      if (error) throw error;
    } catch (err) {
      logger.warn(
        { event: "rx_packet_status_db_failed", faxId, err },
        "fax status-callback: prescription_request_packets update failed",
      );
    }
  }

  try {
    await logAudit({
      action: "physician_fax_outreach.status_updated",
      targetTable: "physician_fax_outreach",
      metadata: {
        fax_id: faxId,
        telnyx_event_type: event.eventType,
        db_status: dbStatus,
      },
    });
  } catch (err) {
    logger.warn(
      { event: "fax_status_audit_failed", faxId, err },
      "fax status-callback: audit failed",
    );
  }
}
