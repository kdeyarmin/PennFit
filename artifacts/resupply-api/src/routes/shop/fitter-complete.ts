// POST /shop/fitter-complete — fired by the /results page when the
// patient sees a mask recommendation. Marks the existing
// resupply.fitter_leads row as "completed" and enrolls the patient in
// the multi-touch supply campaign.
//
// What it does:
//   * Looks up the most-recent fitter_leads row by email
//     (lowercased, just like the /shop/fitter-leads insert path).
//   * Stamps completed_at + recommended_mask_* + flips
//     journey_stage='campaign_active' + schedules the first
//     touchpoint 24h out via next_campaign_touch_at.
//   * No-ops if the lead has already converted, unsubscribed, or
//     finished the campaign — those are sticky terminal states.
//
// What it does NOT do:
//   * No email send here. The dispatcher worker is the only place
//     that sends; this route just flips the state machine.
//   * No PHI write. The recommended mask is a product reference
//     (catalog id / name / type), never the patient's measurements.
//   * No 5xx on DB failure. Mirrors /shop/fitter-leads — the patient
//     advances regardless; campaign enrollment is best-effort.
//
// GET /shop/fitter-leads/unsubscribe?t=<token> — one-click unsubscribe
// link rendered in every campaign email footer. HMAC-signed token
// carries the lead_id + an expiry. On verify the row's
// journey_stage flips to 'unsubscribed', terminal forever.

import { Router, type IRouter } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";

const router: IRouter = Router();

// Cadence of touchpoints, in milliseconds offset from `completed_at`.
// Day 1 → Day 60, six touches total. The dispatcher worker uses the
// same constant so this is the single source of truth.
export const TOUCHPOINT_OFFSETS_MS = [
  1 * 86_400_000, //   T1 — day 1: recap of recommendation
  3 * 86_400_000, //   T2 — day 3: social proof
  7 * 86_400_000, //   T3 — day 7: FSA/HSA reminder
  14 * 86_400_000, //  T4 — day 14: one-time discount
  30 * 86_400_000, //  T5 — day 30: educational
  60 * 86_400_000, //  T6 — day 60: final
] as const;

export const TOTAL_TOUCHPOINTS = TOUCHPOINT_OFFSETS_MS.length;

const MASK_TYPES = ["fullFace", "nasal", "nasalPillow", "hybrid"] as const;

// Email + recommended mask. Measurements are intentionally NOT in
// the body (HIPAA minimization — they never leave the browser); the
// catalog reference is enough to personalize the campaign copy.
const completeBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(200),
    recommendedMaskId: z.string().trim().min(1).max(100),
    recommendedMaskName: z.string().trim().min(1).max(200),
    recommendedMaskType: z.enum([...MASK_TYPES] as [
      (typeof MASK_TYPES)[number],
      ...(typeof MASK_TYPES)[number][],
    ]),
  })
  .strict();

