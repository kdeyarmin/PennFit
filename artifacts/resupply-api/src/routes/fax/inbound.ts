// POST /fax/inbound — Twilio Programmable Fax inbound webhook.
//
// When a physician faxes back a signed/approved Rx or any other
// document to our Twilio fax number, Twilio POSTs this endpoint.
// We validate the signature, emit a non-PHI audit event so the CSR
// team can see an inbound fax arrived, and return empty TwiML to ACK.
//
// Twilio fax inbound fields (form-urlencoded):
//   FaxSid    — "FXxxxxxxxxxx…" unique ID for this inbound fax
//   From      — caller's fax number (PHI — never logged)
//   To        — our Twilio fax number (not PHI, safe to log)
//   Status    — "received" (terminal), "receiving" (in progress)
//   MediaUrl  — URL to the received fax image (requires Twilio auth)
//   NumPages  — page count (safe to log)
//   Direction — always "inbound"
//
// PHI posture:
//   * `From` is a fax number (PHI). Never reaches the audit log or
//     application logger.
//   * `MediaUrl` carries a Twilio-authenticated link to the fax
//     image; the image itself may contain PHI. We record only that
//     the fax arrived (count-level metadata). A future enhancement
//     can download + store via object storage with proper encryption.
//   * Audit envelope: fax_sid, num_pages, status, direction only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { requireTwilioSignature } from "@workspace/resupply-telecom";

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
  // From intentionally omitted — PHI
  Status: z.string().optional(),
  NumPages: z.coerce.number().int().nonnegative().optional(),
  Direction: z.string().optional(),
  MediaUrl: z.string().optional(),
});

router.post("/fax/inbound", signatureMiddleware, async (req, res) => {
  // ACK immediately — Twilio retries 5xx responses.
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

  // Only audit terminal "received" events; skip mid-transfer "receiving"
  // callbacks to avoid duplicate rows for a single fax.
  const { FaxSid, Status, NumPages, Direction } = parsed.data;
  if (Status !== "received") return;

  await logAudit({
    action: "physician_fax.inbound_received",
    targetTable: "physician_fax_outreach",
    metadata: {
      twilio_fax_sid: FaxSid,
      num_pages: NumPages ?? null,
      direction: Direction ?? "inbound",
      // MediaUrl withheld from audit — it is a Twilio-auth URL that,
      // if logged, would enable anyone with audit-log access to fetch
      // the fax image (which may contain PHI) without re-authenticating.
    },
  }).catch((err: unknown) => {
    logger.warn({ err }, "fax/inbound: audit write failed");
  });
});

export default router;
