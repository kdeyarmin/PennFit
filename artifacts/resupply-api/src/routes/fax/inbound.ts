// POST /fax/inbound — Telnyx Programmable Fax inbound webhook.
//
// When a physician faxes a sleep study, signed Rx, chart note, or any
// other clinical document to our Telnyx fax number, Telnyx POSTs a
// `fax.received` event to the Fax Application's webhook URL (configured
// to this endpoint). We:
//   1. The Telnyx Ed25519 signature is validated by the
//      requireTelnyxSignature middleware mounted ahead of this handler
//      (see app.ts — it runs on the RAW body, then hands us parsed JSON).
//   2. ACK with 200 immediately — Telnyx retries non-2xx, and the media
//      download below can take several seconds for a multi-page fax.
//   3. On the terminal `fax.received` event, persist an `inbound_faxes`
//      row, download the fax bytes from Telnyx's short-lived S3
//      pre-signed media URL, and mirror them to private object storage so
//      the CSR triage queue can pull up the PDF after the ~10-minute URL
//      expiry.
//   4. Emit a non-PHI audit event.
//
// Telnyx fax.received payload (data.payload):
//   fax_id    — UUID for this inbound fax
//   from      — caller's fax number (PHI — never logged)
//   to        — our Telnyx fax number (not PHI on its own)
//   status    — "received" (terminal)
//   media_url — S3 pre-signed URL to the received fax (no auth header)
//   page_count
//   direction — "inbound"
//
// PHI posture
// -----------
//   * `from` is stored on the row (CSRs need it to recognize the
//     sending office) but never reaches the application or audit
//     logger. Audit metadata carries only the fax id + counts.
//   * media_url bytes may contain PHI. They land in object storage under
//     the same private ACL as patient_documents and are fetched only
//     through the admin-gated /admin/inbound-faxes/:id/media signed-URL
//     endpoint.

import type { Request, Response } from "express";

import { logAudit } from "@workspace/resupply-audit";
import {
  parseTelnyxFaxEvent,
  type TelnyxFaxEvent,
} from "@workspace/resupply-telecom";

import { ingestInboundFax } from "../../lib/fax/ingest-inbound.js";
import { logger } from "../../lib/logger.js";

/**
 * Handler for POST /fax/inbound. The Telnyx Ed25519 signature is
 * verified by the requireTelnyxSignature middleware (mounted in app.ts
 * with express.raw) BEFORE this runs; by here `req.body` is the parsed
 * JSON event.
 */
export async function faxInboundHandler(
  req: Request,
  res: Response,
): Promise<void> {
  // ACK immediately — Telnyx retries on non-2xx. We do the media
  // download (which can take several seconds) after responding.
  res.status(200).json({ received: true });

  const parsed = parseTelnyxFaxEvent(req.body);
  if (!parsed.ok) {
    logger.warn(
      { event: "fax_inbound_malformed" },
      "fax/inbound: event missing event_type/fax_id",
    );
    return;
  }

  await processInboundFaxEvent(parsed.event);
}

// Post-ACK work for an inbound fax event. Exported so the unified
// /fax/webhook dispatcher can reuse it without duplicating the PHI-safe
// ingest/audit. Only the terminal inbound `fax.received` event persists;
// any other event type is an intentional no-op (outbound lifecycle events
// route to the status handler), so a mis-routed event can't insert a
// spurious inbound row.
export async function processInboundFaxEvent(
  event: TelnyxFaxEvent,
): Promise<void> {
  if (event.eventType !== "fax.received") return;

  const outcome = await ingestInboundFax(
    {
      telnyxFaxId: event.faxId,
      fromE164: event.from,
      toE164: event.to,
      numPages: event.pageCount,
      receivedAt: new Date().toISOString(),
      mediaUrl: event.mediaUrl,
    },
    logger,
  );

  await logAudit({
    action: "fax.inbound_received",
    targetTable: "inbound_faxes",
    targetId:
      outcome.kind === "inserted" || outcome.kind === "already_recorded"
        ? outcome.id
        : null,
    metadata: {
      fax_id: event.faxId,
      num_pages: event.pageCount,
      direction: event.direction ?? "inbound",
      outcome: outcome.kind,
      // media_persisted captures whether the PDF made it to object
      // storage so a CSR investigating "where's the fax" can tell at a
      // glance whether they need to chase the (now-expired) media URL.
      media_persisted:
        outcome.kind === "inserted" ? outcome.mediaPersisted : null,
      // from withheld — PHI when tied to a physician office. The row
      // itself carries it under PHI ACL.
    },
  }).catch((err: unknown) => {
    logger.warn({ err }, "fax/inbound: audit write failed");
  });
}