router.post("/shop/fitter-complete", async (req, res) => {
  const parse = completeBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({
      error: "invalid_body",
      issues: parse.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const data = parse.data;

  try {
    const supabase = getSupabaseServiceRoleClient();

    // Find the most-recent lead row for this email. We don't error
    // if there's no row (the patient may have submitted /consent
    // before this column existed, or via a different device) — we
    // just no-op and return 200 so the patient flow keeps moving.
    const { data: rows, error: lookupErr } = await supabase
      .schema("resupply")
      .from("fitter_leads")
      .select("id, journey_stage, marketing_opt_in, completed_at")
      .eq("email", data.email)
      .order("created_at", { ascending: false })
      .limit(1);
    if (lookupErr) throw lookupErr;

    const lead = rows?.[0];
    if (!lead) {
      req.log?.info?.(
        { event: "fitter_complete_no_lead" },
        "shop/fitter-complete: no matching lead",
      );
      res.json({ ok: true, enrolled: false, reason: "no_lead" });
      return;
    }

    // Sticky terminal states — never re-enroll a lead that already
    // converted, unsubscribed, or expired. Idempotent on re-fires
    // (e.g. patient refreshes /results); the second call sees
    // journey_stage='campaign_active' and short-circuits.
    if (
      lead.journey_stage === "converted" ||
      lead.journey_stage === "unsubscribed" ||
      lead.journey_stage === "expired" ||
      lead.journey_stage === "campaign_active"
    ) {
      req.log?.info?.(
        { event: "fitter_complete_skip", stage: lead.journey_stage },
        "shop/fitter-complete: lead already in terminal/active state",
      );
      res.json({
        ok: true,
        enrolled: false,
        reason: lead.journey_stage,
      });
      return;
    }

    // Only enroll opted-in leads into the supply campaign. A lead
    // without marketing_opt_in still gets the recommendation in the
    // browser, but we don't email them.
    if (!lead.marketing_opt_in) {
      // Still stamp completed_at so admin reporting knows the
      // patient finished the fitter, but don't schedule a touch.
      await supabase
        .schema("resupply")
        .from("fitter_leads")
        .update({
          completed_at: new Date().toISOString(),
          recommended_mask_id: data.recommendedMaskId,
          recommended_mask_name: data.recommendedMaskName,
          recommended_mask_type: data.recommendedMaskType,
          journey_stage: "completed",
        })
        .eq("id", lead.id);
      res.json({ ok: true, enrolled: false, reason: "no_marketing_opt_in" });
      return;
    }

    const nowIso = new Date().toISOString();
    const firstTouchAt = new Date(
      Date.now() + TOUCHPOINT_OFFSETS_MS[0],
    ).toISOString();

    const { error: updateErr } = await supabase
      .schema("resupply")
      .from("fitter_leads")
      .update({
        completed_at: nowIso,
        recommended_mask_id: data.recommendedMaskId,
        recommended_mask_name: data.recommendedMaskName,
        recommended_mask_type: data.recommendedMaskType,
        journey_stage: "campaign_active",
        next_campaign_touch_at: firstTouchAt,
      })
      .eq("id", lead.id);
    if (updateErr) throw updateErr;

    req.log?.info?.(
      { event: "fitter_complete_enrolled", leadId: lead.id },
      "shop/fitter-complete: lead enrolled in supply campaign",
    );
    res.json({ ok: true, enrolled: true });
  } catch (err) {
    // Best-effort — never 5xx the /results page.
    logger.warn(
      { err },
      "shop/fitter-complete: enrollment failed (continuing best-effort)",
    );
    res.json({ ok: true, enrolled: false, reason: "error" });
  }
});

// -----------------------------------------------------------------
// Unsubscribe link — one-click GET so it works inline in every
// email client without JS or a POST round-trip.
// -----------------------------------------------------------------
//
// Token format: <base64url(lead_id|expiry_seconds)>.<base64url(sig)>
//   * sig = HMAC-SHA256(payload-bytes, RESUPPLY_LINK_HMAC_KEY)
//   * Distinct from the conversation-token format (which uses a
//     JSON payload) so a confused-deputy can't cross-claim.
//
// Why not reuse signLinkToken from @workspace/resupply-messaging?
//   That helper hard-codes conversationId as the bound principal +
//   has only "confirm/edit/stop" actions. A fitter-lead unsubscribe
//   binds a different principal (lead_id) and is a different action
//   class. Cleaner to keep the two scopes separate than to bend the
//   existing API into doing both.

const UNSUBSCRIBE_TTL_MS = 180 * 86_400_000; // 6 months

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64urlDecode(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(s)) return null;
  const pad = (4 - (s.length % 4)) % 4;
  const standard = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  try {
    return Buffer.from(standard, "base64");
  } catch {
    return null;
  }
}

function getLinkHmacKey(): Buffer {
  const raw = process.env.RESUPPLY_LINK_HMAC_KEY;
  if (!raw) {
    throw new Error("RESUPPLY_LINK_HMAC_KEY is not set");
  }
  return Buffer.from(raw, "utf8");
}

/** Build an unsubscribe token bound to a lead_id. Exported so the
 *  dispatcher worker can mint one per outbound email. */
export function signUnsubscribeToken(leadId: string, now: Date = new Date()): string {
  const expiresSec = Math.floor((now.getTime() + UNSUBSCRIBE_TTL_MS) / 1000);
  const payload = `${leadId}|${expiresSec}`;
  const payloadEncoded = base64urlEncode(Buffer.from(payload, "utf8"));
  const sig = createHmac("sha256", getLinkHmacKey())
    .update(payloadEncoded, "utf8")
    .digest();
  return `${payloadEncoded}.${base64urlEncode(sig)}`;
}

type UnsubscribeVerifyResult =
  | { valid: true; leadId: string }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" };

function verifyUnsubscribeToken(
  token: string,
  now: Date = new Date(),
): UnsubscribeVerifyResult {
  const idx = token.indexOf(".");
  if (idx <= 0 || idx === token.length - 1) {
    return { valid: false, reason: "malformed" };
  }
  const payloadEncoded = token.slice(0, idx);
  const sigEncoded = token.slice(idx + 1);

  const sigBuf = base64urlDecode(sigEncoded);
  if (!sigBuf) return { valid: false, reason: "malformed" };

  const expected = createHmac("sha256", getLinkHmacKey())
    .update(payloadEncoded, "utf8")
    .digest();
  if (sigBuf.length !== expected.length) {
    return { valid: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(sigBuf, expected)) {
    return { valid: false, reason: "bad_signature" };
  }

  const payloadBuf = base64urlDecode(payloadEncoded);
  if (!payloadBuf) return { valid: false, reason: "malformed" };
  const payload = payloadBuf.toString("utf8");
  const sepIdx = payload.indexOf("|");
  if (sepIdx <= 0) return { valid: false, reason: "malformed" };
  const leadId = payload.slice(0, sepIdx);
  const expiresSec = Number.parseInt(payload.slice(sepIdx + 1), 10);
  if (!Number.isFinite(expiresSec)) return { valid: false, reason: "malformed" };
  if (expiresSec * 1000 <= now.getTime()) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, leadId };
}

router.get("/shop/fitter-leads/unsubscribe", async (req, res) => {
  const token = typeof req.query.t === "string" ? req.query.t : "";
  if (!token) {
    res.status(400).type("text/html").send(unsubscribeHtml("invalid"));
    return;
  }

  let verify: UnsubscribeVerifyResult;
  try {
    verify = verifyUnsubscribeToken(token);
  } catch (err) {
    // RESUPPLY_LINK_HMAC_KEY missing → service misconfig. Return a
    // friendly page rather than the raw error.
    logger.warn(
      { err },
      "shop/fitter-leads/unsubscribe: verify threw",
    );
    res.status(500).type("text/html").send(unsubscribeHtml("error"));
    return;
  }
  if (!verify.valid) {
    res.status(400).type("text/html").send(unsubscribeHtml("invalid"));
    return;
  }

  try {
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("fitter_leads")
      .update({
        journey_stage: "unsubscribed",
        unsubscribed_at: new Date().toISOString(),
        next_campaign_touch_at: null,
      })
      .eq("id", verify.leadId);
    if (error) throw error;
    res.type("text/html").send(unsubscribeHtml("ok"));
  } catch (err) {
    logger.warn(
      { err, leadId: verify.leadId },
      "shop/fitter-leads/unsubscribe: db update failed",
    );
    res.status(500).type("text/html").send(unsubscribeHtml("error"));
  }
});

function unsubscribeHtml(state: "ok" | "invalid" | "error"): string {
  const headline =
    state === "ok"
      ? "You're unsubscribed."
      : state === "invalid"
        ? "Link no longer valid."
        : "Something went wrong.";
  const body =
    state === "ok"
      ? "We won't send you any more fitting follow-ups. You can still place an order at any time."
      : state === "invalid"
        ? "This unsubscribe link has expired or was already used. If you keep getting emails, reply to one and we'll handle it directly."
        : "We couldn't complete your unsubscribe. Please reply to the email you received and we'll take care of it.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${headline}</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;line-height:1.5;color:#222;}h1{font-size:20px;}</style>
</head><body><h1>${headline}</h1><p>${body}</p></body></html>`;
}

export default router;
