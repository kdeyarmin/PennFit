// POST /fax/inbound — Twilio Programmable Fax inbound webhook.
//
// When a physician faxes a sleep study, signed Rx, chart note, or
// any other clinical document to our Twilio fax number, Twilio
// POSTs this endpoint. We:
//   1. Validate the Twilio signature.
//   2. ACK immediately with empty TwiML — Twilio retries 5xx and
//      will mint a duplicate FaxSid if we don't 2xx within ~15s.
//   3. On the `Status=received` terminal callback only, persist an
//      `inbound_faxes` row, download the fax bytes from Twilio's
//      media URL with basic-auth, and mirror them to GCS so the
//      CSR triage queue can pull up the PDF whenever (not just
//      inside Twilio's ~365-day retention window).
//   4. Emit a non-PHI audit event.
//
// Twilio fax inbound fields (form-urlencoded):
//   FaxSid    — "FXxxxxxxxxxx…" unique ID for this inbound fax
//   From      — caller's fax number (PHI — never logged)
//   To        — our Twilio fax number (not PHI on its own)
//   Status    — "received" (terminal), "receiving" (in progress)
//   MediaUrl  — URL to the received fax image (Twilio basic-auth)
//   NumPages  — page count (safe to log)
//   Direction — always "inbound"
//
// PHI posture
// -----------
//   * `From` is stored on the row (CSRs need it to recognize the
//     sending office) but never reaches the application or audit
//     logger. Audit metadata carries only the FaxSid + counts.
//   * MediaUrl bytes may contain PHI. They land in GCS under the
//     same private ACL as patient_documents and are fetched only
//     through the admin-gated /admin/inbound-faxes/:id/media
//     signed-URL endpoint.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { requireTwilioSignature } from "@workspace/resupply-telecom";

import { ingestInboundFax } from "../../lib/fax/ingest-inbound.js";
import { logger } from "../../lib/logger.js";

const router: IRouter = Router();

const signatureMiddleware = requireTwilioSignature({
  getAuthToken: () => process.env.TWILIO_AUTH_TOKEN,
  buildPublicUrl: (req) => {
    const base = (
      process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
      (process.env.REPLIT_DEV_DOMAIN
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : "")
    ).replace(/\/+$/u, "");
    const originalUrl =
      (req as unknown as { originalUrl?: string }).originalUrl ?? "";
    return `${base}${originalUrl}`;
  },
});

const inboundFaxSchema = z.object({
  FaxSid: z.string().min(1),
  // From included server-side for persistence; never returned to a
  // log line because it's PHI when tied to a physician office.
  From: z.string().optional(),
  To: z.string().optional(),
  Status: z.string().optional(),
  NumPages: z.coerce.number().int().nonnegative().optional(),
  Direction: z.string().optional(),
  MediaUrl: z.string().optional(),
});

router.post("/fax/inbound", signatureMiddleware, async (req, res) => {
  // ACK immediately — Twilio retries on 5xx. We MUST 200 within ~15s,
  // and the media download below can take several seconds for a
  // multi-page fax.
  res.status(200).type("text/xml").send("<Response/>");

  const body = (req.body ?? {}) as Record<string, string>;
  const parsed = inboundFaxSchema.safeParse(body);
  if (!parsed.success) {
    logger.warn(
      { event: "fax_inbound_malformed" },
      "fax/inbound: missing required fields",
    );
    return;
  }

  // Only the terminal "received" callback persists. The mid-transfer
  // "receiving" callback fires once per page on multi-page faxes and
  // would otherwise insert N rows for the same fax.
  const { FaxSid, From, To, Status, NumPages, Direction, MediaUrl } =
    parsed.data;
  if (Status !== "received") return;

  const outcome = await ingestInboundFax(
    {
      twilioFaxSid: FaxSid,
      fromE164: From ?? null,
      toE164: To ?? null,
      numPages: NumPages ?? null,
      receivedAt: new Date().toISOString(),
      mediaUrl: MediaUrl ?? null,
      twilioAccountSid: process.env.TWILIO_ACCOUNT_SID ?? null,
      twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? null,
    },
    logger,
  );

  await logAudit({
    action: "fax.inbound_received",
    targetTable: "inbound_faxes",
    targetId: outcome.kind === "inserted" || outcome.kind === "already_recorded"
      ? outcome.id
      : null,
    metadata: {
      twilio_fax_sid: FaxSid,
      num_pages: NumPages ?? null,
      direction: Direction ?? "inbound",
      outcome: outcome.kind,
      // media_persisted captures whether the PDF made it to GCS so
      // a CSR investigating "where's the fax" can tell at a glance
      // whether the media URL is still live in Twilio's retention
      // window.
      media_persisted:
        outcome.kind === "inserted" ? outcome.mediaPersisted : null,
      // From withheld — PHI when tied to a physician office. The row
      // itself carries it under PHI ACL.
    },
  }).catch((err: unknown) => {
    logger.warn({ err }, "fax/inbound: audit write failed");
  });
});

export default router;
