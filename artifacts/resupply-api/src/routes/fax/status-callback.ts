// POST /fax/status-callback — Twilio Programmable Fax delivery webhook.
//
// Twilio POSTs lifecycle transitions for outbound faxes:
//   queued → processing → sending → delivered   (happy path)
//                                  ↘ no-answer | busy | failed | canceled
//
// Mapping to our DB status column:
//   queued / processing / sending  → "sent"     (in transit)
//   delivered                      → "delivered"
//   no-answer / busy / failed /
//     canceled                     → "failed"
//
// Design choices mirror voice/status-callback.ts:
//   * 200 every signed request immediately — Twilio retries 5xx with
//     backoff; we want the lifecycle stream to flow even if the DB
//     is briefly unhappy.
//   * Twilio signature validated via requireTwilioSignature.
//   * Audit emits ONLY structural metadata — no fax number, no physician
//     name, no page count beyond "did it arrive?".

import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getDbPool, physicianFaxOutreach } from "@workspace/resupply-db";
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

type DbFaxStatus = "sent" | "delivered" | "failed";

// Twilio's outbound-fax callback payload is form-encoded. Validating
// it through Zod (rather than ad-hoc `as Record<string, string>`
// casts) gives us:
//   * a single source of truth for which fields the route actually
//     consumes — anything else Twilio sends is ignored on purpose.
//   * a guarantee at the route boundary that FaxSid / Status are
//     non-empty strings, so the downstream WHERE clause cannot be
//     fed a blank vendor_ref by a malformed payload.
//   * an automatic 200-and-skip when the payload doesn't match (the
//     same posture the route takes for unknown statuses) so Twilio
//     does not retry a request our DB code couldn't have used.
//
// Allow-listing only the eight Twilio statuses we actually map keeps
// noise out of audit logs: any future Twilio status that we haven't
// taught the mapper about gets logged once at warn level and dropped.
const TWILIO_STATUSES = [
  "queued",
  "processing",
  "sending",
  "delivered",
  "no-answer",
  "busy",
  "failed",
  "canceled",
] as const;

const faxStatusCallbackBody = z
  .object({
    FaxSid: z.string().trim().min(1).max(64),
    Status: z.enum(TWILIO_STATUSES),
    ErrorCode: z.string().trim().min(1).max(32).optional(),
  })
  .passthrough();

function mapTwilioStatus(
  twilioStatus: (typeof TWILIO_STATUSES)[number],
): DbFaxStatus {
  switch (twilioStatus) {
    case "queued":
    case "processing":
    case "sending":
      return "sent";
    case "delivered":
      return "delivered";
    case "no-answer":
    case "busy":
    case "failed":
    case "canceled":
      return "failed";
  }
}

router.post("/fax/status-callback", signatureMiddleware, async (req, res) => {
  // Respond 200 immediately — Twilio retries on 5xx.
  res.status(200).type("text/xml").send("<Response/>");

  const parsed = faxStatusCallbackBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    // Signature was already validated; a malformed body still 200s
    // (otherwise Twilio retries forever) but we log so a real
    // schema drift surfaces in ops dashboards.
    logger.warn(
      {
        event: "fax_status_body_invalid",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
      "fax status-callback: body did not match expected shape",
    );
    return;
  }
  const { FaxSid: faxSid, Status: twilioStatus, ErrorCode: errorCode } =
    parsed.data;
  const dbStatus = mapTwilioStatus(twilioStatus);

  const db = drizzle(getDbPool());
  const now = new Date();

  const updates: {
    status: DbFaxStatus;
    updatedAt: Date;
    deliveredAt?: Date;
    failedAt?: Date;
    failureReason?: string;
  } = { status: dbStatus, updatedAt: now };

  if (dbStatus === "delivered") {
    updates.deliveredAt = now;
  } else if (dbStatus === "failed") {
    updates.failedAt = now;
    if (errorCode) updates.failureReason = `Twilio error ${errorCode}`;
  }

  try {
    await db
      .update(physicianFaxOutreach)
      .set(updates)
      .where(
        and(
          eq(physicianFaxOutreach.vendorRef, faxSid),
          eq(physicianFaxOutreach.vendorName, "twilio"),
        ),
      );
  } catch (err) {
    logger.warn(
      { event: "fax_status_db_failed", faxSid, err },
      "fax status-callback: DB update failed",
    );
  }

  try {
    await logAudit({
      action: "physician_fax_outreach.status_updated",
      targetTable: "physician_fax_outreach",
      metadata: {
        twilio_fax_sid: faxSid,
        twilio_status: twilioStatus,
        db_status: dbStatus,
      },
    });
  } catch (err) {
    logger.warn(
      { event: "fax_status_audit_failed", faxSid, err },
      "fax status-callback: audit failed",
    );
  }
});

export default router;
